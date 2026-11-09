// The API call log behind the admin console: one row per call by a signed-in user, with what was asked and
// what came back. Written in the background after the response, so it cannot slow or break a request.
//
// Never stored: API keys, session tokens, GitHub tokens, IP addresses. Calls without a valid account cannot be
// attributed to a user and are not stored, so anonymous traffic cannot fill the database.

import { countRequestStatement, siteIsFull } from "./limits.js";
import { isAdmin } from "./config.js";
import { withAppTables } from "./schema.js";

// D1's free tier allows 500 MB per database, and a full database would stop sign-ins and new API keys. Every
// column is capped in bytes, so MAX_ROWS at the largest possible row (about 9 KB) is under 250 MB.
export const MAX_ROWS = 25_000;
export const USER_LOG_ROWS = 2_000; // newest rows kept per account, so one account cannot push out the others
export const RETENTION_DAYS = 90;
const PRUNE_EVERY = 100; // inserts
const PRUNE_BATCH = 500;
const DAY_MS = 86_400_000;
export const MAX_RESPONSE_BYTES = 6_000;
const MAX_REQUEST_BYTES = 1_000;
const MAX_QUERY_BYTES = 600;
const MAX_CLIENT_BYTES = 200;
const MAX_ERROR_BYTES = 300;
const MAX_DESCRIPTION_CHARS = 120;
const README_PREVIEW_CHARS = 1_000;

export function startAudit(request, url, requestId) {
  return {
    requestId,
    ts: Date.now(),
    method: request.method,
    path: url.pathname.slice(0, 200),
    user: null,
    keyId: null,
    keyName: null,
    source: null,
    action: null,
    query: null,
    input: null,
    output: null,
    resultCount: null,
    cached: false,
    aiStatus: null,
    error: null,
    skip: false, // leave out of the log
    uncounted: false, // leave out of the daily totals
    limited: false, // blocked by our own limits: write nothing at all
    client: clipText(request.headers.get("User-Agent") ?? "", MAX_CLIENT_BYTES) || null,
    country: typeof request.cf?.country === "string" ? request.cf.country : null,
  };
}

/** Attributes the call to the user from authenticate(). */
export function auditCaller(audit, caller, source) {
  audit.user = { id: caller.user.id, login: caller.user.login };
  audit.keyId = caller.apiKey?.keyId ?? null;
  audit.keyName = caller.apiKey?.name ?? null;
  audit.source = source ?? (caller.apiKey ? "rest" : "web");
}

export function auditError(audit, err) {
  audit.error = {
    code: String(err?.code ?? err?.extra?.code ?? (err?.status === 429 ? "rate_limited" : "error")),
    message: String(err?.message ?? err),
  };
  if (err?.ownLimit) audit.limited = true;
}

/** Records a search and the page of results it returned. */
export function auditSearch(audit, body) {
  audit.resultCount = body.total;
  audit.cached = body.cached === true;
  audit.aiStatus = body.query.aiStatus ?? null;
  audit.output = fitItems({
    understood: {
      by: body.query.interpretedBy,
      aiStatus: body.query.aiStatus,
      keyTerms: body.query.keyTerms,
      descriptiveWords: body.query.descriptiveWords,
      synonyms: body.query.synonyms,
      context: body.query.context,
      qualifiers: body.query.qualifiers,
      ignored: body.query.ignored,
    },
    matchLevel: body.matchLevel,
    mode: body.mode,
    total: body.total,
    page: body.page,
    perPage: body.perPage,
    hasMore: body.hasMore,
    incomplete: body.incomplete,
    cached: body.cached === true,
    items: body.items.map((it) => ({
      name: it.name,
      stars: it.stars,
      language: it.language,
      license: it.license,
      description: it.description ? it.description.slice(0, MAX_DESCRIPTION_CHARS) : null,
    })),
  });
}

/** Records a README read: which repository, its size, and the start of the text. */
export function auditReadme(audit, body) {
  audit.resultCount = body.totalChars ?? null;
  audit.cached = body.cached === true;
  audit.output = {
    repo: body.repo,
    url: body.url,
    totalChars: body.totalChars,
    returnedChars: body.text?.length ?? 0,
    truncated: body.truncated,
    preview: body.text ? body.text.slice(0, README_PREVIEW_CHARS) : "",
  };
}

function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

// Very long pages lose their last items, never become broken JSON.
function fitItems(output) {
  const items = [];
  // Room for the item separators and the "itemsLogged" note that may be added below.
  let used = byteLength(JSON.stringify({ ...output, items: [] })) + 40;
  for (const item of output.items) {
    used += byteLength(JSON.stringify(item)) + 1;
    if (used > MAX_RESPONSE_BYTES) break;
    items.push(item);
  }
  const out = { ...output, items };
  if (items.length < output.items.length) out.itemsLogged = `${items.length} of ${output.items.length}`;
  return out;
}

function clipText(text, maxBytes) {
  let out = text.slice(0, maxBytes);
  while (byteLength(out) > maxBytes) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

/** JSON of value in at most maxBytes, whatever it contains. */
function clip(value, maxBytes) {
  if (value === null || value === undefined) return null;
  const s = JSON.stringify(value);
  if (byteLength(s) <= maxBytes) return s;
  let end = Math.min(s.length, maxBytes);
  let out = JSON.stringify({ clipped: s.slice(0, end) });
  while (byteLength(out) > maxBytes) {
    end = Math.floor(end * 0.75);
    out = JSON.stringify({ clipped: s.slice(0, end) });
  }
  return out;
}

export function outcomeFor(audit, status) {
  if (status === 429 || audit.error?.code === "rate_limited" || audit.error?.code === "too_many_requests") return "limited";
  return status >= 400 || audit.error ? "error" : "ok";
}

const INSERT = `INSERT INTO api_calls (ts, request_id, user_id, user_login, key_id, key_name, source, action, method, path,
    status, outcome, error, duration_ms, cached, query_text, result_count, ai_status, client, country, request_json, response_json)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)`;

/**
 * Counts the call and writes its log row in the background. Does nothing for calls that have no signed-in user,
 * or that our own limits blocked, so that a client hammering the limit costs no database writes.
 */
export function finishAudit(env, ctx, audit, status, durationMs) {
  if (!audit.user || audit.limited || !env?.DB || !ctx?.waitUntil) return;
  if (siteIsFull(env) && isAdmin(env, audit.user)) return; // the admin keeps working, without using the last writes
  const log = !audit.skip && Boolean(audit.action);
  if (!log && audit.uncounted) return;
  const outcome = outcomeFor(audit, status);
  const args = [
    audit.ts,
    audit.requestId,
    audit.user.id,
    audit.user.login,
    audit.keyId,
    audit.keyName,
    audit.source ?? "web",
    audit.action,
    audit.method,
    audit.path,
    status,
    outcome,
    audit.error ? clipText(`${audit.error.code}: ${audit.error.message}`, MAX_ERROR_BYTES) : null,
    durationMs,
    audit.cached ? 1 : 0,
    audit.query === null || audit.query === undefined ? null : clipText(String(audit.query), MAX_QUERY_BYTES),
    audit.resultCount ?? null,
    audit.aiStatus,
    audit.client,
    audit.country,
    clip(audit.input, MAX_REQUEST_BYTES),
    clip(audit.output, MAX_RESPONSE_BYTES),
  ];
  const write = withAppTables(env, async () => {
    const statements = [];
    if (log) statements.push(env.DB.prepare(INSERT).bind(...args));
    if (!audit.uncounted) {
      statements.push(
        countRequestStatement(env, audit.user.id, {
          search: audit.action === "rest_search" || audit.action === "mcp_search",
          failed: outcome !== "ok",
          ai: audit.aiStatus === "ai" || audit.aiStatus === "ai_cached",
        }),
      );
    }
    const results = await env.DB.batch(statements);
    const id = log ? results[0]?.meta?.last_row_id : null;
    if (id && id % PRUNE_EVERY === 0) await pruneCalls(env, id);
  }).catch((err) => console.error("API call log write failed", String(err)));
  ctx.waitUntil(write);
}

/** Drops rows over the row cap, and rows past retention from the oldest end. */
export function pruneCalls(env, newestId, now = Date.now()) {
  return env.DB.prepare(
    `DELETE FROM api_calls WHERE id <= ?1
       OR id IN (SELECT id FROM (SELECT id, ts FROM api_calls ORDER BY id LIMIT ?2) WHERE ts < ?3)`,
  )
    .bind(newestId - MAX_ROWS, PRUNE_BATCH, now - RETENTION_DAYS * DAY_MS)
    .run();
}
