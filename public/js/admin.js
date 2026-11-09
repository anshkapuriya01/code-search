// Admin console: users, the API call log and the registration switch. Data is rendered as text nodes only.

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("en");

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : {},
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

function flash(message) {
  $("flash").textContent = message;
  $("flash").hidden = false;
}
const clearFlash = () => ($("flash").hidden = true);
const report = (err) => flash(err.message || "Something went wrong.");

function confirmDialog(title, text, okLabel) {
  const d = $("confirm");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = okLabel;
  d.returnValue = "";
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

const when = (ts) => (ts ? new Date(ts).toLocaleString("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const day = (ts) => (ts ? new Date(ts).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" }) : "—");
const safeUrl = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
const ACTIONS = {
  rest_search: "REST search",
  rest_readme: "REST README",
  mcp_search: "MCP search",
  mcp_readme: "MCP README",
  auth_signin: "Signed in",
  auth_register: "Registered",
  auth_blocked_signup: "Sign-up blocked",
  auth_signout: "Signed out",
  admin_registration: "Changed registration",
};
const OUTCOME = { ok: "OK", error: "Error", limited: "Rate-limited" };
const AI_STATUS = {
  ai: "AI",
  ai_cached: "AI (remembered)",
  skipped: "Rules (single word)",
  no_binding: "Rules (AI not connected)",
  ai_disabled: "Rules (AI turned off)",
  budget_exhausted: "Rules (daily AI budget used)",
  user_budget_exhausted: "Rules (this account's daily AI allowance used)",
  ai_timeout: "Rules (AI too slow)",
  ai_error: "Rules (AI failed)",
  ai_invalid: "Rules (AI answer rejected)",
};

// ---------- Summary and registration ----------

let registrationOpen = true;

function stat(label, value, note) {
  return el("div", { class: "ustat" }, el("p", { class: "ustat-k", text: label }), el("p", { class: "ustat-v", text: value }), el("p", { class: "ustat-n", text: note }));
}

function renderRegistration(r) {
  registrationOpen = r.open;
  $("registration-card").classList.toggle("is-closed", !r.open);
  $("registration-state").textContent = r.open ? "Open" : "Closed";
  $("registration-text").textContent = r.open
    ? "Anyone with a GitHub account can sign up."
    : "New sign-ups are blocked and sign-up buttons are hidden. Existing users keep working and can still sign in.";
  $("registration-updated").textContent = r.updatedAt ? `Last changed ${when(r.updatedAt)} by ${r.updatedBy}.` : "";
  const button = $("registration-toggle");
  button.textContent = r.open ? "Close new registrations" : "Reopen registrations";
  button.className = r.open ? "btn btn-accent" : "btn btn-paper";
}

function renderSummary(s) {
  renderRegistration(s.registration);
  const aiNote = s.ai.enabled ? `of ${fmt.format(s.ai.budget)} today · ${fmt.format(s.ai.calls)} requests` : "AI is off, rules are in use";
  $("stats").replaceChildren(
    stat("Users", fmt.format(s.users.total), `${fmt.format(s.users.newLast7Days)} new in 7 days`),
    stat("Active users", fmt.format(s.users.activeToday), "today (UTC)"),
    stat("API calls", fmt.format(s.calls.today), `${fmt.format(s.calls.failedToday)} failed, today (UTC)`),
    stat("Searches", fmt.format(s.calls.searchesToday), `${fmt.format(s.calls.aiSearchesToday)} understood by AI`),
    stat("AI neurons", fmt.format(Math.round(s.ai.neurons)), aiNote),
  );
  $("log-note").textContent = `Newest first. Kept for ${s.log.retentionDays} days, up to ${fmt.format(s.log.maxRows)} calls. Totals in the Users table cover the last ${s.log.totalsDays} days.`;
}

$("registration-toggle").addEventListener("click", async () => {
  const closing = registrationOpen;
  const ok = await confirmDialog(
    closing ? "Close new registrations?" : "Reopen registrations?",
    closing
      ? "Nobody new can sign up, and sign-up buttons disappear within seconds of the next page load. Existing users are not affected."
      : "Anyone with a GitHub account can sign up again.",
    closing ? "Close registrations" : "Reopen",
  );
  if (!ok) return;
  clearFlash();
  try {
    const { registration } = await api("/api/admin/registration", { method: "POST", body: JSON.stringify({ open: !closing }) });
    renderRegistration(registration);
  } catch (err) {
    report(err);
  }
});

// ---------- Users ----------

let usersNext = null;

function userRow(u) {
  const avatar = safeUrl(u.avatarUrl);
  return el(
    "tr",
    {},
    el(
      "td",
      {},
      el(
        "span",
        { class: "adm-user" },
        avatar ? el("img", { class: "avatar", src: avatar, alt: "", width: 28, height: 28 }) : null,
        el("span", {}, el("a", { class: "link", href: `https://github.com/${encodeURIComponent(u.login)}`, target: "_blank", rel: "noopener noreferrer", text: u.login }), u.name ? el("small", { text: u.name }) : null),
      ),
    ),
    el("td", { text: day(u.joinedAt) }),
    el("td", { text: when(u.lastCallAt) }),
    el("td", { class: "num", text: fmt.format(u.keys) }),
    el("td", { class: "num", text: fmt.format(u.searches) }),
    el("td", { class: "num", text: fmt.format(u.calls) }),
    el("td", {}, el("button", { class: "btn btn-small", type: "button", text: "View calls", onclick: () => filterByUser(u) })),
  );
}

async function loadUsers(more = false) {
  const params = new URLSearchParams();
  const q = $("users-q").value.trim();
  if (q) params.set("q", q);
  if (more && usersNext) params.set("offset", String(usersNext));
  const data = await api(`/api/admin/users?${params}`);
  const rows = data.users.map(userRow);
  if (more) $("users").append(...rows);
  else $("users").replaceChildren(...rows);
  usersNext = data.nextOffset;
  $("users-more").hidden = usersNext === null;
  $("users-empty").hidden = $("users").children.length > 0;
}

$("users-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadUsers().catch(report);
});
$("users-more").addEventListener("click", () => loadUsers(true).catch(report));

// ---------- Calls ----------

let callsNext = null;
let userFilter = null;

function callRow(c) {
  const via = c.keyName ? `key: ${c.keyName}` : c.source === "web" ? "dashboard" : c.source;
  return el(
    "tr",
    {},
    el("td", { class: "adm-nowrap", text: when(c.ts) }),
    el("td", {}, c.login),
    el("td", {}, ACTIONS[c.action] ?? c.action, el("small", { text: via })),
    el("td", { class: "adm-query" }, c.query ?? "—", c.error ? el("small", { class: "adm-error", text: c.error }) : null),
    el("td", { class: "num", text: c.resultCount === null ? "—" : fmt.format(c.resultCount) }),
    el("td", {}, el("span", { class: `adm-pill is-${c.outcome}`, text: OUTCOME[c.outcome] ?? c.outcome }), el("small", { text: `${c.status} · ${fmt.format(c.durationMs)} ms` })),
    el("td", {}, el("button", { class: "btn btn-small", type: "button", text: "Details", onclick: () => openDetail(c.id).catch(report) })),
  );
}

async function loadCalls(more = false) {
  const params = new URLSearchParams();
  const put = (k, v) => v && params.set(k, v);
  put("q", $("calls-q").value.trim());
  put("kind", $("calls-kind").value);
  put("source", $("calls-source").value);
  put("outcome", $("calls-outcome").value);
  if (userFilter) params.set("user", String(userFilter.id));
  if (more && callsNext) params.set("before", String(callsNext));
  const data = await api(`/api/admin/calls?${params}`);
  const rows = data.calls.map(callRow);
  if (more) $("calls").append(...rows);
  else $("calls").replaceChildren(...rows);
  callsNext = data.nextBefore;
  $("calls-more").hidden = callsNext === null;
  $("calls-empty").hidden = $("calls").children.length > 0;
}

function filterByUser(u) {
  userFilter = u;
  $("user-filter").hidden = false;
  $("user-filter-text").textContent = `Showing calls by ${u.login}.`;
  loadCalls().catch(report);
  $("calls-h").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("user-filter-clear").addEventListener("click", () => {
  userFilter = null;
  $("user-filter").hidden = true;
  loadCalls().catch(report);
});
$("calls-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadCalls().catch(report);
});
$("calls-more").addEventListener("click", () => loadCalls(true).catch(report));

async function refreshAll() {
  clearFlash();
  const [summary] = await Promise.all([api("/api/admin/summary"), loadUsers(), loadCalls()]);
  renderSummary(summary);
}
$("refresh").addEventListener("click", () => refreshAll().catch(report));

// ---------- One call ----------

function facts(pairs) {
  return el("dl", { class: "facts" }, pairs.filter(([, v]) => v !== null && v !== undefined && v !== "").flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: String(v) })]));
}

const block = (title, ...content) => el("section", { class: "adm-block" }, el("h3", { text: title }), ...content);
const jsonBlock = (value) => el("pre", { class: "adm-json" }, el("code", { text: JSON.stringify(value, null, 2) }));

function understoodBlock(u) {
  if (!u) return null;
  const synonyms = Object.entries(u.synonyms ?? {}).map(([term, list]) => `${term}: ${list.join(", ")}`);
  return block(
    "How the request was understood",
    facts([
      ["Understood by", AI_STATUS[u.aiStatus] ?? u.by],
      ["Key terms", (u.keyTerms ?? []).join(", ")],
      ["Descriptive", (u.descriptiveWords ?? []).join(", ")],
      ["Also matched", synonyms.join("; ")],
      ["Context only", (u.context ?? []).join("; ")],
      ["GitHub filters", (u.qualifiers ?? []).join(" ")],
      ["Ignored", (u.ignored ?? []).join(" ")],
    ]),
  );
}

function resultsBlock(r) {
  const heading = `${fmt.format(r.total)} results, showing page ${r.page}${r.itemsLogged ? ` (${r.itemsLogged} kept in the log)` : ""}`;
  const items = r.items.map((it) =>
    el(
      "li",
      {},
      el("a", { class: "link", href: `https://github.com/${it.name.split("/").map(encodeURIComponent).join("/")}`, target: "_blank", rel: "noopener noreferrer", text: it.name }),
      el("span", { class: "quiet", text: ` ★${fmt.format(it.stars)}${it.language ? ` · ${it.language}` : ""}${it.license ? ` · ${it.license}` : ""}` }),
      it.description ? el("small", { text: it.description }) : null,
    ),
  );
  return block(heading, items.length ? el("ol", { class: "adm-results" }, items) : el("p", { class: "quiet", text: "Nothing was returned." }));
}

async function openDetail(id) {
  const { call: c } = await api(`/api/admin/calls/${id}`);
  const r = c.response;
  $("detail-title").textContent = ACTIONS[c.action] ?? c.action;
  const parts = [
    facts([
      ["Time", new Date(c.ts).toLocaleString("en")],
      ["User", `${c.login} (id ${c.userId})`],
      ["Via", c.keyName ? `API key: ${c.keyName}` : c.source],
      ["Endpoint", `${c.method} ${c.path}`],
      ["Status", `${c.status} · ${OUTCOME[c.outcome] ?? c.outcome}`],
      ["Took", `${fmt.format(c.durationMs)} ms${c.cached ? ", from cache" : ""}`],
      ["Error", c.error],
      ["Client", c.client],
      ["Country", c.country],
      ["Request id", c.requestId],
    ]),
  ];
  if (c.request) parts.push(block("Sent", jsonBlock(c.request)));
  if (r?.understood) parts.push(understoodBlock(r.understood));
  if (Array.isArray(r?.items)) parts.push(resultsBlock(r));
  else if (r?.preview !== undefined) parts.push(block(`README of ${r.repo}: ${fmt.format(r.returnedChars)} of ${fmt.format(r.totalChars)} characters returned`, el("pre", { class: "adm-json" }, el("code", { text: r.preview }))));
  else if (r) parts.push(block("Returned", jsonBlock(r)));
  $("detail-body").replaceChildren(...parts);
  $("detail").showModal();
}

// ---------- Start ----------

async function init() {
  try {
    await refreshAll();
    $("loading").hidden = true;
    $("console").hidden = false;
  } catch (err) {
    $("loading").hidden = true;
    if (err instanceof ApiError && err.status === 404) $("denied").hidden = false;
    else report(err);
  }
}

init();
