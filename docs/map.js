// Map and hero renderers: Web Mercator, CARTO dark tiles, canvas fire grid.
// No map library, so the page works with one small set of files.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import { ember, fmt, showTip, hideTip, reduceMotion, MONTH_NAMES } from "./viz.js";
import { dayToDate } from "./engine.js";

const merc = (lat, lon) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
};
const unmerc = (x, y) => [
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI, x * 360 - 180];

// Fit [south, west, north, east] into a W x H box with padding.
function fit(ext, W, H, pad) {
  const [x0, y1] = merc(ext[0], ext[1]);
  const [x1, y0] = merc(ext[2], ext[3]);
  const scale = Math.min((W - pad.l - pad.r) / (x1 - x0), (H - pad.t - pad.b) / (y1 - y0));
  const ox = pad.l + (W - pad.l - pad.r - (x1 - x0) * scale) / 2 - x0 * scale;
  const oy = pad.t + (H - pad.t - pad.b - (y1 - y0) * scale) / 2 - y0 * scale;
  return {
    scale,
    px: (lat, lon) => { const [x, y] = merc(lat, lon); return [x * scale + ox, y * scale + oy]; },
    ll: (px, py) => unmerc((px - ox) / scale, (py - oy) / scale),
    world: (x, y) => [x * scale + ox, y * scale + oy],
  };
}

function setupCanvas(canvas) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H, dpr };
}

// ------------------------------------------------------------------ map
export function createMap(root, meta, { onSelect }) {
  const canvas = root.querySelector("canvas");
  const tiles = root.querySelector(".tiles"), labels = root.querySelector(".labels");
  const hint = root.querySelector(".hint");
  const d = meta.cellDeg, half = d / 2;
  const cellIndex = new Map(meta.cells.map(([la, lo], i) => [`${la.toFixed(2)},${lo.toFixed(2)}`, i]));
  let heat = new Float32Array(meta.cells.length), max = 1;
  let bbox = meta.bbox, drag = null, proj, ctx, W, H;
  const ext = [Math.min(meta.extent[0], meta.bbox[0]) - half - 0.15,
               Math.min(meta.extent[1], meta.bbox[1]) - half - 0.15,
               Math.max(meta.extent[2], meta.bbox[2]) + half + 0.15,
               Math.max(meta.extent[3], meta.bbox[3]) + half + 0.15];

  function layout() {
    ({ ctx, W, H } = setupCanvas(canvas));
    proj = fit(ext, W, H, { l: 16, r: 16, t: 16, b: 16 });
    placeTiles(tiles, "dark_nolabels");
    placeTiles(labels, "dark_only_labels");
    draw();
  }

  function placeTiles(layer, style) {
    layer.replaceChildren();
    const z = Math.max(2, Math.min(12, Math.floor(Math.log2(proj.scale / 256))));
    const n = 2 ** z, size = proj.scale / n;
    const [lat0, lon0] = proj.ll(0, H), [lat1, lon1] = proj.ll(W, 0);
    const [tx0, ty1] = merc(lat0, lon0).map((v) => Math.floor(v * n));
    const [tx1, ty0] = merc(lat1, lon1).map((v) => Math.floor(v * n));
    const retina = devicePixelRatio > 1 ? "@2x" : "";
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      const img = new Image();
      img.alt = ""; img.decoding = "async"; img.loading = "lazy";
      const [x, y] = proj.world(tx / n, ty / n);
      Object.assign(img.style, { left: `${x}px`, top: `${y}px`, width: `${size + 0.5}px`,
                                 height: `${size + 0.5}px` });
      img.onerror = () => img.remove();
      img.src = `https://${"abcd"[(tx + ty) % 4]}.basemaps.cartocdn.com/${style}/${z}/${tx}/${ty}${retina}.png`;
      layer.appendChild(img);
    }
  }

  function rectPx(b) {
    const [x0, y0] = proj.px(b[2], b[1]);
    const [x1, y1] = proj.px(b[0], b[3]);
    return [x0, y0, x1 - x0, y1 - y0];
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const lm = Math.log1p(max);
    meta.cells.forEach(([la, lo], i) => {
      const v = heat[i];
      if (!(v > 0)) return;
      const [x0, y0] = proj.px(la + half, lo - half);
      const [x1, y1] = proj.px(la - half, lo + half);
      ctx.fillStyle = ember(0.18 + 0.82 * (Math.log1p(v) / lm));
      ctx.fillRect(x0 + 0.4, y0 + 0.4, Math.max(1, x1 - x0 - 0.8), Math.max(1, y1 - y0 - 0.8));
    });
    const b = drag ? drag.bbox : bbox;
    if (b) {
      const [x, y, w, h] = rectPx(b);
      ctx.save();
      ctx.fillStyle = "rgba(4,6,12,0.58)";
      ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(x, y, w, h); ctx.fill("evenodd");
      ctx.strokeStyle = "#eef1f7"; ctx.lineWidth = 1.5;
      if (drag) ctx.setLineDash([6, 5]);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  }

  const toLL = (e) => {
    const r = canvas.getBoundingClientRect();
    return proj.ll(e.clientX - r.left, e.clientY - r.top);
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { start: toLL(e), x: e.clientX, y: e.clientY, bbox: null };
    hideTip();
  });
  canvas.addEventListener("pointermove", (e) => {
    const [lat, lon] = toLL(e);
    if (drag) {
      const [la0, lo0] = drag.start;
      drag.bbox = [Math.min(la0, lat), Math.min(lo0, lon), Math.max(la0, lat), Math.max(lo0, lon)];
      draw();
      return;
    }
    const key = `${(Math.floor(lat / d) * d + half).toFixed(2)},${(Math.floor(lon / d) * d + half).toFixed(2)}`;
    const i = cellIndex.get(key);
    if (i === undefined || !(heat[i] > 0)) return hideTip();
    showTip(e, `<div class="t">${meta.cells[i][0].toFixed(2)}°N, ${meta.cells[i][1].toFixed(2)}°E</div><div class="r"><span>Fire-days</span><b>${fmt(heat[i])}</b></div>`);
  });
  canvas.addEventListener("pointerleave", hideTip);
  canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const moved = Math.abs(e.clientX - drag.x) > 8 && Math.abs(e.clientY - drag.y) > 8;
    const b = drag.bbox;
    drag = null;
    if (moved && b) {
      const snap = (v, f) => +(f(v / d) * d).toFixed(4);
      bbox = [snap(b[0], Math.floor), snap(b[1], Math.floor), snap(b[2], Math.ceil), snap(b[3], Math.ceil)];
      hint.textContent = "Drag again to change the area";
      onSelect(bbox);
    }
    draw();
  });

  new ResizeObserver(() => layout()).observe(root);
  return {
    setHeat(values) {
      heat = values;
      max = 1; for (const v of values) if (v > max) max = v;
      if (ctx) draw();
    },
    setBBox(b) { bbox = b; if (ctx) draw(); },
  };
}

// ----------------------------------------------------------------- hero
// Replays a year: each frame shows the cells that burned on that date,
// brighter where they burned on that date in more years.
export function createHero(canvas, meta, rows, { monthEl, trackEl }) {
  const d = meta.cellDeg, half = d / 2;
  const byDoy = Array.from({ length: 366 }, () => new Map());
  const doyOf = new Map();
  const years = new Set();
  for (let i = 0; i < rows.day.length; i++) {
    const day = rows.day[i];
    let info = doyOf.get(day);
    if (!info) {
      const dt = dayToDate(meta, day);
      const start = Date.UTC(dt.getUTCFullYear(), 0, 1);
      info = [Math.min(364, Math.floor((dt - start) / 86400000)), dt.getUTCFullYear()];
      doyOf.set(day, info);
    }
    years.add(info[1]);
    const m = byDoy[info[0]];
    m.set(rows.cell[i], (m.get(rows.cell[i]) || 0) + 1);
  }
  const nYears = Math.max(1, years.size);
  const lists = byDoy.map((m) => [...m.entries()]);
  trackEl.replaceChildren(...MONTH_NAMES.map(() => document.createElement("span")));

  let ctx, W, H, proj, cell = 2, doy = 0, last = 0, running = false, visible = true, month = -1;
  function layout() {
    ({ ctx, W, H } = setupCanvas(canvas));
    // keep the fire clear of the headline: right half on wide screens, below it on phones
    const copy = canvas.parentElement.querySelector(".hero-copy");
    const pad = W >= 960
      ? { l: W * 0.52, r: W * 0.05, t: 52 + H * 0.08, b: H * 0.2 }
      : { l: W * 0.06, r: W * 0.06, t: copy.offsetTop + copy.offsetHeight + 28, b: 130 };
    proj = fit(meta.extent, W, H, pad);
    const [a] = proj.px(0, 0), [b] = proj.px(0, d);
    cell = Math.max(1.6, (b - a) * 0.9);
    ctx.fillStyle = "#04060c"; ctx.fillRect(0, 0, W, H);
    if (reduceMotion) drawYear();
  }
  function dot(c, n, alphaScale = 1) {
    const [la, lo] = meta.cells[c];
    const [x, y] = proj.px(la, lo);
    const t = n / nYears;
    ctx.globalAlpha = Math.min(1, (0.25 + 0.75 * t) * alphaScale);
    ctx.fillStyle = ember(0.35 + 0.65 * t);
    ctx.beginPath(); ctx.arc(x, y, Math.min(9, cell * (0.55 + 0.6 * t)), 0, Math.PI * 2); ctx.fill();
  }
  function drawYear() {       // static picture for reduced motion
    ctx.globalCompositeOperation = "lighter";
    for (const list of lists) for (const [c, n] of list) dot(c, n, 0.08);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    monthEl.textContent = "The whole year";
  }
  function frame(t) {
    if (!running) return;
    const dt = Math.min(64, t - (last || t)); last = t;
    doy = (doy + dt * 0.026) % 365;      // about 14 seconds per year
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(4,6,12,0.09)"; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const [c, n] of lists[Math.floor(doy)]) dot(c, n);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    const m = dayToDate({ date0: "2001-01-01" }, Math.floor(doy)).getUTCMonth();
    if (m !== month) {
      month = m;
      monthEl.textContent = MONTH_NAMES[m];
      [...trackEl.children].forEach((s, i) => s.classList.toggle("on", i <= m));
    }
    requestAnimationFrame(frame);
  }
  const start = () => { if (!running && visible && !reduceMotion && !document.hidden) {
    running = true; last = 0; requestAnimationFrame(frame); } };
  const stop = () => { running = false; };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); })
    .observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  new ResizeObserver(() => { layout(); }).observe(canvas);
  layout();
  start();
}
