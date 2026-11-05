// Dashboard: live search, agent setup with the user's own key, API keys and account.

import { AGENTS, mcpUrl, markSvg, copyText, PLACEHOLDER_KEY } from "/js/agents.js";
import { stagger, initChrome } from "/js/motion.js";
import { renderCode } from "/js/code.js";
import { initUsage, decorateKeyRows } from "/js/usage-view.js";

const PENDING_KEY = "cs:pending-query";

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

const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code;
    this.retryAfter = body?.retryAfter;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

// ---------- Flash and confirm ----------

function flash(message, { signIn = false } = {}) {
  const f = $("flash");
  f.replaceChildren(message);
  if (signIn) f.append(" ", el("a", { class: "link", href: "/auth/login", text: "Sign in again" }));
  f.hidden = false;
}
const clearFlash = () => ($("flash").hidden = true);

function handle(err) {
  if (err instanceof ApiError && (err.code === "signin_required" || err.code === "github_reauth")) flash(err.message, { signIn: true });
  else flash(err.message || "Something went wrong.");
}

function confirmDialog(title, text, okLabel) {
  const d = $("confirm");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = okLabel;
  if (typeof d.showModal !== "function") return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  d.returnValue = "";
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

const LOGIN_ERRORS = {
  denied: "Sign-in was cancelled.",
  state: "Sign-in expired or could not be verified. Please try again.",
  github: "GitHub sign-in failed. Please try again.",
  config: "Sign-in is not set up on this server yet.",
};

// ---------- Views ----------

const VIEWS = ["loading", "signin", "search", "connect", "keys", "usage", "account"];
let me = null;
let lastKey = null; // the most recently created key, kept in memory for this tab only
let keysLoaded = false;

function show(view) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll("#app-tabs a")) {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const tiles = document.querySelectorAll(`#view-${view} .tile`);
  stagger(tiles, "chip-in");
}

function route() {
  if (!me) return show("signin");
  const view = location.hash.slice(1);
  const target = ["search", "connect", "keys", "usage", "account"].includes(view) ? view : "search";
  show(target);
  if (target === "keys") loadKeys();
  if (target === "usage") initUsage(handle);
  if (target === "connect") renderConnect();
  if (target === "search") {
    let pending = null;
    try {
      pending = sessionStorage.getItem(PENDING_KEY);
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      // storage blocked
    }
    if (pending) {
      $("q").value = pending;
      runSearch(1);
    } else $("q").focus({ preventScroll: true });
  }
}

async function init() {
  const params = new URLSearchParams(location.search);
  const err = params.get("error");
  if (err) {
    flash(LOGIN_ERRORS[err] || "Sign-in failed. Please try again.");
    history.replaceState(null, "", location.pathname + location.hash);
  }
  try {
    me = (await api("/api/me")).user;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) handle(e);
    me = null;
  }
  if (me) {
    $("app-tabs").hidden = false;
    $("app-user").hidden = false;
    $("login").textContent = me.login;
    $("account-login").textContent = me.login;
    const avatar = safeUrl(me.avatarUrl);
    if (avatar) $("avatar").src = avatar;
    else $("avatar").hidden = true;
  } else {
    $("app-guest").hidden = false;
  }
  route();
}

window.addEventListener("hashchange", () => {
  clearFlash();
  route();
});

$("logout").addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST" });
  } catch {
    // reload either way
  }
  location.href = "/";
});

// ---------- Search ----------

let page = 1;

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch(1);
});
$("prev").addEventListener("click", () => runSearch(page - 1));
$("next").addEventListener("click", () => runSearch(page + 1));

async function runSearch(p) {
  const q = $("q").value.trim();
  const language = $("language").value;
  if (!q && !language) return $("q").focus();
  clearFlash();
  const params = new URLSearchParams({ q, min_stars: $("min-stars").value, page: String(p), per_page: "20" });
  if (language) params.set("language", language);
  if ($("include-archived").checked) params.set("include_archived", "true");
  const btn = $("search-btn");
  btn.disabled = true;
  btn.textContent = "Searching";
  $("results-meta").textContent = "Asking GitHub…";
  try {
    const data = await api(`/v1/search?${params}`);
    page = data.page;
    renderResults(data);
    if (p !== 1) $("results-meta").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    $("results-meta").textContent = "";
    if (err instanceof ApiError && err.code === "rate_limited") flash(`${err.message}`);
    else handle(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Search";
  }
}

function statusFor(pushedAt) {
  if (!pushedAt) return ["Quiet", "status-quiet"];
  const days = (Date.now() - new Date(pushedAt)) / 86_400_000;
  if (days <= 30) return ["Active", "status-active"];
  if (days <= 365) return ["Recent", "status-recent"];
  return ["Quiet", "status-quiet"];
}

const LEVEL = {
  all_keywords: "every word matched",
  key_terms_plus: "key terms and some descriptive words matched",
  key_terms: "fewer than ten matched every word, so these match every key term",
  most_key_terms: "fewer than ten matched every word, so these match most key terms",
};

function renderResults(d) {
  const meta = $("results-meta");
  const list = $("results");
  if (!d.items.length) {
    meta.replaceChildren(
      el("strong", { text: "No projects found." }),
      ` Try fewer or different words${d.query.minStars > 10 ? `, or a lower minimum than ${fmt.format(d.query.minStars)} stars` : ""}.`,
    );
    list.hidden = true;
    $("pager").hidden = true;
    return;
  }
  const bits = [
    el("strong", { text: `${fmt.format(d.total)} ${d.total === 1 ? "project" : "projects"}` }),
    ` with ${fmt.format(d.query.minStars)}+ stars, ${LEVEL[d.matchLevel] ?? ""}. Best matches first, then by stars.`,
  ];
  if (d.query.keyTerms.length) bits.push(el("span", { class: "quiet", text: ` Key terms: ${d.query.keyTerms.join(", ")}.` }));
  if (d.query.context?.length) bits.push(el("span", { class: "quiet", text: ` Context, not searched: ${d.query.context.join("; ")}.` }));
  if (d.query.ignored.length) bits.push(el("span", { class: "quiet", text: ` Ignored: ${d.query.ignored.join(" ")}.` }));
  for (const n of d.query.notes) bits.push(el("span", { class: "quiet", text: ` ${n}` }));
  if (d.rateLimit?.remaining != null) bits.push(el("span", { class: "quiet", text: ` ${d.rateLimit.remaining} GitHub searches left this minute.` }));
  meta.replaceChildren(...bits);

  const head = el(
    "div",
    { class: "dep-head", "aria-hidden": "true" },
    el("span", { text: "Repository" }),
    el("span", { class: "col-stars", text: "Stars" }),
    el("span", { class: "col-lang", text: "Language" }),
    el("span", { class: "col-lic", text: "Licence" }),
    el("span", { text: "Activity" }),
  );
  const rows = d.items.map((it, i) => {
    const [status, cls] = statusFor(it.pushedAt);
    const url = safeUrl(it.url);
    const home = safeUrl(it.homepage);
    const row = el(
      "div",
      { class: `dep${i === 0 ? " is-open" : ""}`, role: "listitem" },
      el("button", { class: "dep-toggle", type: "button", "aria-expanded": String(i === 0), "aria-label": `${it.name}, ${fmt.format(it.stars)} stars` }),
      el("span", { text: it.name }),
      el("span", { class: "num col-stars", text: fmt.format(it.stars) }),
      el("span", { class: "dim col-lang", text: it.language ?? "—" }),
      el("span", { class: "dim col-lic", text: it.license ?? "No licence" }),
      el("span", { class: `dep-status ${cls}`, text: it.archived ? "Archived" : status }),
      el(
        "span",
        { class: "dep-detail" },
        it.description ?? "No description.",
        it.topics.length ? el("span", { class: "topics", text: it.topics.slice(0, 8).join(" · ") }) : null,
        el(
          "span",
          { class: "dep-links" },
          url ? el("a", { class: "link", href: url, target: "_blank", rel: "noopener noreferrer", text: "Open on GitHub" }) : null,
          home ? el("a", { class: "link", href: home, target: "_blank", rel: "noopener noreferrer", text: "Website" }) : null,
        ),
      ),
    );
    row.querySelector(".dep-toggle").addEventListener("click", () => {
      for (const r of list.querySelectorAll(".dep")) {
        const on = r === row && !r.classList.contains("is-open");
        r.classList.toggle("is-open", on);
        r.querySelector(".dep-toggle")?.setAttribute("aria-expanded", String(on));
      }
    });
    return row;
  });
  list.replaceChildren(head, ...rows);
  list.hidden = false;
  $("ex-h").textContent = "More examples";
  stagger(rows, "dep-in");

  $("pager").hidden = !(d.page > 1 || d.hasMore);
  $("prev").disabled = d.page <= 1;
  $("next").disabled = !d.hasMore;
  $("page-label").textContent = `Page ${d.page}`;
}

// ---------- Connect ----------

let selectedAgent = AGENTS[0].id;

function renderConnect() {
  const url = mcpUrl();
  $("mcp-url").textContent = url;
  const key = lastKey ?? PLACEHOLDER_KEY;
  $("connect-key-note").replaceChildren(
    ...(lastKey
      ? ["Snippets below include the key you just created. Treat them like a password."]
      : ["Snippets use a placeholder. ", el("a", { class: "link", href: "#keys", text: "Create a key" }), " and they fill in automatically."]),
  );
  const tabs = $("agent-tabs");
  const buttons = AGENTS.map((a) => {
    const b = el(
      "button",
      { class: "agent-tab", type: "button", role: "tab", id: `tab-${a.id}`, "aria-selected": String(a.id === selectedAgent), "aria-controls": "agent-panel", tabindex: a.id === selectedAgent ? "0" : "-1" },
      markSvg(a.id),
      a.name,
    );
    b.addEventListener("click", () => {
      selectedAgent = a.id;
      renderConnect();
      $(`tab-${a.id}`).focus();
    });
    return b;
  });
  tabs.replaceChildren(...buttons);
  const a = AGENTS.find((x) => x.id === selectedAgent);
  $("agent-panel").setAttribute("aria-labelledby", `tab-${a.id}`);
  $("code-file").replaceChildren(markSvg(a.id), a.file);
  renderCode($("code-block"), a.snippet(url, key));
  $("code-note").textContent = a.note;
  $("copy-code").textContent = "Copy";
  $("curl-test").textContent = `curl -s -H "Authorization: Bearer ${key}" \\\n  "${location.origin}/v1/search?q=terminal+file+manager+in+rust&per_page=3"`;
}

$("agent-tabs").addEventListener("keydown", (e) => {
  const i = AGENTS.findIndex((a) => a.id === selectedAgent);
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  selectedAgent = AGENTS[(i + step + AGENTS.length) % AGENTS.length].id;
  renderConnect();
  $(`tab-${selectedAgent}`).focus();
});

$("copy-code").addEventListener("click", async () => {
  const ok = await copyText($("code-block").textContent, $("code-block"));
  $("copy-code").textContent = ok ? "Copied" : "Press Ctrl+C";
});

// ---------- Keys ----------

async function loadKeys() {
  try {
    const { keys } = await api("/api/keys");
    keysLoaded = true;
    renderKeys(keys);
    decorateKeyRows();
  } catch (err) {
    handle(err);
  }
}

function ago(ts) {
  if (!ts) return "never used";
  const s = (Date.now() - ts) / 1000;
  if (s < 3600) return "used in the last hour";
  if (s < 86400) return `used ${Math.floor(s / 3600)} h ago`;
  return `used ${Math.floor(s / 86400)} d ago`;
}

function renderKeys(keys) {
  const keyIcon = () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M14.5 3a6.5 6.5 0 0 0-6.2 8.4L3 16.7V21h4.3v-2.2h2.2v-2.2h2.2l1.4-1.4A6.5 6.5 0 1 0 14.5 3zm2 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z");
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return el("span", { class: "key-ico" }, svg);
  };
  const rows = keys.map((k) =>
    el(
      "li",
      { class: "key-row", "data-key": k.id },
      keyIcon(),
      el(
        "div",
        { class: "key-main" },
        el("div", { class: "key-top" }, el("span", { class: "key-name", text: k.name }), el("code", { class: "key-prefix", text: `${k.prefix}…` })),
        el("span", { class: "key-meta", text: `Created ${new Date(k.createdAt).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })} · ${ago(k.lastUsedAt)}` }),
      ),
      el("button", { class: "btn btn-small key-revoke", type: "button", text: "Revoke", onclick: () => revoke(k) }),
    ),
  );
  $("keys-count").textContent = String(keys.length);
  $("key-rows").replaceChildren(...rows);
  $("keys-empty").hidden = keys.length > 0;
  stagger(rows, "dep-in");
}

$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("key-name");
  const name = input.value.trim();
  if (!name) return;
  clearFlash();
  try {
    const created = await api("/api/keys", { method: "POST", body: JSON.stringify({ name }) });
    input.value = "";
    lastKey = created.key;
    $("new-key-value").textContent = created.key;
    $("new-key").hidden = false;
    $("copy-key").textContent = "Copy";
    await loadKeys();
  } catch (err) {
    handle(err);
  }
});

$("copy-key").addEventListener("click", async () => {
  const ok = await copyText($("new-key-value").textContent, $("new-key-value"));
  $("copy-key").textContent = ok ? "Copied" : "Press Ctrl+C";
});

async function revoke(k) {
  const ok = await confirmDialog(`Revoke ${k.name}?`, "Anything using this key stops working within a minute.", "Revoke key");
  if (!ok) return;
  try {
    await api(`/api/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
    if (lastKey && lastKey.startsWith(k.prefix)) {
      lastKey = null;
      $("new-key").hidden = true;
    }
    await loadKeys();
  } catch (err) {
    handle(err);
  }
}

// ---------- Account ----------

$("delete-account").addEventListener("click", async () => {
  const ok = await confirmDialog("Delete your account?", "Your keys stop working immediately and Code Search's access to GitHub is revoked.", "Delete account");
  if (!ok) return;
  try {
    await api("/api/account/delete", { method: "POST" });
    location.href = "/";
  } catch (err) {
    handle(err);
  }
});

// ---------- Examples and prompts ----------

for (const b of document.querySelectorAll("[data-example]")) {
  b.addEventListener("click", () => {
    $("q").value = b.dataset.q;
    $("language").value = b.dataset.language || "";
    $("min-stars").value = b.dataset.stars || "100";
    $("include-archived").checked = false;
    $("search-form").scrollIntoView({ behavior: "smooth", block: "start" });
    runSearch(1);
  });
}

for (const b of document.querySelectorAll("[data-prompt]")) {
  b.addEventListener("click", async () => {
    const p = b.parentElement.querySelector("p");
    const ok = await copyText(p.textContent.replace(/^“|”$/g, ""), p);
    b.textContent = ok ? "Copied" : "Press Ctrl+C";
    setTimeout(() => (b.textContent = "Copy"), 1600);
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  if ($("view-search").hidden) return;
  e.preventDefault();
  $("q").focus();
});

initChrome();
init();
