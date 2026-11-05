// Dashboard Usage view: when and how often each key called Code Search, from GET /api/usage.
// Hourly counts from the server are regrouped here in the visitor's local time. DOM nodes only
// (no innerHTML); bar heights and tooltip position are set through CSSOM, which the CSP allows.

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("en");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ENDPOINTS = [
  ["mcp_search", "MCP", "search_repositories"],
  ["mcp_readme", "MCP", "get_repository_readme"],
  ["rest_search", "REST", "GET /v1/search"],
  ["rest_readme", "REST", "GET /v1/repos/…/readme"],
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

export async function fetchUsage(days) {
  const res = await fetch(`/api/usage?days=${days}`, { credentials: "same-origin" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Usage could not be loaded (${res.status}).`);
  return body;
}

const keyLabel = (data, id) => (id === "web" ? "Dashboard (browser)" : data.keys.find((k) => k.id === id)?.name ?? "Revoked key");
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const startOfLocalDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const hourLabel = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (t) => new Date(t).toLocaleDateString("en", { day: "numeric", month: "short" });
function whenLabel(t) {
  const today = startOfLocalDay(Date.now());
  const day = startOfLocalDay(t);
  const d = day === today ? "Today" : day === today - DAY ? "Yesterday" : new Date(t).toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short" });
  return `${d}, ${hourLabel(t)}`;
}

function sum(rows) {
  const t = { calls: 0, ok: 0, errors: 0, limited: 0, cached: 0 };
  for (const r of rows) for (const k in t) t[k] += r[k];
  return t;
}

/** Buckets: hourly for 24 hours, otherwise one per local day. */
function buckets(data, rows) {
  const out = [];
  if (data.days === 1) {
    const last = Math.floor(data.now / HOUR) * HOUR;
    for (let i = 23; i >= 0; i--) out.push({ start: last - i * HOUR, end: last - i * HOUR + HOUR, label: hourLabel(last - i * HOUR), tip: whenLabel(last - i * HOUR) });
  } else {
    const today = startOfLocalDay(data.now);
    for (let i = data.days - 1; i >= 0; i--) {
      const start = startOfLocalDay(today - i * DAY + HOUR * 2); // DST-safe step back
      out.push({ start, end: startOfLocalDay(start + DAY + HOUR * 2), label: dayLabel(start), short: new Date(start).toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short" }), tip: new Date(start).toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long" }) });
    }
  }
  for (const b of out) b.t = sum(rows.filter((r) => r.hour >= b.start && r.hour < b.end));
  return out;
}

// ---------- Rendering ----------

function stat(label, value, note, cls = "") {
  return el("div", { class: `ustat ${cls}` }, el("p", { class: "ustat-k", text: label }), el("p", { class: "ustat-v", text: value }), el("p", { class: "ustat-n", text: note }));
}

function renderStats(data, rows, bs) {
  const t = sum(rows);
  const peak = bs.reduce((a, b) => (b.t.calls > a.t.calls ? b : a), bs[0]);
  const lastHour = rows.reduce((m, r) => (r.calls && r.hour > m ? r.hour : m), 0);
  const range = data.days === 1 ? "last 24 hours" : `last ${data.days} days`;
  $("usage-stats").replaceChildren(
    stat("API calls", fmt.format(t.calls), range, "is-main"),
    stat("Success rate", t.calls ? `${pct(t.ok, t.calls)}%` : "—", `${fmt.format(t.errors)} errors`),
    stat("Rate-limited", fmt.format(t.limited), t.limited ? "answered 429, wait sent" : "never hit a limit"),
    stat("From cache", t.calls ? `${pct(t.cached, t.calls)}%` : "—", "no GitHub quota used"),
    stat(data.days === 1 ? "Busiest hour" : "Busiest day", peak?.t.calls ? fmt.format(peak.t.calls) : "—", peak?.t.calls ? (peak.short ?? peak.tip) : "no calls yet"),
    stat("Last call", lastHour ? whenLabel(lastHour) : "—", lastHour ? "to the hour" : "none in range"),
  );
  return t;
}

function renderChart(data, bs) {
  const max = Math.max(1, ...bs.map((b) => b.t.calls));
  const nice = niceMax(max);
  $("chart-h").textContent = data.days === 1 ? "Calls per hour" : "Calls per day";
  const every = bs.length <= 8 ? 1 : bs.length <= 31 ? Math.ceil(bs.length / 8) : 15;
  const cols = bs.map((b, i) => {
    const col = el("div", { class: "col", tabindex: "0", "aria-label": `${b.tip}: ${b.t.calls} calls, ${b.t.errors} errors, ${b.t.limited} rate-limited` });
    const bar = el("div", { class: "bar" });
    bar.style.setProperty("--h", `${(b.t.calls / nice) * 100}%`);
    for (const [k, cls] of [["limited", "s-lim"], ["errors", "s-err"], ["ok", "s-ok"]]) {
      if (!b.t[k]) continue;
      const seg = el("i", { class: cls });
      seg.style.setProperty("--p", `${(b.t[k] / b.t.calls) * 100}%`);
      bar.append(seg);
    }
    col.append(bar, el("span", { class: `xl${i % every === 0 || i === bs.length - 1 ? "" : " is-hidden"}`, text: b.label }));
    col.style.setProperty("--i", String(i));
    col.dataset.tip = JSON.stringify([b.tip, b.t.calls, b.t.ok, b.t.errors, b.t.limited, b.t.cached]);
    return col;
  });
  const grid = el(
    "div",
    { class: "ygrid", "aria-hidden": "true" },
    [nice, nice / 2, 0].map((v) => el("span", { text: fmt.format(Math.round(v)) })),
  );
  const plot = el("div", { class: `plot${bs.length > 40 ? " is-dense" : ""}` }, cols);
  $("usage-chart").replaceChildren(grid, plot, el("div", { class: "chart-tip", id: "chart-tip", hidden: true }));
}

function niceMax(n) {
  if (n <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

function initTooltip() {
  const chart = $("usage-chart");
  const show = (col) => {
    const tip = $("chart-tip");
    if (!tip || !col?.dataset.tip) return;
    const [when, calls, ok, errors, limited, cached] = JSON.parse(col.dataset.tip);
    tip.replaceChildren(
      el("b", { text: when }),
      el("span", { text: `${fmt.format(calls)} calls` }),
      el("span", { class: "t-ok", text: `${fmt.format(ok)} ok · ${fmt.format(cached)} cached` }),
      errors || limited ? el("span", { class: "t-err", text: `${fmt.format(errors)} errors · ${fmt.format(limited)} rate-limited` }) : null,
    );
    tip.hidden = false;
    const c = chart.getBoundingClientRect();
    const r = col.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2 - c.left, 90), c.width - 90);
    tip.style.setProperty("--x", `${x}px`);
    for (const o of chart.querySelectorAll(".col.is-hot")) o.classList.remove("is-hot");
    col.classList.add("is-hot");
  };
  const hide = () => {
    const tip = $("chart-tip");
    if (tip) tip.hidden = true;
    for (const o of chart.querySelectorAll(".col.is-hot")) o.classList.remove("is-hot");
  };
  chart.addEventListener("pointerover", (e) => show(e.target.closest(".col")));
  chart.addEventListener("focusin", (e) => show(e.target.closest(".col")));
  chart.addEventListener("pointerleave", hide);
  chart.addEventListener("focusout", hide);
}

function barRow(name, sub, value, total, extra) {
  const fill = el("i");
  fill.style.setProperty("--w", `${total ? (value / total) * 100 : 0}%`);
  return el(
    "li",
    { class: "brow" },
    el("div", { class: "brow-top" }, el("span", { class: "brow-name" }, name, sub ? el("code", { text: sub }) : null), el("b", { text: fmt.format(value) })),
    el("div", { class: "brow-bar" }, fill),
    extra ? el("p", { class: "brow-x", text: extra }) : null,
  );
}

function renderByKey(data, rows, total) {
  const ids = [...new Set(rows.map((r) => r.keyId))];
  const list = ids
    .map((id) => ({ id, t: sum(rows.filter((r) => r.keyId === id)), last: Math.max(...rows.filter((r) => r.keyId === id && r.calls).map((r) => r.hour)) }))
    .sort((a, b) => b.t.calls - a.t.calls);
  const box = $("usage-keys");
  if (!list.length) return box.replaceChildren(el("p", { class: "quiet", text: "No calls in this range." }));
  box.replaceChildren(
    el(
      "ul",
      { class: "brows" },
      list.map(({ id, t, last }) => {
        const k = data.keys.find((x) => x.id === id);
        return barRow(keyLabel(data, id), k?.prefix ? `${k.prefix}…` : null, t.calls, total, `${pct(t.calls, total)}% of calls · ${fmt.format(t.errors + t.limited)} failed · last ${whenLabel(last)}`);
      }),
    ),
  );
}

function renderByEndpoint(rows, total) {
  $("usage-endpoints").replaceChildren(
    el(
      "ul",
      { class: "brows" },
      ENDPOINTS.map(([id, kind, name]) => {
        const t = sum(rows.filter((r) => r.endpoint === id));
        return barRow(el("span", { class: `kind kind-${kind.toLowerCase()}`, text: kind }), name, t.calls, total, t.calls ? `${pct(t.ok, t.calls)}% ok · ${pct(t.cached, t.calls)}% cached` : null);
      }),
    ),
  );
}

function renderHeat(rows) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) {
    const d = new Date(r.hour);
    grid[(d.getDay() + 6) % 7][d.getHours()] += r.calls;
  }
  const max = Math.max(0, ...grid.flat());
  const level = (v) => (!v ? 0 : v / max > 0.75 ? 4 : v / max > 0.5 ? 3 : v / max > 0.25 ? 2 : 1);
  const head = el("div", { class: "heat-row heat-head", "aria-hidden": "true" }, el("span"), Array.from({ length: 24 }, (_, h) => el("span", { text: h % 3 === 0 ? String(h).padStart(2, "0") : "" })));
  const body = grid.map((hours, d) =>
    el(
      "div",
      { class: "heat-row" },
      el("span", { class: "heat-day", text: WEEKDAYS[d] }),
      hours.map((v, h) => el("i", { class: `l${level(v)}`, title: `${WEEKDAYS[d]} ${String(h).padStart(2, "0")}:00 · ${v} calls` })),
    ),
  );
  $("usage-heat").replaceChildren(head, ...body);
}

// ---------- Controller ----------

const state = { days: 7, key: "", data: null };

function render() {
  const data = state.data;
  if (!data) return;
  const rows = state.key ? data.rows.filter((r) => r.keyId === state.key) : data.rows;
  const bs = buckets(data, rows);
  const t = renderStats(data, rows, bs);
  renderChart(data, bs);
  renderByKey(data, rows, t.calls);
  renderByEndpoint(rows, t.calls);
  renderHeat(rows);
  $("usage-empty").hidden = data.rows.length > 0;
}

function fillKeys(data) {
  const sel = $("usage-key");
  const opts = [el("option", { value: "", text: "All keys" }), el("option", { value: "web", text: "Dashboard (browser)" })];
  for (const k of data.keys) opts.push(el("option", { value: k.id, text: k.revoked ? `Revoked key (${k.id.slice(0, 6)})` : k.name }));
  sel.replaceChildren(...opts);
  sel.value = [...sel.options].some((o) => o.value === state.key) ? state.key : "";
  state.key = sel.value;
}

let inflight = null;
export async function loadUsage(onError, { quiet = false } = {}) {
  if (inflight) return inflight;
  if (!quiet) $("usage-stats").classList.add("is-loading");
  inflight = (async () => {
    try {
      state.data = await fetchUsage(state.days);
      fillKeys(state.data);
      render();
      $("usage-updated").textContent = `Updated ${new Date().toLocaleTimeString("en-GB")}`;
    } catch (err) {
      $("usage-updated").textContent = "Could not refresh";
      if (!quiet) onError?.(err);
    } finally {
      $("usage-stats").classList.remove("is-loading");
      inflight = null;
    }
  })();
  return inflight;
}

const visible = () => !document.hidden && !$("view-usage").hidden;

let ready = false;
export function initUsage(onError) {
  if (ready) return loadUsage(onError);
  ready = true;
  $("usage-tz").textContent = `Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  for (const b of document.querySelectorAll("[data-days]")) {
    b.addEventListener("click", () => {
      state.days = Number(b.dataset.days);
      for (const o of document.querySelectorAll("[data-days]")) o.setAttribute("aria-pressed", String(o === b));
      loadUsage(onError);
    });
  }
  $("usage-key").addEventListener("change", () => {
    state.key = $("usage-key").value;
    render();
  });
  initTooltip();
  $("usage-refresh").addEventListener("click", () => loadUsage(onError));
  // live: refresh every 20 s while the tab is open, and when you come back to the page
  setInterval(() => visible() && loadUsage(onError, { quiet: true }), 20_000);
  document.addEventListener("visibilitychange", () => visible() && loadUsage(onError, { quiet: true }));
  return loadUsage(onError);
}

/** Adds "N calls in 7 days" and a 7-day spark to each row on the API keys tab. */
export async function decorateKeyRows() {
  let data;
  try {
    data = await fetchUsage(7);
  } catch {
    return;
  }
  const today = startOfLocalDay(data.now);
  for (const li of document.querySelectorAll(".key-row[data-key]")) {
    const rows = data.rows.filter((r) => r.keyId === li.dataset.key);
    const days = Array.from({ length: 7 }, (_, i) => {
      const start = startOfLocalDay(today - (6 - i) * DAY + HOUR * 2);
      return sum(rows.filter((r) => r.hour >= start && r.hour < start + DAY)).calls;
    });
    const total = days.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...days);
    const spark = el("span", { class: "spark7", "aria-hidden": "true" }, days.map((v) => {
      const i = el("i", { class: v ? "" : "is-zero" });
      i.style.setProperty("--h", `${Math.max(8, (v / max) * 100)}%`);
      return i;
    }));
    li.querySelector(".key-usage")?.remove();
    li.querySelector(".key-main").after(
      el("a", { class: "key-usage", href: "#usage", "data-usage-key": li.dataset.key, title: "Open this key's usage" }, spark, el("span", {}, el("b", { text: fmt.format(total) }), " calls · 7 days")),
    );
  }
  for (const a of document.querySelectorAll("[data-usage-key]")) a.addEventListener("click", () => (state.key = a.dataset.usageKey));
}
