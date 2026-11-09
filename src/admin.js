// Admin console API (/api/admin/*). Only the GitHub accounts listed in ADMIN_GITHUB_IDS may use it; to everyone
// else these paths do not exist. Tokens and key hashes are never selected here.

import { errorJson, json } from "./http.js";
import { isSameOrigin } from "./auth.js";
import { isAdmin } from "./config.js";
import { aiUsageToday, dailyBudget } from "./ai.js";
import { MAX_ROWS, RETENTION_DAYS } from "./audit.js";
import { withAppTables } from "./schema.js";
import { registrationState, setRegistrationOpen } from "./settings.js";

const DAY_MS = 86_400_000;
const PAGE_SIZE = 50;
const MAX_TEXT_FILTER = 100;
const SOURCES = ["web", "rest", "mcp", "auth", "admin"];
const OUTCOMES = ["ok", "error", "limited"];
const KINDS = {
  search: ["rest_search", "mcp_search"],
  readme: ["rest_readme", "mcp_readme"],
};

const likePattern = (text) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/** A whole number from a query parameter, or the fallback; null when present but invalid. */
function intParam(raw, fallback) {
  if (raw === null || raw === "") return fallback;
  return /^\d{1,16}$/.test(raw) ? Number(raw) : null;
}

export async function handleAdminApi(request, env, url, session, audit) {
  const notFound = () => errorJson(404, "Not found.", { code: "not_found" });
  if (!session || !isAdmin(env, session.user)) return notFound();
  const { pathname } = url;
  const method = request.method;
  audit.source = "admin";
  audit.skip = method === "GET"; // reading the console should not fill the log it shows

  if (pathname === "/api/admin/summary") {
    if (method !== "GET") return errorJson(405, "Use GET.", { code: "method_not_allowed" });
    return json(await summary(env));
  }

  if (pathname === "/api/admin/registration") {
    if (method !== "POST") return errorJson(405, "Use POST.", { code: "method_not_allowed" });
    if (!isSameOrigin(request, url)) return errorJson(403, "Cross-site request blocked.", { code: "forbidden" });
    const text = await request.text();
    let body;
    try {
      body = text.length <= 200 ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (typeof body?.open !== "boolean") return errorJson(400, 'Send {"open": true} or {"open": false}.', { code: "invalid_params" });
    audit.input = { open: body.open };
    audit.action = "admin_registration";
    const registration = await setRegistrationOpen(env, body.open, session.user.login);
    audit.output = { open: registration.open };
    return json({ registration });
  }

  if (pathname === "/api/admin/users") {
    if (method !== "GET") return errorJson(405, "Use GET.", { code: "method_not_allowed" });
    return listUsers(env, url);
  }

  if (pathname === "/api/admin/calls") {
    if (method !== "GET") return errorJson(405, "Use GET.", { code: "method_not_allowed" });
    return listCalls(env, url);
  }

  const detail = pathname.match(/^\/api\/admin\/calls\/(\d{1,16})$/);
  if (detail) {
    if (method !== "GET") return errorJson(405, "Use GET.", { code: "method_not_allowed" });
    return callDetail(env, Number(detail[1]));
  }

  return notFound();
}

async function summary(env) {
  const now = Date.now();
  const since = now - DAY_MS;
  const [counts, registration, ai] = await Promise.all([
    withAppTables(env, () =>
      env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS n FROM users"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?1").bind(now - 7 * DAY_MS),
        env.DB.prepare(
          `SELECT COUNT(*) AS calls, COUNT(DISTINCT user_id) AS active,
             COALESCE(SUM(action IN ('rest_search', 'mcp_search')), 0) AS searches,
             COALESCE(SUM(outcome <> 'ok'), 0) AS failed,
             COALESCE(SUM(ai_status IN ('ai', 'ai_cached')), 0) AS ai_searches
           FROM api_calls WHERE ts >= ?1`,
        ).bind(since),
      ]),
    ),
    registrationState(env),
    aiUsageToday(env),
  ]);
  const day = counts[2].results[0];
  const budget = dailyBudget(env);
  return {
    registration,
    users: { total: counts[0].results[0].n, newLast7Days: counts[1].results[0].n, activeLast24h: day.active },
    calls: { last24h: day.calls, searchesLast24h: day.searches, failedLast24h: day.failed, aiSearchesLast24h: day.ai_searches },
    ai: { ...ai, budget, enabled: Boolean(env.AI?.run) && budget > 0 },
    log: { retentionDays: RETENTION_DAYS, maxRows: MAX_ROWS },
  };
}

async function listUsers(env, url) {
  const offset = intParam(url.searchParams.get("offset"), 0);
  if (offset === null) return errorJson(400, "offset must be a whole number.", { code: "invalid_params" });
  const text = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_TEXT_FILTER);
  const pattern = text ? likePattern(text) : null;
  const { results } = await withAppTables(env, () =>
    env.DB.prepare(
      `SELECT u.id, u.login, u.name, u.avatar_url, u.created_at, u.updated_at,
         (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS key_count,
         COALESCE(c.calls, 0) AS calls, COALESCE(c.searches, 0) AS searches, c.last_call
       FROM users u
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS calls, SUM(action IN ('rest_search', 'mcp_search')) AS searches, MAX(ts) AS last_call
         FROM api_calls GROUP BY user_id
       ) c ON c.user_id = u.id
       WHERE ?1 IS NULL OR u.login LIKE ?1 ESCAPE '\\' OR u.name LIKE ?1 ESCAPE '\\'
       ORDER BY COALESCE(c.last_call, u.created_at) DESC
       LIMIT ?2 OFFSET ?3`,
    )
      .bind(pattern, PAGE_SIZE + 1, offset)
      .all(),
  );
  return json({
    users: results.slice(0, PAGE_SIZE).map((r) => ({
      id: r.id,
      login: r.login,
      name: r.name,
      avatarUrl: r.avatar_url,
      joinedAt: r.created_at,
      lastSignInAt: r.updated_at,
      keys: r.key_count,
      calls: r.calls,
      searches: r.searches,
      lastCallAt: r.last_call,
    })),
    nextOffset: results.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
  });
}

const LIST_COLUMNS = `id, ts, user_id, user_login, key_name, source, action, method, path, status, outcome, error,
  duration_ms, cached, query_text, result_count, ai_status`;

async function listCalls(env, url) {
  const p = url.searchParams;
  const before = intParam(p.get("before"), null);
  const user = intParam(p.get("user"), null);
  if ((p.get("before") && before === null) || (p.get("user") && user === null)) {
    return errorJson(400, "before and user must be whole numbers.", { code: "invalid_params" });
  }
  const source = p.get("source") ?? "";
  const outcome = p.get("outcome") ?? "";
  const kind = p.get("kind") ?? "";
  if ((source && !SOURCES.includes(source)) || (outcome && !OUTCOMES.includes(outcome)) || (kind && !KINDS[kind] && kind !== "other")) {
    return errorJson(400, "Unknown filter value.", { code: "invalid_params" });
  }
  const text = (p.get("q") ?? "").trim().slice(0, MAX_TEXT_FILTER);

  const where = [];
  const args = [];
  const add = (sql, value) => {
    args.push(value);
    where.push(sql.replaceAll("?", `?${args.length}`));
  };
  if (before !== null) add("id < ?", before);
  if (user !== null) add("user_id = ?", user);
  if (source) add("source = ?", source);
  if (outcome) add("outcome = ?", outcome);
  if (text) add("(query_text LIKE ? ESCAPE '\\' OR user_login LIKE ? ESCAPE '\\')", likePattern(text));
  // Fixed strings from KINDS, never user input.
  const known = Object.values(KINDS).flat().map((a) => `'${a}'`).join(", ");
  if (KINDS[kind]) where.push(`action IN (${KINDS[kind].map((a) => `'${a}'`).join(", ")})`);
  if (kind === "other") where.push(`action NOT IN (${known})`);

  args.push(PAGE_SIZE + 1);
  const sql = `SELECT ${LIST_COLUMNS} FROM api_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?${args.length}`;
  const { results } = await withAppTables(env, () => env.DB.prepare(sql).bind(...args).all());
  const page = results.slice(0, PAGE_SIZE);
  return json({ calls: page.map(callRow), nextBefore: results.length > PAGE_SIZE ? page[page.length - 1].id : null });
}

function callRow(r) {
  return {
    id: r.id,
    ts: r.ts,
    userId: r.user_id,
    login: r.user_login,
    keyName: r.key_name,
    source: r.source,
    action: r.action,
    method: r.method,
    path: r.path,
    status: r.status,
    outcome: r.outcome,
    error: r.error,
    durationMs: r.duration_ms,
    cached: r.cached === 1,
    query: r.query_text,
    resultCount: r.result_count,
    aiStatus: r.ai_status,
  };
}

const parseStored = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

async function callDetail(env, id) {
  const row = await withAppTables(env, () => env.DB.prepare("SELECT * FROM api_calls WHERE id = ?1").bind(id).first());
  if (!row) return errorJson(404, "That call is no longer in the log.", { code: "not_found" });
  return json({
    call: {
      ...callRow(row),
      requestId: row.request_id,
      client: row.client,
      country: row.country,
      request: parseStored(row.request_json),
      response: parseStored(row.response_json),
    },
  });
}
