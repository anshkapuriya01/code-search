// End-to-end test: runs the real Worker locally (wrangler dev + local D1) against a mock of
// GitHub's OAuth endpoints. Search requests are forwarded to the REAL GitHub API (unauthenticated),
// so results are real. Uses ~4 real GitHub searches (unauthenticated limit: 10/minute).
//
// Usage: npm run test:e2e

import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const MOCK_PORT = 9871;
const APP_PORT = 8788;
const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const ENC_KEY = Buffer.alloc(32, 3).toString("base64");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

// ---------- Mock GitHub ----------

const mock = { searchCalls: 0, upstreamCalls: 0, revokedGrants: [], upstreamCache: new Map() };
const USERS = {
  "mock-token": { id: 1001, login: "mockuser", name: "Mock User", avatar_url: "https://avatars.githubusercontent.com/u/1" },
  "revoked-token": { id: 1002, login: "revokeduser", name: null, avatar_url: null },
  "admin-token": { id: 2001, login: "theadmin", name: "The Admin", avatar_url: null },
  "newcomer-token": { id: 3001, login: "newcomer", name: "New Comer", avatar_url: null },
};
const CODES = { good: "mock-token", revoked: "revoked-token", admin: "admin-token", newcomer: "newcomer-token" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, MOCK);
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const body = await new Promise((r) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => r(d));
  });
  const auth = req.headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (req.method === "GET" && url.pathname === "/login/oauth/authorize") {
    // Simulates the user approving the app on GitHub (used for manual browser testing).
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "good");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: back.toString() }).end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
    const b = JSON.parse(body || "{}");
    if (b.client_id !== CLIENT_ID || b.client_secret !== CLIENT_SECRET) return send(200, { error: "incorrect_client_credentials" });
    if (b.redirect_uri !== `${APP}/auth/callback`) return send(200, { error: "redirect_uri_mismatch" });
    const token = CODES[b.code];
    return token ? send(200, { access_token: token, token_type: "bearer", scope: "" }) : send(200, { error: "bad_verification_code" });
  }

  if (req.method === "GET" && url.pathname === "/user") {
    return USERS[bearer] ? send(200, USERS[bearer]) : send(401, { message: "Bad credentials" });
  }

  if (req.method === "DELETE" && url.pathname === `/applications/${CLIENT_ID}/grant`) {
    if (auth !== `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`) return send(401, {});
    mock.revokedGrants.push(JSON.parse(body).access_token);
    res.writeHead(204).end();
    return;
  }

  const readmeMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/readme$/);
  if (req.method === "GET" && readmeMatch) {
    if (bearer !== "mock-token") return send(401, { message: "Bad credentials" });
    mock.readmeCalls = (mock.readmeCalls ?? 0) + 1;
    const r = await fetch(`https://api.github.com/repos/${readmeMatch[1]}/${readmeMatch[2]}/readme`, {
      headers: { Accept: "application/vnd.github.raw+json", "User-Agent": "code-search-e2e" },
    });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "text/plain" });
    res.end(await r.text());
    return;
  }

  if (req.method === "GET" && url.pathname === "/search/repositories") {
    mock.searchCalls++;
    if (bearer === "revoked-token") return send(401, { message: "Bad credentials" });
    if (bearer !== "mock-token") return send(500, { message: `mock: unexpected token ${bearer}` });
    if (url.searchParams.get("q").includes("ratelimitme")) {
      return send(403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 42),
      });
    }
    // Forward to the real GitHub API without credentials.
    const upstream = `https://api.github.com/search/repositories?${url.searchParams}`;
    let cached = mock.upstreamCache.get(upstream);
    if (!cached) {
      mock.upstreamCalls++;
      const r = await fetch(upstream, { headers: { Accept: "application/vnd.github+json", "User-Agent": "code-search-e2e" } });
      cached = { status: r.status, text: await r.text(), remaining: r.headers.get("x-ratelimit-remaining") };
      if (r.ok) mock.upstreamCache.set(upstream, cached);
      else console.error("Real GitHub returned", r.status, cached.text.slice(0, 200));
    }
    res.writeHead(cached.status, { "content-type": "application/json", "x-ratelimit-remaining": cached.remaining ?? "" });
    res.end(cached.text);
    return;
  }
  send(404, { message: "mock: not found" });
});

// ---------- Helpers ----------

class Client {
  constructor() {
    this.cookies = new Map();
  }
  async req(pathname, { method = "GET", headers = {}, body, origin = false } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (origin) h.Origin = APP;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const res = await fetch(APP + pathname, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, json, text };
  }
  async login(code) {
    const start = await this.req("/auth/login");
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get("location"));
    return this.req(`/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get("state"))}`);
  }
}

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.log(`  ✖ ${name}`);
    throw err;
  }
}

function checkRanking(data, minStars) {
  const stars = data.items.map((i) => i.stars);
  assert.ok(stars.length > 0, "expected results");
  assert.equal(new Set(data.items.map((i) => i.name)).size, stars.length, "no duplicate results");
  assert.ok(stars.every((s) => s >= minStars), `every result must have >= ${minStars} stars`);
}

function printTop(label, data) {
  console.log(`      ${label} → matchLevel=${data.matchLevel}, total=${data.total}, keyTerms=${JSON.stringify(data.query.keyTerms)}`);
  for (const r of data.items.slice(0, 5)) {
    console.log(`        ★${String(r.stars).padStart(7)}  ${r.name} — ${(r.description ?? "").slice(0, 70)}`);
  }
}

// Runs one search through real Workers AI (a few neurons). Separate from the main run, which keeps AI off so
// its results are repeatable and it stays within GitHub's anonymous search limit.
async function realAiCheck(client) {
  console.log("Real Workers AI");
  // The first call through wrangler's connection to Cloudflare can take far longer than a deployed Worker's.
  for (let i = 0; i < 3; i++) await client.req(`/api/search?q=ratelimitme+warm+up+${i}`);
  await step("real Workers AI understands a request and the search returns results", async () => {
    const r = await client.req("/v1/search?q=" + encodeURIComponent("project management software for small teams") + "&per_page=5");
    assert.equal(r.status, 200, r.text);
    console.log("      AI:", JSON.stringify({ by: r.json.query.interpretedBy, status: r.json.query.aiStatus, keyTerms: r.json.query.keyTerms, descriptive: r.json.query.descriptiveWords, synonyms: r.json.query.synonyms, context: r.json.query.context }));
    assert.equal(r.json.query.interpretedBy, "ai");
    assert.ok(r.json.items.length > 0);
    printTop("project management software for small teams", r.json);
  });
  await step("the neurons it used are counted", async () => {
    await new Promise((r) => setTimeout(r, 800));
    const admin = new Client();
    await admin.login("admin");
    const { ai } = (await admin.req("/api/admin/summary")).json;
    console.log("      usage today:", JSON.stringify(ai));
    assert.ok(ai.neurons > 0 && ai.calls > 0);
    assert.equal(ai.enabled, true);
  });
}

// ---------- Run ----------

const persist = mkdtempSync(path.join(tmpdir(), "code-search-e2e-"));
let dev;

async function main() {
  await new Promise((r) => server.listen(MOCK_PORT, "127.0.0.1", r));

  const wrangler = path.join(ROOT, "node_modules/.bin/wrangler");
  execFileSync(wrangler, ["d1", "migrations", "apply", "starscout", "--local", "--persist-to", persist], {
    cwd: ROOT,
    env: { ...process.env, CI: "1" },
    stdio: "pipe",
  });

  const vars = {
    GITHUB_CLIENT_ID: CLIENT_ID,
    GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    TOKEN_ENCRYPTION_KEY: ENC_KEY,
    GITHUB_OAUTH_BASE: MOCK,
    GITHUB_API_BASE: MOCK,
    ADMIN_GITHUB_IDS: "2001",
    AI_DAILY_NEURONS: process.env.E2E_REAL_AI ? "9000" : "0", // 0 keeps normal test runs from spending neurons
  };
  dev = spawn(
    wrangler,
    ["dev", "--port", String(APP_PORT), "--ip", "127.0.0.1", "--local-upstream", `127.0.0.1:${APP_PORT}`, "--persist-to", persist, "--show-interactive-dev-session=false",
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
    { cwd: ROOT, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let devLog = "";
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));

  for (let i = 0; ; i++) {
    try {
      if ((await fetch(APP + "/")).ok) break;
    } catch {}
    if (i > 60) throw new Error("wrangler dev did not start:\n" + devLog);
    await new Promise((r) => setTimeout(r, 500));
  }

  const anon = new Client();
  const alice = new Client();
  let apiKey;
  let keyId;

  console.log("Static site");
  await step("serves the app with security headers", async () => {
    const r = await anon.req("/");
    assert.equal(r.status, 200);
    assert.match(r.text, /<title>Code Search/);
    assert.ok(!/StarScout/.test(r.text), "old name must be gone");
    assert.match(r.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    for (const path of ["/app/", "/docs/", "/css/site.css", "/js/landing.js", "/js/app.js", "/lib/query.js", "/img/marks.svg", "/data/demo.json", "/llms.txt"]) {
      assert.equal((await anon.req(path)).status, 200, path);
    }
    const spec = await anon.req("/openapi.json");
    assert.equal(spec.status, 200);
    assert.equal(spec.json.openapi, "3.1.0");
  });

  console.log("Auth required");
  await step("/api/me and /api/search reject anonymous requests", async () => {
    assert.equal((await anon.req("/api/me")).status, 401);
    const s = await anon.req("/api/search?q=react");
    assert.equal(s.status, 401);
    assert.equal(s.json.code, "signin_required");
    assert.equal(s.headers.get("access-control-allow-origin"), "*");
  });

  console.log("GitHub OAuth");
  await step("a browser click on /auth/login (navigation) reaches the Worker, not the 404 page", async () => {
    for (const path of ["/auth/login", "/mcp", "/v1/search?q=x"]) {
      const r = await fetch(APP + path, {
        redirect: "manual",
        headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", Accept: "text/html" },
      });
      assert.notEqual(r.status, 404, `${path} answered 404 to a browser navigation`);
    }
  });
  await step("/auth/login redirects to GitHub with client id, callback and state", async () => {
    const r = await anon.req("/auth/login");
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, `${MOCK}/login/oauth/authorize`);
    assert.equal(loc.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(loc.searchParams.get("redirect_uri"), `${APP}/auth/callback`);
    assert.equal(loc.searchParams.get("scope"), null, "no extra permissions requested");
    assert.ok(loc.searchParams.get("state").length >= 32);
    assert.equal(anon.cookies.get("cs_oauth_state"), loc.searchParams.get("state"));
  });
  await step("callback rejects a wrong or missing state", async () => {
    const r = await anon.req("/auth/callback?code=good&state=forged");
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/app/?error=state");
    assert.ok(!anon.cookies.has("cs_session"));
    const fresh = new Client();
    const r2 = await fresh.req("/auth/callback?code=good&state=anything");
    assert.equal(r2.headers.get("location"), "/app/?error=state");
  });
  await step("callback handles a denied login and a bad code", async () => {
    const r = await anon.req("/auth/callback?error=access_denied&state=x");
    assert.equal(r.headers.get("location"), "/app/?error=denied");
    const bad = new Client();
    const r2 = await bad.login("wrong-code");
    assert.equal(r2.headers.get("location"), "/app/?error=github");
    assert.ok(!bad.cookies.has("cs_session"));
  });
  await step("successful login creates a session and signs the user in", async () => {
    const r = await alice.login("good");
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/app/#search");
    const setCookie = r.headers.getSetCookie().find((c) => c.startsWith("cs_session="));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const me = await alice.req("/api/me");
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.user, { login: "mockuser", name: "Mock User", avatarUrl: "https://avatars.githubusercontent.com/u/1" });
    assert.equal(me.json.isAdmin, false);
  });
  if (process.env.E2E_REAL_AI) {
    await realAiCheck(alice);
    return;
  }
  await step("GitHub token is stored encrypted, session token only as a hash", async () => {
    const out = execFileSync(wrangler, ["d1", "execute", "starscout", "--local", "--persist-to", persist, "--json",
      "--command", "SELECT u.token_enc, s.id_hash FROM users u JOIN sessions s ON s.user_id = u.id WHERE u.id = 1001"], { cwd: ROOT, env: { ...process.env, CI: "1" } });
    const row = JSON.parse(out)[0].results[0];
    assert.ok(row.token_enc.startsWith("v1."));
    assert.ok(!row.token_enc.includes("mock-token"));
    assert.match(row.id_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.id_hash, alice.cookies.get("cs_session"));
  });

  console.log("API keys");
  await step("creating a key requires a same-origin request", async () => {
    const r = await alice.req("/api/keys", { method: "POST", body: { name: "x" } });
    assert.equal(r.status, 403);
    const r2 = await alice.req("/api/keys", { method: "POST", body: { name: "x" }, headers: { Origin: "https://evil.example" } });
    assert.equal(r2.status, 403);
  });
  await step("validates key names", async () => {
    assert.equal((await alice.req("/api/keys", { method: "POST", body: { name: "  " }, origin: true })).status, 400);
    assert.equal((await alice.req("/api/keys", { method: "POST", body: { name: "a".repeat(51) }, origin: true })).status, 400);
    assert.equal((await alice.req("/api/keys", { method: "POST", origin: true })).status, 400);
  });
  await step("creates a key, shows it once, lists it without the secret", async () => {
    const r = await alice.req("/api/keys", { method: "POST", body: { name: "my script" }, origin: true });
    assert.equal(r.status, 201);
    assert.match(r.json.key, /^codesearch_[A-Za-z0-9_-]{43}$/);
    apiKey = r.json.key;
    keyId = r.json.id;
    const list = await alice.req("/api/keys");
    assert.equal(list.json.keys.length, 1);
    const k = list.json.keys[0];
    assert.deepEqual(Object.keys(k).sort(), ["createdAt", "id", "lastUsedAt", "name", "prefix"]);
    assert.equal(k.name, "my script");
    assert.ok(apiKey.startsWith(k.prefix));
    assert.ok(!JSON.stringify(list.json).includes(apiKey));
  });
  await step("anonymous users can't list keys; bad keys are rejected", async () => {
    assert.equal((await anon.req("/api/keys")).status, 401);
    const bad = await anon.req("/api/search?q=react", { headers: { Authorization: "Bearer codesearch_" + "x".repeat(43) } });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.code, "invalid_api_key");
    const garbage = await anon.req("/api/search?q=react", { headers: { Authorization: "Basic abc" } });
    assert.equal(garbage.status, 401);
  });
  await step("an invalid API key does not fall back to the session cookie", async () => {
    const r = await alice.req("/api/search?q=react", { headers: { Authorization: "Bearer nope" } });
    assert.equal(r.status, 401);
  });

  console.log("Search (real GitHub results)");
  await step("API key search: plain-English requirement, low-star projects removed, best matches first", async () => {
    const q = encodeURIComponent("self-hosted kanban board with markdown support");
    const r = await anon.req(`/api/search?q=${q}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.query.keywords, ["self-hosted", "kanban", "board", "markdown"]);
    assert.equal(r.json.query.minStars, 100);
    checkRanking(r.json, 100);
    assert.ok(r.json.items.every((i) => !i.archived), "archived projects are excluded by default");
    printTop("self-hosted kanban board with markdown support", r.json);
  });
  await step("session search with language + min stars filters", async () => {
    const r = await alice.req("/api/search?q=state+management+react&language=TypeScript&min_stars=1000&per_page=10");
    assert.equal(r.status, 200, r.text);
    checkRanking(r.json, 1000);
    assert.ok(r.json.items.every((i) => i.language === "TypeScript"));
    assert.ok(r.json.items.length <= 10);
    printTop("state management react (TypeScript, 1000+)", r.json);
  });
  await step("min_stars below 10 is raised to 10 and reported", async () => {
    const r = await alice.req("/api/search?q=pdf+parser&language=Python&min_stars=1&per_page=5");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.query.minStars, 10);
    assert.equal(r.json.query.notes.length, 1);
    checkRanking(r.json, 10);
    printTop("pdf parser (Python, 10+)", r.json);
  });
  await step("repeated searches come from cache, not GitHub", async () => {
    const before = mock.searchCalls;
    const r = await alice.req("/api/search?q=state+management+react&language=TypeScript&min_stars=1000&per_page=10");
    assert.equal(r.status, 200);
    assert.equal(r.json.cached, true);
    assert.equal(mock.searchCalls, before);
  });
  await step("bad parameters return 400", async () => {
    for (const qs of ["q=", "q=x&per_page=500", "q=x&min_stars=lots", "q=x&page=999"]) {
      const r = await alice.req(`/api/search?${qs}`);
      assert.equal(r.status, 400, qs);
      assert.equal(r.json.code, "invalid_params");
    }
  });
  await step("GitHub rate limit becomes 429 with Retry-After", async () => {
    const r = await alice.req("/api/search?q=ratelimitme");
    assert.equal(r.status, 429);
    assert.equal(r.json.code, "rate_limited");
    const retry = Number(r.headers.get("retry-after"));
    assert.ok(retry > 0 && retry <= 42);
  });
  await step("CORS preflight for API clients", async () => {
    const r = await anon.req("/api/search", { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.match(r.headers.get("access-control-allow-headers"), /Authorization/);
  });
  await step("a revoked GitHub authorization asks the user to sign in again", async () => {
    const bob = new Client();
    await bob.login("revoked");
    const r = await bob.req("/api/search?q=anything+else");
    assert.equal(r.status, 401);
    assert.equal(r.json.code, "github_reauth");
  });

  console.log("REST v1 and MCP");
  const mcp = (body, headers = {}, key = apiKey) =>
    anon.req("/mcp", {
      method: "POST",
      body,
      headers: { Accept: "application/json, text/event-stream", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    });
  const modern = (method, params = {}, extra = {}) => {
    const v = "2026-07-28";
    const body = { jsonrpc: "2.0", id: 7, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" } } } };
    const headers = { "MCP-Protocol-Version": v, "Mcp-Method": method, ...(params.name ? { "Mcp-Name": params.name } : {}), ...extra };
    return mcp(body, headers);
  };
  await step("/v1/search works with an API key and returns a request id", async () => {
    const r = await anon.req("/v1/search?q=state+management+react&language=TypeScript&min_stars=1000&per_page=10", { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.headers.get("x-request-id"));
    assert.ok(r.json.requestId);
    assert.match(r.headers.get("server-timing") ?? "", /total;dur=/);
    checkRanking(r.json, 1000);
  });
  await step("unknown /v1 paths are a JSON 404", async () => {
    const r = await anon.req("/v1/nothing", { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(r.status, 404);
    assert.equal(r.json.code, "not_found");
  });
  await step("README endpoint returns text and validates the repo", async () => {
    const r = await anon.req("/v1/repos/sxyazi/yazi/readme?max_chars=500", { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.repo, "sxyazi/yazi");
    assert.ok(r.json.text.length > 0 && r.json.text.length <= 500);
    assert.equal(r.json.truncated, true);
    const bad = await anon.req("/v1/repos/bad%E0/x/readme", { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(bad.status, 400);
    const big = await anon.req("/v1/repos/sxyazi/yazi/readme?max_chars=99999", { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(big.status, 400);
  });
  await step("MCP rejects missing keys, foreign origins and GET", async () => {
    const noKey = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, null);
    assert.equal(noKey.status, 401);
    assert.match(noKey.headers.get("www-authenticate") ?? "", /Bearer/);
    const foreign = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Origin: "https://evil.example" });
    assert.equal(foreign.status, 403);
    const get = await anon.req("/mcp", { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(get.status, 405);
    const garbage = await anon.req("/mcp", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } });
    assert.equal(garbage.status, 400);
  });
  await step("MCP legacy clients: initialize, notification, ping, tools/list", async () => {
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, "2025-06-18");
    assert.equal(init.json.result.serverInfo.name, "code-search");
    assert.ok(init.json.result.capabilities.tools);
    const odd = await mcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    assert.equal(odd.json.result.protocolVersion, "2025-11-25", "unknown legacy version negotiates to the newest legacy one");
    const note = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "MCP-Protocol-Version": "2025-06-18" });
    assert.equal(note.status, 202);
    const ping = await mcp({ jsonrpc: "2.0", id: 3, method: "ping" }, { "MCP-Protocol-Version": "2025-06-18" });
    assert.deepEqual(ping.json.result, {});
    const list = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { "MCP-Protocol-Version": "2025-06-18" });
    assert.deepEqual(list.json.result.tools.map((t) => t.name), ["search_repositories", "get_repository_readme"]);
    assert.equal(list.json.result.tools[0].annotations.readOnlyHint, true);
    const unknown = await mcp({ jsonrpc: "2.0", id: 5, method: "resources/list" }, { "MCP-Protocol-Version": "2025-06-18" });
    assert.equal(unknown.json.error.code, -32601);
  });
  await step("MCP legacy tools/call: search returns compact text and structured results", async () => {
    const r = await mcp(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "search_repositories", arguments: { query: "self-hosted kanban board with markdown support", per_page: 5 } } },
      { "MCP-Protocol-Version": "2025-06-18" },
    );
    assert.equal(r.status, 200, r.text);
    const res = r.json.result;
    assert.equal(res.isError, false);
    assert.match(res.content[0].text, /Best matches first, then by stars/);
    assert.match(res.content[0].text, /^1\. /m);
    checkRanking(res.structuredContent, 100);
    assert.ok(res.structuredContent.items.length <= 5);
    console.log("      MCP text preview:\n" + res.content[0].text.split("\n").slice(0, 4).map((l) => "        " + l).join("\n"));
  });
  await step("MCP tool errors are returned to the model with isError", async () => {
    const r = await mcp({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "search_repositories", arguments: { query: "ratelimitme" } } }, { "MCP-Protocol-Version": "2025-06-18" });
    assert.equal(r.json.result.isError, true);
    assert.match(r.json.result.content[0].text, /rate limit/i);
    const badArg = await mcp({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "search_repositories", arguments: { query: "x", color: "red" } } }, { "MCP-Protocol-Version": "2025-06-18" });
    assert.equal(badArg.json.result.isError, true);
    assert.match(badArg.json.result.content[0].text, /Unknown argument/);
    const noTool = await mcp({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "nope", arguments: {} } }, { "MCP-Protocol-Version": "2025-06-18" });
    assert.equal(noTool.json.error.code, -32602);
  });
  await step("MCP modern clients: server/discover, tools/list caching hints, README tool", async () => {
    const d = await modern("server/discover");
    assert.equal(d.status, 200, d.text);
    assert.equal(d.json.result.resultType, "complete");
    assert.ok(d.json.result.supportedVersions.includes("2026-07-28"));
    assert.equal(d.json.result._meta["io.modelcontextprotocol/serverInfo"].name, "code-search");
    const l = await modern("tools/list");
    assert.equal(l.json.result.cacheScope, "public");
    assert.ok(l.json.result.ttlMs > 0);
    const rd = await modern("tools/call", { name: "get_repository_readme", arguments: { repo: "https://github.com/sxyazi/yazi", max_chars: 300 } });
    assert.equal(rd.status, 200, rd.text);
    assert.equal(rd.json.result.resultType, "complete");
    assert.equal(rd.json.result.isError, false);
    assert.match(rd.json.result.content[0].text, /README of sxyazi\/yazi/);
  });
  await step("MCP modern validation: header mismatch, missing headers, unsupported version, unknown method", async () => {
    const mismatch = await modern("tools/list", {}, { "Mcp-Method": "tools/call" });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.json.error.code, -32020);
    const nameMismatch = await modern("tools/call", { name: "search_repositories", arguments: { query: "x" } }, { "Mcp-Name": "get_repository_readme" });
    assert.equal(nameMismatch.json.error.code, -32020);
    const encodedName = await modern("tools/call", { name: "search_repositories", arguments: { query: "self-hosted kanban board with markdown support", per_page: 5 } }, { "Mcp-Name": "=?base64?" + Buffer.from("search_repositories").toString("base64") + "?=" });
    assert.equal(encodedName.status, 200, "base64-encoded Mcp-Name is decoded before comparing");
    const noHeader = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } });
    assert.equal(noHeader.status, 400);
    assert.equal(noHeader.json.error.code, -32020);
    const v = "2099-01-01";
    const unsupported = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": v } } }, { "MCP-Protocol-Version": v, "Mcp-Method": "tools/list" });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.json.error.code, -32022);
    assert.ok(unsupported.json.error.data.supported.includes("2026-07-28"));
    const unknown = await modern("resources/list");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, -32601);
  });

  console.log("Usage analytics");
  await step("usage analytics count calls per key, endpoint and outcome", async () => {
    assert.equal((await anon.req("/api/usage")).status, 401);
    assert.equal((await alice.req("/api/usage?days=5")).status, 400);
    await new Promise((r) => setTimeout(r, 800)); // background writes
    const r = await alice.req("/api/usage?days=1");
    assert.equal(r.status, 200);
    assert.equal(r.json.days, 1);
    assert.ok(r.json.keys.some((k) => k.id === keyId && !k.revoked));
    const mine = r.json.rows.filter((x) => x.keyId === keyId);
    const total = (ep) => mine.filter((x) => x.endpoint === ep).reduce((a, x) => a + x.calls, 0);
    assert.ok(total("rest_search") >= 1, "REST searches with the key are counted");
    assert.ok(total("mcp_search") >= 1, "MCP searches are counted");
    assert.ok(total("rest_readme") + total("mcp_readme") >= 1, "README reads are counted");
    assert.ok(r.json.rows.some((x) => x.keyId === "web"), "dashboard searches are counted under web");
    for (const x of r.json.rows) assert.equal(x.calls, x.ok + x.errors + x.limited, "every call has one outcome");
    assert.ok(!JSON.stringify(r.json).includes("state management"), "query text is never stored");
  });

  console.log("Admin console and API call log");
  const admin = new Client();
  await admin.login("admin");
  const newest = async (filter = "") => (await admin.req(`/api/admin/calls?${filter}`)).json.calls;
  await step("the admin API does not exist for anonymous or ordinary users", async () => {
    for (const path of ["summary", "users", "calls", "calls/1"]) {
      assert.equal((await anon.req(`/api/admin/${path}`)).status, 404, path);
      assert.equal((await alice.req(`/api/admin/${path}`)).status, 404, path);
    }
    assert.equal((await alice.req("/api/admin/registration", { method: "POST", body: { open: false }, origin: true })).status, 404);
    assert.equal((await admin.req("/api/me")).json.isAdmin, true);
  });
  await step("every kind of call appears with who made it and what was searched", async () => {
    await new Promise((r) => setTimeout(r, 800));
    const calls = await newest();
    const find = (action, q) => calls.find((c) => c.action === action && (!q || c.query === q));
    const rest = find("rest_search", "state management react");
    assert.ok(rest, JSON.stringify(calls.slice(0, 5)));
    assert.equal(rest.login, "mockuser");
    assert.equal(rest.userId, 1001);
    assert.equal(rest.outcome, "ok");
    assert.ok(rest.resultCount > 0);
    assert.ok(find("mcp_search", "self-hosted kanban board with markdown support"), "MCP searches");
    assert.ok(find("mcp_readme"), "MCP READMEs");
    assert.ok(find("rest_readme", "sxyazi/yazi"), "REST READMEs");
    assert.ok(find("mcp:tools/list"), "MCP protocol calls");
    assert.ok(find("POST /api/keys"), "dashboard calls");
    assert.ok(find("auth_register"), "registrations");
    assert.ok(calls.some((c) => c.outcome === "limited" && c.status === 429), "rate-limited calls");
    assert.ok(calls.some((c) => c.action === "mcp_search" && c.outcome !== "ok" && c.status === 200), "MCP tool errors that return HTTP 200");
    assert.ok(calls.some((c) => c.status === 400), "invalid requests");
    assert.ok(!calls.some((c) => c.action === "GET /api/me" || c.action === "GET /api/usage"), "background checks are left out");
  });
  await step("a call's details show what was sent and what was returned", async () => {
    const [row] = await newest("kind=search&user=1001&q=state%20management&outcome=ok");
    assert.ok(row);
    const { call } = (await admin.req(`/api/admin/calls/${row.id}`)).json;
    assert.equal(call.request.q, "state management react");
    assert.equal(call.response.understood.by, "rules");
    assert.equal(call.response.understood.aiStatus, "ai_disabled");
    assert.ok(call.response.items.length > 0);
    assert.ok(call.response.items.every((i) => typeof i.name === "string" && Number.isInteger(i.stars)));
    assert.equal((await admin.req("/api/admin/calls/99999999")).status, 404);
  });
  await step("the log and the admin API never expose secrets", async () => {
    const all = JSON.stringify(await newest());
    const out = execFileSync(wrangler, ["d1", "execute", "starscout", "--local", "--persist-to", persist, "--json", "--command", "SELECT * FROM api_calls"], { cwd: ROOT, env: { ...process.env, CI: "1" }, maxBuffer: 50_000_000 }).toString();
    const users = (await admin.req("/api/admin/users")).json;
    for (const text of [all, out, JSON.stringify(users)]) {
      assert.ok(!text.includes(apiKey), "API key");
      assert.ok(!text.includes("mock-token"), "GitHub token");
      assert.ok(!text.includes("token_enc"), "token column");
      assert.ok(!text.includes("key_hash"), "key hash");
    }
  });
  await step("users list shows activity and can be searched; filters are validated", async () => {
    const { users } = (await admin.req("/api/admin/users")).json;
    const u = users.find((x) => x.login === "mockuser");
    assert.equal(u.id, 1001);
    assert.ok(u.calls > 5 && u.searches > 3 && u.keys === 1 && u.lastCallAt > 0);
    assert.deepEqual((await admin.req("/api/admin/users?q=mock")).json.users.map((x) => x.login), ["mockuser"]);
    assert.deepEqual((await admin.req("/api/admin/users?q=%25")).json.users, [], "% is a literal, not a wildcard");
    assert.equal((await admin.req("/api/admin/calls?source=evil")).status, 400);
    assert.equal((await admin.req("/api/admin/calls?before=abc")).status, 400);
    assert.equal((await admin.req("/api/admin/calls?q=%27%20OR%201%3D1%20--")).json.calls.length, 0, "text is bound, not concatenated");
    const summary = (await admin.req("/api/admin/summary")).json;
    assert.ok(summary.users.total >= 3 && summary.calls.searchesLast24h > 3);
    assert.equal(summary.registration.open, true);
    assert.equal(summary.ai.enabled, Boolean(process.env.E2E_REAL_AI));
  });
  await step("changing registration needs same-origin and a valid body", async () => {
    assert.equal((await admin.req("/api/admin/registration", { method: "POST", body: { open: false } })).status, 403);
    assert.equal((await admin.req("/api/admin/registration", { method: "POST", body: { open: "no" }, origin: true })).status, 400);
    assert.equal((await admin.req("/api/admin/registration", { origin: true })).status, 405);
  });
  await step("closing registration blocks new users, keeps existing users and admins, and reopening works", async () => {
    const closed = await admin.req("/api/admin/registration", { method: "POST", body: { open: false }, origin: true });
    assert.equal(closed.status, 200);
    assert.equal(closed.json.registration.open, false);
    assert.equal(closed.json.registration.updatedBy, "theadmin");

    const stranger = new Client();
    const blocked = await stranger.login("newcomer");
    assert.equal(blocked.headers.get("location"), "/app/?error=registration_closed");
    assert.ok(!stranger.cookies.has("cs_session"), "no session for a blocked sign-up");
    assert.ok(mock.revokedGrants.includes("newcomer-token"), "the unused GitHub grant is removed");
    const none = execFileSync(wrangler, ["d1", "execute", "starscout", "--local", "--persist-to", persist, "--json", "--command", "SELECT COUNT(*) AS n FROM users WHERE id = 3001"], { cwd: ROOT, env: { ...process.env, CI: "1" } });
    assert.equal(JSON.parse(none)[0].results[0].n, 0, "no account was created");

    const returning = new Client();
    assert.equal((await returning.login("good")).headers.get("location"), "/app/#search", "existing users still sign in");
    assert.equal((await returning.req("/api/me")).status, 200);
    const adminAgain = new Client();
    assert.equal((await adminAgain.login("admin")).headers.get("location"), "/app/#search", "admins are never locked out");

    await new Promise((r) => setTimeout(r, 500));
    assert.ok((await newest("source=auth")).some((c) => c.action === "auth_blocked_signup" && c.login === "newcomer"), "the blocked attempt is logged");
    assert.ok((await newest("source=admin")).some((c) => c.action === "admin_registration"), "the change itself is logged");

    const reopened = await admin.req("/api/admin/registration", { method: "POST", body: { open: true }, origin: true });
    assert.equal(reopened.json.registration.open, true);
    const joined = new Client();
    assert.equal((await joined.login("newcomer")).headers.get("location"), "/app/#search");
    assert.equal((await joined.req("/api/me")).status, 200);
  });
  await step("visitors and GitHub are told when sign-ups are closed", async () => {
    const close = (open) => admin.req("/api/admin/registration", { method: "POST", body: { open }, origin: true });
    await close(false);
    await new Promise((r) => setTimeout(r, 16_000)); // other isolates' display cache
    const me = await new Client().req("/api/me");
    assert.equal(me.status, 401);
    assert.equal(me.json.registrationOpen, false);
    const login = await new Client().req("/auth/login");
    assert.equal(new URL(login.headers.get("location")).searchParams.get("allow_signup"), "false");
    await close(true);
  });
  console.log("Revoking, logout, account deletion");
  await step("revoked key stops working; deleting someone else's/unknown key is 404", async () => {
    assert.equal((await alice.req(`/api/keys/${keyId}`, { method: "DELETE" })).status, 403, "needs same origin");
    assert.equal((await alice.req(`/api/keys/${keyId}`, { method: "DELETE", origin: true })).status, 200);
    assert.equal((await alice.req(`/api/keys/${keyId}`, { method: "DELETE", origin: true })).status, 404);
    const r = await anon.req("/api/search?q=react", { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(r.status, 401);
  });
  await step("logout ends the session server-side", async () => {
    const stolen = alice.cookies.get("cs_session");
    assert.equal((await alice.req("/auth/logout", { method: "POST" })).status, 403, "needs same origin");
    assert.equal((await alice.req("/auth/logout", { method: "POST", origin: true })).status, 200);
    assert.equal((await alice.req("/api/me")).status, 401);
    const replay = new Client();
    replay.cookies.set("cs_session", stolen);
    assert.equal((await replay.req("/api/me")).status, 401, "old session token no longer works");
  });
  await step("account deletion removes data, keys and revokes the GitHub grant", async () => {
    await alice.login("good");
    const k = await alice.req("/api/keys", { method: "POST", body: { name: "temp" }, origin: true });
    assert.equal(k.status, 201);
    const del = await alice.req("/api/account/delete", { method: "POST", origin: true });
    assert.equal(del.status, 200);
    assert.ok(mock.revokedGrants.includes("mock-token"));
    assert.equal((await alice.req("/api/me")).status, 401);
    const r = await anon.req("/api/search?q=react", { headers: { Authorization: `Bearer ${k.json.key}` } });
    assert.equal(r.status, 401);
    const out = execFileSync(wrangler, ["d1", "execute", "starscout", "--local", "--persist-to", persist, "--json",
      "--command", "SELECT (SELECT COUNT(*) FROM users WHERE id=1001) AS u, (SELECT COUNT(*) FROM sessions WHERE user_id=1001) AS s, (SELECT COUNT(*) FROM api_keys WHERE user_id=1001) AS k, (SELECT COUNT(*) FROM api_calls WHERE user_id=1001) AS c"], { cwd: ROOT, env: { ...process.env, CI: "1" } });
    assert.deepEqual(JSON.parse(out)[0].results[0], { u: 0, s: 0, k: 0, c: 0 }, "the call log is deleted with the account");
  });

  console.log(`\nAll ${passed} end-to-end checks passed. (Real GitHub searches used: ${mock.upstreamCalls})`);
}

try {
  await main();
  if (process.env.E2E_KEEP_RUNNING) {
    console.log(`\nKeeping the app running at ${APP} with mock GitHub login. Press Ctrl+C to stop.`);
    await new Promise((resolve) => process.on("SIGINT", resolve));
  }
} catch (err) {
  console.error("\nE2E FAILED:", err);
  process.exitCode = 1;
} finally {
  dev?.kill("SIGINT");
  server.close();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(persist, { recursive: true, force: true });
}
