// Remote MCP server over Streamable HTTP at /mcp. Stateless and dual-era:
//  - modern clients (2026-07-28): per-request `_meta` version, `server/discover`, header validation;
//  - legacy clients (2025-11-25 and earlier): `initialize` handshake, `ping`, notifications.
// Auth: "Authorization: Bearer <Code Search API key>" on every request.

import {
  authenticate,
  enforceRateLimit,
  searchFor,
  readmeFor,
  noteKeyUse,
  formatSearchText,
  formatReadmeText,
  ServiceError,
} from "./service.js";
import { recordCall, outcomeOf } from "./usage.js";
import { GitHubError } from "./search.js";
import { QueryError, DEFAULT_MIN_STARS, MIN_STARS_FLOOR, MAX_PER_PAGE } from "../public/lib/query.js";
import { DEFAULT_README_CHARS, MAX_README_CHARS } from "./readme.js";

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "code-search", title: "Code Search", version: "2.0.0" };
const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  serverInfo: "io.modelcontextprotocol/serverInfo",
};
const MCP_DEFAULT_PER_PAGE = 10;

const INSTRUCTIONS =
  "Code Search searches public GitHub repositories. Describe the project you need in plain words " +
  "(e.g. 'self-hosted kanban board with markdown support'); results skip low-star projects and the best matches come first, then the most-starred. " +
  "Use search_repositories first, then get_repository_readme on the most promising results before recommending one.";

export const TOOLS = [
  {
    name: "search_repositories",
    title: "Search GitHub repositories",
    description:
      "Find public GitHub repositories that match a plain-English description of what is needed. Filler words are " +
      "dropped, phrases about the user ('for my business', 'for free') are treated as context, key terms or close " +
      "synonyms must match, projects under min_stars are skipped, and results are ranked by how well their name, " +
      "topics and description match, then by stars. GitHub qualifiers such as license:mit, topic:cli, user:NAME or pushed:>2025-01-01 can be included in query. " +
      "Returns name, URL, stars, language, license, topics, description and last push date for each repository.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What the project should do, in plain words. Up to 500 characters.",
          minLength: 1,
          maxLength: 500,
        },
        language: { type: "string", description: "Primary language filter, e.g. 'Python', 'TypeScript', 'Rust'." },
        min_stars: {
          type: "integer",
          minimum: MIN_STARS_FLOOR,
          default: DEFAULT_MIN_STARS,
          description: `Skip repositories with fewer stars. Default ${DEFAULT_MIN_STARS}, minimum ${MIN_STARS_FLOOR}.`,
        },
        include_archived: { type: "boolean", default: false, description: "Include archived repositories." },
        page: { type: "integer", minimum: 1, default: 1, description: "Result page, starting at 1." },
        per_page: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PER_PAGE,
          default: MCP_DEFAULT_PER_PAGE,
          description: `Results per page (1-${MAX_PER_PAGE}). Default ${MCP_DEFAULT_PER_PAGE}.`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { title: "Search GitHub repositories", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "get_repository_readme",
    title: "Read a repository's README",
    description:
      "Return the README of a public GitHub repository as plain text (Markdown), truncated to max_chars. " +
      "Use it to check whether a search result really fits before recommending it.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository as owner/name (e.g. 'sxyazi/yazi') or a github.com URL." },
        max_chars: {
          type: "integer",
          minimum: 200,
          maximum: MAX_README_CHARS,
          default: DEFAULT_README_CHARS,
          description: `Maximum characters to return. Default ${DEFAULT_README_CHARS}, at most ${MAX_README_CHARS}.`,
        },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { title: "Read a repository's README", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

// ---------- HTTP entry ----------

export async function handleMcp(request, env, ctx, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) {
    return rpcHttp(403, rpcError(null, -32000, "Forbidden origin"));
  }
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  const text = await request.text();
  if (text.length > 64 * 1024) return rpcHttp(413, rpcError(null, -32600, "Request too large"));
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return rpcHttp(400, rpcError(null, -32700, "Parse error"));
  }
  if (Array.isArray(msg)) return rpcHttp(400, rpcError(null, -32600, "Batch requests are not supported"));
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    // A JSON-RPC response or garbage: clients must not send responses.
    return rpcHttp(400, rpcError(msg?.id ?? null, -32600, "Invalid Request"));
  }

  const isNotification = !("id" in msg);
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const modernVersion = params._meta?.[META.protocolVersion];

  // Authenticate everything except notifications (which carry no work).
  let caller = null;
  if (!isNotification) {
    try {
      caller = await authenticate(request, env, url, { allowCookie: false });
    } catch (err) {
      if (err instanceof ServiceError && err.status === 401) {
        return rpcHttp(401, rpcError(msg.id, -32001, err.message), {
          "WWW-Authenticate": `Bearer realm="code-search", error="invalid_token"`,
        });
      }
      throw err;
    }
  }

  if (modernVersion !== undefined) return handleModern(msg, params, modernVersion, request, caller, env, ctx, url);
  return handleLegacy(msg, params, isNotification, request, caller, env, ctx, url);
}

// ---------- Modern (2026-07-28) ----------

async function handleModern(msg, params, version, request, caller, env, ctx, url) {
  const id = "id" in msg ? msg.id : null;
  if (!MODERN_VERSIONS.includes(version)) {
    return rpcHttp(400, rpcError(id, -32022, "Unsupported protocol version", {
      supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
      requested: version,
    }));
  }
  const mismatch = checkHeaders(request, msg, version);
  if (mismatch) return rpcHttp(400, rpcError(id, -32020, mismatch));
  if (!("id" in msg)) return new Response(null, { status: 202 });

  const meta = { [META.serverInfo]: SERVER_INFO };
  switch (msg.method) {
    case "server/discover":
      return rpcHttp(200, rpcResult(id, {
        resultType: "complete",
        supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: "public",
        _meta: meta,
      }));
    case "tools/list":
      return rpcHttp(200, rpcResult(id, { resultType: "complete", tools: TOOLS, ttlMs: 3_600_000, cacheScope: "public", _meta: meta }));
    case "tools/call": {
      const out = await callTool(params, caller, env, ctx, url);
      if (out.protocolError) return rpcHttp(200, rpcError(id, out.protocolError.code, out.protocolError.message));
      return rpcHttp(200, rpcResult(id, { resultType: "complete", ...out.result, _meta: meta }));
    }
    default:
      return rpcHttp(404, rpcError(id, -32601, `Method not found: ${msg.method}`));
  }
}

function decodeHeader(v) {
  const m = /^=\?base64\?(.*)\?=$/.exec(v ?? "");
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function checkHeaders(request, msg, version) {
  const h = request.headers;
  const pv = h.get("MCP-Protocol-Version");
  if (!pv) return "Missing MCP-Protocol-Version header";
  if (pv !== version) return `Header mismatch: MCP-Protocol-Version '${pv}' does not match body '${version}'`;
  if (!("id" in msg)) return null; // header requirements for notifications are not defined
  const method = h.get("Mcp-Method");
  if (!method) return "Missing Mcp-Method header";
  if (method !== msg.method) return `Header mismatch: Mcp-Method '${method}' does not match body '${msg.method}'`;
  if (msg.method === "tools/call") {
    const raw = h.get("Mcp-Name");
    if (!raw) return "Missing Mcp-Name header";
    const name = decodeHeader(raw);
    if (name !== msg.params?.name) return `Header mismatch: Mcp-Name '${raw}' does not match body '${msg.params?.name}'`;
  }
  return null;
}

// ---------- Legacy (2025-11-25 and earlier) ----------

async function handleLegacy(msg, params, isNotification, request, caller, env, ctx, url) {
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  if (headerVersion && !LEGACY_VERSIONS.includes(headerVersion) && msg.method !== "initialize") {
    return rpcHttp(400, rpcError(isNotification ? null : msg.id, -32600, `Unsupported MCP-Protocol-Version: ${headerVersion}`));
  }
  if (isNotification) return new Response(null, { status: 202 }); // notifications/initialized, cancelled, ...

  const id = msg.id;
  switch (msg.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      return rpcHttp(200, rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }));
    }
    case "ping":
      return rpcHttp(200, rpcResult(id, {}));
    case "tools/list":
      return rpcHttp(200, rpcResult(id, { tools: TOOLS }));
    case "tools/call": {
      const out = await callTool(params, caller, env, ctx, url);
      if (out.protocolError) return rpcHttp(200, rpcError(id, out.protocolError.code, out.protocolError.message));
      return rpcHttp(200, rpcResult(id, out.result));
    }
    default:
      return rpcHttp(200, rpcError(id, -32601, `Method not found: ${msg.method}`));
  }
}

// ---------- Tools ----------

async function callTool(params, caller, env, ctx, url) {
  const name = params.name;
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { protocolError: { code: -32602, message: `Unknown tool: ${name}` } };

  const unknown = Object.keys(args).filter((k) => !(k in tool.inputSchema.properties));
  if (unknown.length) return toolError(`Unknown argument(s): ${unknown.join(", ")}. Allowed: ${Object.keys(tool.inputSchema.properties).join(", ")}.`);

  try {
    await enforceRateLimit(env, caller.user);
    if (name === "search_repositories") {
      if (typeof args.query !== "string" || !args.query.trim()) return toolError("query is required: describe the project you need.");
      const sp = new URLSearchParams();
      sp.set("q", args.query);
      if (args.language != null) sp.set("language", String(args.language));
      if (args.min_stars != null) sp.set("min_stars", String(args.min_stars));
      if (args.include_archived != null) sp.set("include_archived", String(args.include_archived === true));
      sp.set("page", String(args.page ?? 1));
      sp.set("per_page", String(args.per_page ?? MCP_DEFAULT_PER_PAGE));
      const r = await searchFor(caller.user, sp, { env, ctx, origin: url.origin });
      noteKeyUse(env, ctx, caller.apiKey);
      recordCall(env, ctx, caller, "mcp_search", "ok", r.cached === true);
      return { result: { content: [{ type: "text", text: formatSearchText(r) }], structuredContent: r, isError: false } };
    }
    // get_repository_readme
    const r = await readmeFor(caller.user, args.repo, args.max_chars, { env });
    noteKeyUse(env, ctx, caller.apiKey);
    recordCall(env, ctx, caller, "mcp_readme", "ok", r.cached === true);
    return { result: { content: [{ type: "text", text: formatReadmeText(r) }], structuredContent: r, isError: false } };
  } catch (err) {
    recordCall(env, ctx, caller, name === "search_repositories" ? "mcp_search" : "mcp_readme", outcomeOf(err));
    if (err instanceof ServiceError || err instanceof GitHubError) {
      const retry = err.extra?.retryAfter ? ` Retry after ${err.extra.retryAfter} seconds.` : "";
      return toolError(`${err.message}${retry && !err.message.includes("seconds") ? retry : ""}`);
    }
    if (err instanceof QueryError) return toolError(err.message);
    throw err;
  }
}

function toolError(text) {
  return { result: { content: [{ type: "text", text }], isError: true } };
}

// ---------- JSON-RPC helpers ----------

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function rpcHttp(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
