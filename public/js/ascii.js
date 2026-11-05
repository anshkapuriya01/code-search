// ASCII effects in the Firecrawl manner.
//  - <pre class="ascii" data-ascii="ground|cloud">: a slowly drifting character field, drawn as text
//    only while on screen (about 12 frames a second).
//  - <figure class="photo" data-scan>: the photo first appears as orange ASCII, then a scan line
//    sweeps it away to the full-resolution image. Under a fine pointer, characters trail the cursor.
// The real photo is always drawn underneath at full resolution; the effects sit on top.

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const RAMP = " .,:-=+*x#%";

function charSize(pre) {
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(20);
  probe.style.visibility = "hidden";
  pre.append(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  return { w: r.width / 20 || 6.6, h: parseFloat(getComputedStyle(pre).lineHeight) || 11.5 };
}

function field(mode, cols, rows, t) {
  let out = "";
  for (let y = 0; y < rows; y++) {
    const fy = y / Math.max(1, rows - 1);
    for (let x = 0; x < cols; x++) {
      const fx = x / cols;
      let v;
      if (mode === "ground") {
        const wave = Math.sin(x * 0.16 + t * 0.8 + Math.sin(y * 0.35 + t * 0.35) * 1.6) * 0.5 + 0.5;
        const wave2 = Math.sin(x * 0.05 - t * 0.45 + y * 0.22) * 0.5 + 0.5;
        v = Math.pow(fy, 1.5) * (0.35 + 0.45 * wave + 0.3 * wave2);
      } else {
        const a = Math.sin(fx * 9 + t * 0.5) * Math.cos(fy * 7 - t * 0.35);
        const b = Math.sin((fx + fy) * 13 - t * 0.6) * 0.5;
        const c = Math.cos(fx * 23 + fy * 5 + t * 0.9) * 0.25;
        v = (a + b + c + 1.2) / 2.6;
        v = v > 0.52 ? (v - 0.52) * 2.4 : 0;
      }
      const i = Math.max(0, Math.min(RAMP.length - 1, Math.floor(v * RAMP.length)));
      out += RAMP[i];
    }
    out += "\n";
  }
  return out;
}

export function initAscii() {
  const pres = [...document.querySelectorAll("pre.ascii[data-ascii]")];
  if (!pres.length) return;
  const items = pres.map((pre) => ({ pre, mode: pre.dataset.ascii, visible: false, cols: 0, rows: 0 }));
  const measure = (it) => {
    const { w, h } = charSize(it.pre);
    const r = it.pre.getBoundingClientRect();
    it.cols = Math.min(260, Math.ceil(r.width / w));
    it.rows = Math.min(80, Math.ceil(r.height / h));
  };
  items.forEach(measure);
  const draw = (t) => {
    for (const it of items) if (it.visible || reduced) it.pre.textContent = field(it.mode, it.cols, it.rows, t);
  };
  draw(0);
  if (reduced) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const it = items.find((x) => x.pre === e.target);
      if (it) it.visible = e.isIntersecting;
    }
  });
  items.forEach((it) => io.observe(it.pre));
  let last = 0;
  const loop = (now) => {
    if (now - last > 85 && !document.hidden) {
      last = now;
      draw(now / 1000);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  let rt;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => items.forEach(measure), 200);
  });
}

// ---------- Photo scan ----------

function sampleImage(img, cols, rows, w, h) {
  // object-fit: cover mapping of the image into the figure box, sampled one pixel per cell
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const ir = img.naturalWidth / img.naturalHeight;
  const br = w / h;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  let sx = 0;
  let sy = 0;
  if (ir > br) {
    sw = sh * br;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = sw / br;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cols, rows);
  const data = ctx.getImageData(0, 0, cols, rows).data;
  const lum = new Float32Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) lum[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  return lum;
}

function setupScan(fig) {
  const img = fig.querySelector("img");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  fig.append(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(1.5, devicePixelRatio || 1);
  const CELL = 10;
  let W = 0;
  let H = 0;
  let cols = 0;
  let rows = 0;
  let lum = null;
  let order = null;
  const font = `${Math.round(CELL * 1.05)}px "Geist Mono", ui-monospace, monospace`;

  const size = () => {
    const r = fig.getBoundingClientRect();
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(W / CELL);
    rows = Math.ceil(H / CELL);
    lum = sampleImage(img, cols, rows, W, H);
    order = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) order[y * cols + x] = (x / cols) * 0.72 + Math.random() * 0.28;
  };

  const cellChar = (i) => RAMP[Math.max(1, Math.min(RAMP.length - 1, Math.floor((1 - lum[i]) * RAMP.length)))];

  const drawCell = (i, alpha, edge) => {
    const x = (i % cols) * CELL;
    const y = Math.floor(i / cols) * CELL;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = edge ? "#fd5c11" : "#f7f3ef";
    ctx.fillRect(x, y, CELL, CELL);
    ctx.fillStyle = edge ? "#fff4ed" : `rgba(194, 65, 12, ${0.35 + (1 - lum[i]) * 0.65})`;
    ctx.fillText(cellChar(i), x + CELL / 2, y + CELL / 2 + 0.5);
  };

  const prep = () => {
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
  };

  // 1) reveal sweep
  const reveal = () => {
    size();
    prep();
    const dur = 1300;
    const start = performance.now();
    const frame = (now) => {
      const p = Math.min(1, (now - start) / dur);
      fig.classList.add("is-live");
      ctx.clearRect(0, 0, W, H);
      const n = cols * rows;
      for (let i = 0; i < n; i++) {
        const d = order[i] - p * 1.12 + 0.06;
        if (d < 0) continue;
        drawCell(i, 1, d < 0.05);
      }
      ctx.globalAlpha = 1;
      if (p < 1) requestAnimationFrame(frame);
      else {
        ctx.clearRect(0, 0, W, H);
        fig.classList.add("is-scanned");
      }
    };
    requestAnimationFrame(frame);
  };

  // 2) pointer trail
  const hot = new Map();
  let running = false;
  const trail = () => {
    const now = performance.now();
    ctx.clearRect(0, 0, W, H);
    for (const [i, t0] of hot) {
      const age = (now - t0) / 650;
      if (age >= 1) {
        hot.delete(i);
        continue;
      }
      drawCell(i, (1 - age) * 0.9, age < 0.08);
    }
    ctx.globalAlpha = 1;
    if (hot.size) requestAnimationFrame(trail);
    else running = false;
  };
  if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
    fig.addEventListener("pointermove", (e) => {
      if (!fig.classList.contains("is-scanned") || !lum) return;
      const r = fig.getBoundingClientRect();
      const cx = Math.floor((e.clientX - r.left) / CELL);
      const cy = Math.floor((e.clientY - r.top) / CELL);
      const now = performance.now();
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          if (dx * dx + dy * dy > 10 || Math.random() < 0.35) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          hot.set(y * cols + x, now - Math.random() * 200);
        }
      if (!running) {
        running = true;
        prep();
        requestAnimationFrame(trail);
      }
    });
  }
  let rt;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (fig.classList.contains("is-scanned")) {
        size();
        prep();
      }
    }, 200);
  });

  const ready = img.complete && img.naturalWidth ? Promise.resolve() : new Promise((r) => img.addEventListener("load", r, { once: true }));
  ready.then(() => (document.fonts?.ready ?? Promise.resolve())).then(reveal);
}

export function initScans() {
  const figs = [...document.querySelectorAll("figure.photo[data-scan]")];
  if (!figs.length) return;
  if (reduced || !("IntersectionObserver" in window)) {
    figs.forEach((f) => f.classList.add("is-in", "is-live"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        e.target.classList.add("is-in");
        const img = e.target.querySelector("img");
        if (img?.loading === "lazy") img.loading = "eager";
        setupScan(e.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
  );
  figs.forEach((f) => io.observe(f));
}
