// Docs: live origin in examples, agent setup tabs, copy buttons, scroll-spy navigation.

import { AGENTS, mcpUrl, markSvg, copyText, PLACEHOLDER_KEY } from "/js/agents.js";
import { initChrome, scrollToEl } from "/js/motion.js";
import { renderCode } from "/js/code.js";

const $ = (id) => document.getElementById(id);
const url = mcpUrl();

initChrome();

$("doc-mcp-url").textContent = url;
$("doc-curl").textContent = `curl -s -H "Authorization: Bearer $CODE_SEARCH_KEY" \\\n  "${location.origin}/v1/search?q=terminal+file+manager+in+rust&min_stars=500"`;
for (const c of document.querySelectorAll(".dark-code code")) renderCode(c, c.textContent, { numbered: false });

// ---------- Agent tabs ----------

let selected = AGENTS[0].id;
const tabs = $("agent-tabs");
const buttons = AGENTS.map((a) => {
  const b = document.createElement("button");
  b.className = "agent-tab";
  b.type = "button";
  b.id = `tab-${a.id}`;
  b.setAttribute("role", "tab");
  b.setAttribute("aria-controls", "agent-panel");
  b.append(markSvg(a.id), a.name);
  b.addEventListener("click", () => select(a.id));
  return b;
});
tabs.append(...buttons);

tabs.addEventListener("keydown", (e) => {
  const i = AGENTS.findIndex((a) => a.id === selected);
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  select(AGENTS[(i + step + AGENTS.length) % AGENTS.length].id);
  $(`tab-${selected}`).focus();
});

function select(id) {
  selected = id;
  const a = AGENTS.find((x) => x.id === id);
  buttons.forEach((b, i) => {
    const on = AGENTS[i].id === id;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  });
  $("agent-panel").setAttribute("aria-labelledby", `tab-${id}`);
  $("code-file").replaceChildren(markSvg(a.id), a.file);
  renderCode($("code-block"), a.snippet(url, PLACEHOLDER_KEY));
  $("code-note").textContent = a.note;
  $("copy-code").textContent = "Copy";
}

$("copy-code").addEventListener("click", async () => {
  const ok = await copyText($("code-block").textContent, $("code-block"));
  $("copy-code").textContent = ok ? "Copied" : "Press Ctrl+C";
});
select(selected);

// ---------- Copy buttons on code samples ----------

for (const btn of document.querySelectorAll("[data-copy]")) {
  btn.addEventListener("click", async () => {
    const code = btn.parentElement.querySelector("code");
    const ok = await copyText(code.textContent, code);
    btn.textContent = ok ? "Copied" : "Press Ctrl+C";
    setTimeout(() => (btn.textContent = "Copy"), 1600);
  });
}

// ---------- Scroll spy ----------

const links = new Map([...document.querySelectorAll("[data-spy]")].map((a) => [a.dataset.spy, a]));
const jump = $("docs-jump");
const sections = [...links.keys()].map((id) => $(id)).filter(Boolean);
let current = null;

function setCurrent(id) {
  if (id === current) return;
  current = id;
  for (const [k, a] of links) {
    a.classList.toggle("is-current", k === id);
    if (k === id) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
  if (jump) jump.value = id;
  const a = links.get(id);
  const navBox = a?.closest(".docs-nav");
  if (a && navBox && navBox.scrollHeight > navBox.clientHeight) navBox.scrollTo({ top: a.offsetTop - navBox.clientHeight / 2, behavior: "smooth" });
}

let ticking = false;
function spy() {
  ticking = false;
  const line = innerHeight * 0.3;
  let id = sections[0]?.id;
  for (const s of sections) if (s.getBoundingClientRect().top <= line) id = s.id;
  setCurrent(id);
}
addEventListener(
  "scroll",
  () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(spy);
    }
  },
  { passive: true },
);
spy();

jump?.addEventListener("change", () => {
  const t = $(jump.value);
  if (t) {
    scrollToEl(t);
    history.replaceState(null, "", `#${jump.value}`);
  }
});
