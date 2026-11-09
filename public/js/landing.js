// Landing page: the live parser (Code Search's real query code running in the browser), the recorded
// results window, ticket stack, typing demo, rate-limit simulator, agent setup tabs, pricing toggle,
// smooth FAQ and the hero search that carries your query through GitHub sign-in.

import { parseQuery, buildQuery, DEFAULT_MIN_STARS } from "/lib/query.js";
import { AGENTS, mcpUrl, markSvg, copyText, showAgentPrompt, PLACEHOLDER_KEY } from "/js/agents.js";
import { initChrome, stagger, session, registrationOpen, reduced } from "/js/motion.js";
import { renderCode } from "/js/code.js";

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("en");
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}+#._-]*/gu;
export const PENDING_KEY = "cs:pending-query";

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

let demo = null;
let currentPreset = 0;

// ---------- Live parser ----------

function presetIndexFor(text) {
  if (!demo) return -1;
  const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return demo.searches.findIndex((s) => norm(s.input) === norm(text));
}

function renderParse() {
  const input = $("demo-q").value;
  const idx = presetIndexFor(input);
  const minStars = idx >= 0 ? demo.searches[idx].minStars : DEFAULT_MIN_STARS;
  const parsed = parseQuery(input);

  const chips = (list, cls) =>
    list.length ? list.map((w) => el("span", { class: `chip ${cls}`, text: w })) : [el("span", { class: "chip chip-none", text: "none" })];

  const used = new Set(parsed.keywords.flatMap((k) => [k, ...k.split(/[\s-]+/)]));
  for (const q of parsed.qualifiers) for (const m of `${q.key}:${q.value}`.toLowerCase().matchAll(WORD_RE)) used.add(m[0]);
  const dropped = [...new Set([...input.toLowerCase().matchAll(WORD_RE)].map((m) => m[0].replace(/[._-]+$/, "")))].filter((w) => w && !used.has(w));

  const keyNodes = chips(parsed.core, "chip-key");
  const softNodes = chips(parsed.soft, "chip-soft");
  $("parse-key").replaceChildren(...keyNodes);
  $("parse-soft").replaceChildren(...softNodes);
  $("parse-drop").replaceChildren(...chips(dropped, "chip-drop"));
  stagger([...keyNodes, ...softNodes], "chip-in");

  const queryNode = $("parse-query");
  if (!parsed.keywords.length && !parsed.qualifiers.length) {
    queryNode.textContent = "Type what the project should do.";
  } else {
    try {
      const q = buildQuery(parsed, { minStars, language: null, includeArchived: false }, "strict");
      queryNode.replaceChildren(
        ...q.split(" ").flatMap((part, i) => [i ? " " : "", el("span", { class: /^-?[a-z-]+:/.test(part) ? "q-qual" : "q-key", text: part })]),
        el("span", { class: "q-qual", text: " sort=stars" }),
      );
    } catch (err) {
      queryNode.textContent = err.message;
    }
  }

  const top = $("parse-top");
  document.querySelectorAll(".preset").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.preset) === idx)));
  if (idx >= 0) {
    const s = demo.searches[idx];
    const first = s.items[0];
    top.replaceChildren(
      "Top match: ",
      el("strong", {}, el("a", { class: "link", href: "#results", text: first.name })),
      `, ${fmt.format(first.stars)} stars, first of ${s.total} results below.`,
    );
    if (idx !== currentPreset) {
      currentPreset = idx;
      renderBoard();
    }
  } else {
    top.replaceChildren("That is exactly what Code Search would ask GitHub. Press Search to run it live on your own account.");
  }
}

function initParser() {
  const input = $("demo-q");
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(renderParse, 120);
  });
  for (const b of document.querySelectorAll(".preset")) {
    b.addEventListener("click", () => {
      input.value = demo.searches[Number(b.dataset.preset)].input;
      renderParse();
    });
  }
  renderParse();
}

function initFinder() {
  session.then((user) => {
    if (user) $("go-label").textContent = "Search live";
  });
  $("finder").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("demo-q").value.trim();
    try {
      if (q) sessionStorage.setItem(PENDING_KEY, q);
    } catch {
      // storage blocked: the dashboard just opens empty
    }
    if (await session) location.href = "/app/#search";
    else location.href = (await registrationOpen) ? "/auth/login" : "/app/";
  });
}

// ---------- Results window ----------

function statusFor(pushedAt, recordedAt) {
  if (!pushedAt) return ["Quiet", "status-quiet"];
  const days = (new Date(recordedAt) - new Date(pushedAt)) / 86_400_000;
  if (days <= 30) return ["Active", "status-active"];
  if (days <= 365) return ["Recent", "status-recent"];
  return ["Quiet", "status-quiet"];
}

const LEVEL = {
  all_keywords: "every word matched",
  key_terms_plus: "key terms and some descriptive words matched",
  key_terms: "every key term matched",
  most_key_terms: "most key terms matched",
};

function renderBoard() {
  const s = demo.searches[currentPreset];
  $("board-caption").replaceChildren(
    el("strong", { text: `“${s.input}”` }),
    ` · ${s.total} repositories with ${fmt.format(s.minStars)}+ stars, ${LEVEL[s.matchLevel]}, ranked by stars. `,
    el("span", { class: "quiet", text: `Recorded from GitHub on ${new Date(demo.recordedAt).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" })}.` }),
  );
  const head = el(
    "div",
    { class: "dep-head", "aria-hidden": "true" },
    el("span", { text: "Repository" }),
    el("span", { class: "col-stars", text: "Stars" }),
    el("span", { class: "col-lang", text: "Language" }),
    el("span", { class: "col-lic", text: "Licence" }),
    el("span", { text: "Activity" }),
  );
  const rows = s.items.slice(0, 6).map((it, i) => {
    const [status, cls] = statusFor(it.pushedAt, demo.recordedAt);
    const row = el(
      "button",
      { class: `dep${i === 0 ? " is-open" : ""}`, type: "button", role: "listitem", "aria-expanded": String(i === 0) },
      el("span", { text: it.name }),
      el("span", { class: "num col-stars", text: fmt.format(it.stars) }),
      el("span", { class: "dim col-lang", text: it.language ?? "—" }),
      el("span", { class: "dim col-lic", text: it.license ?? "No licence" }),
      el("span", { class: `dep-status ${cls}`, text: status }),
      el(
        "span",
        { class: "dep-detail" },
        it.description ?? "No description.",
        el("span", { class: "topics", text: [it.topics.join(" · "), it.url.replace("https://", "")].filter(Boolean).join("   ·   ") }),
      ),
    );
    row.addEventListener("click", () => {
      for (const r of $("departures").querySelectorAll(".dep")) {
        const open = r === row && !r.classList.contains("is-open");
        r.classList.toggle("is-open", open);
        r.setAttribute("aria-expanded", String(open));
      }
    });
    return row;
  });
  $("departures").replaceChildren(head, ...rows);
  stagger(rows, "dep-in");
}

// ---------- Tickets: dim the card underneath, typing demo ----------

function initTickets() {
  const tickets = [...document.querySelectorAll(".ticket")];
  if (tickets.length && !reduced) {
    let ticking = false;
    const update = () => {
      ticking = false;
      for (let i = 0; i < tickets.length - 1; i++) {
        const a = tickets[i].getBoundingClientRect();
        const b = tickets[i + 1].getBoundingClientRect();
        tickets[i].classList.toggle("is-under", b.top < a.bottom - 60);
      }
    };
    addEventListener("scroll", () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    }, { passive: true });
    update();
  }

  const typing = $("typing");
  if (!typing || reduced) return;
  const phrases = ["terminal file manager written in rust", "self-hosted kanban board with markdown", "convert pdf tables to excel"];
  let p = 0;
  let c = phrases[0].length;
  let dir = -1;
  let visible = false;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(typing);
  const step = () => {
    if (visible) {
      c += dir;
      if (c <= 0) {
        dir = 1;
        p = (p + 1) % phrases.length;
      }
      typing.textContent = phrases[p].slice(0, Math.max(0, c));
      if (c >= phrases[p].length) {
        dir = -1;
        return setTimeout(step, 1800);
      }
    }
    setTimeout(step, dir > 0 ? 55 : 22);
  };
  setTimeout(step, 1800);
}

// ---------- Showcase tabs ----------

function initShowcase() {
  const tabs = [...document.querySelectorAll("#show-tabs span")];
  if (!tabs.length || reduced) return;
  let i = 0;
  let visible = false;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(tabs[0].parentElement);
  setInterval(() => {
    if (!visible) return;
    i = (i + 1) % tabs.length;
    tabs.forEach((t, j) => t.classList.toggle("is-on", j === i));
  }, 1700);
}

// ---------- Rate-limit simulator ----------

function initMeter() {
  const cellsBox = $("meter-cells");
  if (!cellsBox) return;
  const LIMIT = 30;
  const cells = Array.from({ length: LIMIT }, () => el("i"));
  cellsBox.replaceChildren(...cells);
  const QUERIES = [
    "notion alternative I can self host", "terminal file manager in rust", "pdf tables to excel", "markdown kanban board",
    "time series forecasting library", "self-hosted web analytics", "headless cms for next.js", "vector database in go",
    "static site generator", "open source password manager", "react drag and drop", "rust http client",
    "local llm chat ui", "terminal music player", "screen recorder for linux", "feature flag service",
  ];
  let used = 0;
  let hits = 0;
  let next = 0;
  let resetAt = Date.now() + 60_000;
  const cache = [];

  const log = (text, cls) => {
    const list = $("m-log");
    const t = new Date().toLocaleTimeString("en-GB", { minute: "2-digit", second: "2-digit" });
    list.prepend(el("li", {}, el("span", { class: "t", text: t }), el("span", { class: cls, text })));
    while (list.children.length > 4) list.lastChild.remove();
  };
  const paint = () => {
    cells.forEach((c, i) => c.classList.toggle("is-used", i < used));
    $("m-left").textContent = String(Math.max(0, LIMIT - used));
    $("m-hits").textContent = String(hits);
  };
  const fresh = () => {
    const q = QUERIES[next++ % QUERIES.length];
    const cost = Math.random() < 0.7 ? 1 : 2 + Math.floor(Math.random() * 3);
    if (used + cost > LIMIT) {
      log(`429 rate_limited · retry in ${Math.ceil((resetAt - Date.now()) / 1000)}s`, "stop");
      return;
    }
    used += cost;
    if (!cache.includes(q)) cache.push(q);
    log(`“${q}” · ${cost} GitHub call${cost > 1 ? "s" : ""}`, "miss");
    paint();
  };
  const repeat = () => {
    if (!cache.length) return fresh();
    const q = cache[Math.floor(Math.random() * cache.length)];
    hits++;
    log(`“${q}” · cached, 0 calls`, "hit");
    paint();
  };
  $("m-new").addEventListener("click", fresh);
  $("m-repeat").addEventListener("click", repeat);
  $("m-burst").addEventListener("click", () => {
    for (let i = 0; i < 10; i++) setTimeout(fresh, i * 90);
  });
  setInterval(() => {
    const left = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
    $("m-reset").textContent = String(left);
    if (left <= 0) {
      resetAt = Date.now() + 60_000;
      if (used) log("new minute · 30 searches back", "hit");
      used = 0;
      paint();
    }
  }, 1000);
  paint();
}

// ---------- Connect tabs ----------

function initConnect() {
  const url = mcpUrl();
  $("mcp-url").textContent = url;
  const tabs = $("agent-tabs");
  const buttons = AGENTS.map((a, i) => {
    const b = el(
      "button",
      { class: "agent-tab", type: "button", role: "tab", id: `tab-${a.id}`, "aria-selected": String(i === 0), "aria-controls": "agent-panel", tabindex: i === 0 ? "0" : "-1" },
      markSvg(a.id),
      a.name,
    );
    b.addEventListener("click", () => select(a.id));
    return b;
  });
  tabs.replaceChildren(...buttons);
  tabs.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = (i + step + buttons.length) % buttons.length;
    select(AGENTS[n].id);
    buttons[n].focus();
  });

  function select(id) {
    const a = AGENTS.find((x) => x.id === id) ?? AGENTS[0];
    buttons.forEach((b, i) => {
      const on = AGENTS[i].id === a.id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $("agent-panel").setAttribute("aria-labelledby", `tab-${a.id}`);
    $("code-file").replaceChildren(markSvg(a.id), a.file);
    renderCode($("code-block"), a.snippet(url, PLACEHOLDER_KEY));
    $("code-note").textContent = `${a.note} Replace ${PLACEHOLDER_KEY} with a key from your dashboard.`;
    showAgentPrompt(a);
    $("copy-code").textContent = "Copy";
    stagger([$("code-block")], "chip-in");
  }

  $("copy-code").addEventListener("click", async () => {
    const ok = await copyText($("code-block").textContent, $("code-block"));
    $("copy-code").textContent = ok ? "Copied" : "Press Ctrl+C";
  });
  select(AGENTS[0].id);
}

// ---------- Pricing toggle ----------

function initBilling() {
  const buttons = [...document.querySelectorAll("[data-bill]")];
  const thumb = $("bill-thumb");
  if (!buttons.length) return;
  const place = (b) => {
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.transform = `translateX(${b.offsetLeft}px)`;
  };
  const notes = { month: "no card, no trial", year: "save $0. still free." };
  const set = (b) => {
    buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    place(b);
    const period = b.dataset.bill;
    for (const p of document.querySelectorAll("[data-per]")) p.textContent = period === "year" ? "/ year" : "/ month";
    const note = $("bill-note");
    note.textContent = notes[period];
    note.classList.remove("is-pop");
    void note.offsetWidth;
    note.classList.add("is-pop");
  };
  buttons.forEach((b) => b.addEventListener("click", () => set(b)));
  requestAnimationFrame(() => place(buttons[0]));
  document.fonts?.ready.then(() => place(buttons.find((b) => b.getAttribute("aria-pressed") === "true")));
  addEventListener("resize", () => place(buttons.find((b) => b.getAttribute("aria-pressed") === "true")));
}

// ---------- FAQ: smooth open and close ----------

export function initDetails(root = document) {
  for (const d of root.querySelectorAll(".qa details")) {
    const summary = d.querySelector("summary");
    const body = d.querySelector(".answer");
    let anim = null;
    summary.addEventListener("click", (e) => {
      if (reduced) return;
      e.preventDefault();
      anim?.cancel();
      if (d.open) {
        anim = body.animate([{ height: `${body.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
        d.classList.add("is-closing");
        anim.onfinish = () => {
          d.open = false;
          d.classList.remove("is-closing");
        };
      } else {
        d.open = true;
        anim = body.animate([{ height: "0px", opacity: 0 }, { height: `${body.scrollHeight}px`, opacity: 1 }], { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      }
    });
  }
}

// ---------- Start ----------

initChrome();
initFinder();
initTickets();
initShowcase();
initMeter();
initConnect();
initBilling();
initDetails();
fetch("/data/demo.json")
  .then((r) => r.json())
  .then((data) => {
    demo = data;
    renderBoard();
    initParser();
  })
  .catch(() => {
    $("board-caption").textContent = "Recorded results could not be loaded.";
  });
