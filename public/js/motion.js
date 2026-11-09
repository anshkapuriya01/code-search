// Shared page chrome and motion: Lenis smooth scrolling, sticky-nav state, the full-screen menu,
// scroll reveals, the word-by-word reading highlight, count-ups, hand-drawn underlines, ASCII fields,
// photo scan reveals and signed-in links. Transform and opacity only; reduced motion skips travel.

import { initAscii, initScans } from "/js/ascii.js";

export const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
export let lenis = null;

/** Gives a list of new nodes a stagger index and an entrance class. */
export function stagger(nodes, className) {
  if (reduced) return;
  [...nodes].forEach((n, i) => {
    n.style.setProperty("--i", String(i));
    n.classList.remove(className);
    void n.offsetWidth; // restart the animation for re-rendered nodes
    n.classList.add(className);
  });
}

/** Scrolls to an element, smoothly when Lenis runs. Lenis already honours scroll-padding-top. */
export function scrollToEl(target) {
  if (lenis) lenis.scrollTo(target, { duration: 1.1 });
  else target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

function initLenis() {
  if (reduced || typeof window.Lenis !== "function") return;
  lenis = new window.Lenis({ lerp: 0.12, smoothWheel: true, syncTouch: false });
  const raf = (t) => {
    lenis.raf(t);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const url = new URL(a.href, location.href);
    if (url.pathname !== location.pathname || !url.hash || url.origin !== location.origin) return;
    const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (!target) return;
    e.preventDefault();
    lenis.scrollTo(target, { duration: 1.1 });
    history.pushState(null, "", url.hash);
  });
  if (location.hash) {
    const t = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (t) setTimeout(() => lenis.scrollTo(t, { immediate: true }), 60);
  }
}

function initNav() {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const update = () => nav.classList.toggle("is-stuck", window.scrollY > 8);
  update();
  window.addEventListener("scroll", update, { passive: true });

  const menu = document.getElementById("menu");
  const open = document.getElementById("menu-open");
  const close = document.getElementById("menu-close");
  if (!menu || !open) return;
  let timer;
  const setOpen = (on) => {
    clearTimeout(timer);
    open.setAttribute("aria-expanded", String(on));
    if (on) {
      menu.hidden = false;
      requestAnimationFrame(() => menu.classList.add("is-open"));
      lenis?.stop();
      document.documentElement.style.overflow = "hidden";
      close?.focus();
    } else {
      menu.classList.remove("is-open");
      lenis?.start();
      document.documentElement.style.overflow = "";
      timer = setTimeout(() => (menu.hidden = true), 280);
    }
  };
  open.addEventListener("click", () => setOpen(true));
  close?.addEventListener("click", () => {
    setOpen(false);
    open.focus();
  });
  menu.addEventListener("click", (e) => {
    if (e.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      setOpen(false);
      open.focus();
    }
  });
}

function countUp(el) {
  const target = Number(el.dataset.count);
  if (!Number.isFinite(target) || reduced) return;
  const start = performance.now();
  const dur = 1100;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(target * eased).toLocaleString("en");
    if (t < 1) requestAnimationFrame(tick);
  };
  el.textContent = "0";
  requestAnimationFrame(tick);
}

/** Wraps every word of [data-read] paragraphs, then lights them as the paragraph scrolls past. */
function initReading() {
  const paras = [...document.querySelectorAll("[data-read]")];
  if (!paras.length || reduced) return;
  const wrap = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = child.textContent.split(/(\s+)/);
        const frag = document.createDocumentFragment();
        for (const p of parts) {
          if (!p) continue;
          if (/^\s+$/.test(p)) frag.append(document.createTextNode(p));
          else {
            const s = document.createElement("span");
            s.className = "w";
            s.textContent = p;
            frag.append(s);
          }
        }
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === "CODE") child.classList.add("w");
        else if (child.tagName !== "svg") wrap(child);
      }
    }
  };
  const sets = paras.map((p) => {
    wrap(p);
    return { p, words: [...p.querySelectorAll(".w")], lit: 0 };
  });
  let ticking = false;
  const update = () => {
    ticking = false;
    const vh = innerHeight;
    for (const s of sets) {
      const r = s.p.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, (vh * 0.86 - r.top) / (r.height + vh * 0.3)));
      const lit = Math.round(progress * s.words.length);
      if (lit === s.lit) continue;
      s.words.forEach((w, i) => w.classList.toggle("is-lit", i < lit));
      s.lit = lit;
    }
  };
  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update();
}

function initReveals() {
  for (const el of document.querySelectorAll("[data-i]")) el.style.setProperty("--i", el.dataset.i);
  const hero = document.querySelector(".hero");
  if (hero) requestAnimationFrame(() => hero.classList.add("is-in"));
  for (const el of document.querySelectorAll(".hero .rise")) requestAnimationFrame(() => el.classList.add("is-in"));

  const targets = [...document.querySelectorAll(".rise, [data-count], [data-draw], .viz-stars")].filter((el) => !el.closest(".hero"));
  if (!("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        if (e.target.dataset.count) countUp(e.target);
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  targets.forEach((el) => io.observe(el));
}

/** One check per page view: who is signed in, and whether new users may sign up. */
const authState = (async () => {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const body = await res.json().catch(() => null);
    return { user: res.ok ? (body?.user ?? null) : null, registrationOpen: body?.registrationOpen !== false };
  } catch {
    return { user: null, registrationOpen: true };
  }
})();

/** Resolves to the signed-in user or null. */
export const session = authState.then((s) => s.user);
/** Resolves to false when new sign-ups are closed. */
export const registrationOpen = authState.then((s) => s.registrationOpen);

function hideSignups() {
  // The dashboard has its own closed state, including the way back in for existing users.
  if (document.body.classList.contains("app")) return;
  for (const a of document.querySelectorAll('a[href="/auth/login"], .announce')) a.classList.add("signup-closed");
  const banner = document.createElement("p");
  banner.className = "closed-banner";
  banner.setAttribute("role", "status");
  const link = document.createElement("a");
  link.className = "link";
  link.href = "/app/";
  link.textContent = "Open your dashboard";
  banner.append("New sign-ups are closed for now. Already have an account? ", link);
  document.body.prepend(banner);
}

// Swaps sign-in links for dashboard links, or hides them while sign-ups are closed.
function reflectSession() {
  authState.then(({ user, registrationOpen: open }) => {
    if (!user && !open) hideSignups();
    if (!user) return;
    for (const a of document.querySelectorAll("[data-auth]")) {
      a.href = a.dataset.auth === "announce" ? "/app/#search" : "/app/";
      const label = a.querySelector("span") ?? a;
      if (a.dataset.auth === "signin") a.textContent = "Dashboard";
      else if (a.dataset.auth === "announce") label.textContent = `Signed in as ${user.login}. Open your dashboard and search.`;
      else if (a.dataset.auth === "start") label.textContent = "Open dashboard";
    }
  });
}

export function initChrome() {
  initLenis();
  initNav();
  initReveals();
  initReading();
  initAscii();
  initScans();
  reflectSession();
}
