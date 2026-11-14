// Explorer map: state and district shapes with names, and red dots where fires
// were detected (redder = more intense). Click a district, or drag a rectangle.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import { showTip, hideTip } from "./viz.js";
import { drawDots } from "./hotspots.js";

export const merc = (lat, lon) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
};
const unmerc = (x, y) => [
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI, x * 360 - 180];

export function fit(ext, W, H, pad) {
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

export function setupCanvas(canvas) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H };
}

// even-odd point in polygon over all rings of a feature ([lon, lat] pairs)
export function inRings(rings, lon, lat) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
export function ringsBox(rings) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const r of rings) for (const [x, y] of r) { s = Math.min(s, y); n = Math.max(n, y); w = Math.min(w, x); e = Math.max(e, x); }
  return [s, w, n, e];
}

export function createMap(root, meta, { onSelect, describe, districts }) {
  const canvas = root.querySelector("canvas");
  const hint = root.querySelector(".hint");
  const D = districts?.districts || [], S = districts?.states || [];
  const focus = new Set(districts?.focus || []);
  const focusIds = new Set(districts?.focusIds || []);
  const byStates = (districts?.focusMode || "states") === "states";
  D.forEach((x) => (x.box ||= ringsBox(x.rings)));
  let dots = [], scaleT = () => 1, selection = null, hover = -1, flags = new Set();
  let drag = null, proj, ctx, W, H, paths = null, inset = 0, cache = null, dpr = 1;

  // the view: the focus states if known, else the data
  let ext;
  if (focusIds.size) {
    const boxes = byStates ? S.filter((s) => focus.has(s.name)).map((s) => ringsBox(s.rings))
                           : D.filter((d) => focusIds.has(d.id)).map((d) => d.box);
    ext = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
           Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  } else {
    const h = meta.cellDeg / 2;
    ext = [meta.extent[0] - h, meta.extent[1] - h, meta.extent[2] + h, meta.extent[3] + h];
  }
  ext = [ext[0] - 0.12, ext[1] - 0.12, ext[2] + 0.12, ext[3] + 0.12];

  function layout() {
    ({ ctx, W, H } = setupCanvas(canvas));
    dpr = Math.min(2, devicePixelRatio || 1);
    proj = fit(ext, W, H, W < 700 ? { l: 10, r: 10, t: 58, b: 112 }
      : inset ? { l: W - inset > 760 ? 230 : 20, r: inset + 24, t: 50, b: 16 } : { l: 230, r: 150, t: 16, b: 16 });
    paths = buildPaths();
    renderCache();
    draw();
  }

  function path(rings) {
    const p = new Path2D();
    for (const r of rings) r.forEach(([lon, lat], i) => {
      const [x, y] = proj.px(lat, lon);
      i ? p.lineTo(x, y) : p.moveTo(x, y);
    });
    return p;
  }
  function buildPaths() {
    return { states: S.map((s) => ({ name: s.name, p: path(s.rings), focus: byStates && focus.has(s.name) })),
             districts: D.map((x) => path(x.rings)) };
  }

  const inSelection = (d) => {
    if (!selection) return true;
    if (selection.kind === "districts") return selection.ids.has(d.district);
    const [s, w, n, e] = selection.bbox;
    return d.lat >= s && d.lat <= n && d.lon >= w && d.lon <= e;
  };

  // fires beyond the study area (other states, Pakistan) stay barely visible,
  // so the edge of the data box does not show as a square
  const outside = (d) => focusIds.size > 0 && !focusIds.has(d.district);

  // land shapes and fire dots: redrawn only when data, selection or size change
  function renderCache() {
    if (!proj) return;
    cache ||= document.createElement("canvas");
    cache.width = Math.round(W * dpr); cache.height = Math.round(H * dpr);
    const g = cache.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (paths) {
      for (const s of paths.states) {            // neighbours faint, focus states solid
        g.fillStyle = s.focus ? "#15294a" : "#0b1830";
        g.fill(s.p, "evenodd");
      }
      if (!byStates) {                            // part of a state: the chosen districts solid
        g.fillStyle = "#15294a";
        for (const i of focusIds) g.fill(paths.districts[i], "evenodd");
      }
      if (selection?.kind === "districts" && selection.ids.size < 6) {
        g.fillStyle = "#1d3963";
        for (const i of selection.ids) g.fill(paths.districts[i], "evenodd");
      }
    }
    const nMax = Math.max(1, ...dots.map((d) => d.n));
    const [ax] = proj.px(0, 0), [bx] = proj.px(0, dots[0]?.size || meta.cellDeg);
    const rMax = Math.max(1.6, Math.min(5, (bx - ax) * 0.75));
    drawDots(g, dots.map((d) => {
      const [x, y] = proj.px(d.lat, d.lon);
      return { x, y, t: scaleT(d), r: Math.max(0.9, rMax * (0.4 + 0.6 * Math.sqrt(d.n / nMax))),
               dim: inSelection(d) ? 1 : outside(d) ? 0.06 : 0.22 };
    }));
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (cache?.width && cache.height) ctx.drawImage(cache, 0, 0, W, H);
    if (paths) {
      ctx.lineJoin = "round";
      paths.districts.forEach((p, i) => {
        const sel = selection?.kind === "districts" && selection.ids.has(i) && selection.ids.size < 6;
        if (i === hover) { ctx.fillStyle = "rgba(92,200,242,0.10)"; ctx.fill(p, "evenodd"); }
        ctx.strokeStyle = sel ? "#eef3fb" : i === hover ? "#5cc8f2" : "rgba(170,205,255,0.22)";
        ctx.lineWidth = sel ? 2 : i === hover ? 1.6 : 0.6;
        ctx.stroke(p);
      });
      for (const s of paths.states) {
        ctx.strokeStyle = s.focus ? "rgba(200,222,255,0.75)" : "rgba(160,190,240,0.3)";
        ctx.lineWidth = s.focus ? 1.5 : 0.9;
        ctx.stroke(s.p);
      }
      // districts burning far more than usual: amber outline on top
      for (const i of flags) {
        if (!paths.districts[i]) continue;
        ctx.save();
        ctx.strokeStyle = "rgba(255,190,90,0.95)"; ctx.lineWidth = 2.2; ctx.setLineDash([5, 3]);
        ctx.stroke(paths.districts[i]);
        ctx.restore();
      }
      drawLabels();
    }
    const b = drag ? drag.bbox : selection?.kind === "bbox" ? selection.bbox : null;
    if (b) {
      const [x0, y0] = proj.px(b[2], b[1]), [x1, y1] = proj.px(b[0], b[3]);
      ctx.save();
      ctx.strokeStyle = "#eef3fb"; ctx.lineWidth = 1.5;
      if (drag) ctx.setLineDash([6, 5]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    }
  }

  // names: states first, then districts by size, skipping any that would overlap
  function drawLabels() {
    const placed = [];
    const fits = (x0, y0, x1, y1) => x0 > 4 && y0 > 4 && x1 < W - 4 && y1 < H - 4 &&
      placed.every(([a, b, c, e]) => x1 < a || x0 > c || y1 < b || y0 > e);
    const text = (str, x, y, font, color) => {
      ctx.font = font;
      const w = ctx.measureText(str).width, h = parseInt(font.match(/(\d+)px/)[1], 10);
      const box = [x - w / 2 - 3, y - h / 2 - 2, x + w / 2 + 3, y + h / 2 + 2];
      if (!fits(...box)) return;
      placed.push(box);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(3,9,21,0.85)"; ctx.strokeText(str, x, y);
      ctx.fillStyle = color; ctx.fillText(str, x, y);
    };
    for (const s of paths.states.filter((s) => s.focus)) {
      const st = S.find((x) => x.name === s.name);
      const big = st.rings.reduce((a, r) => (r.length > a.length ? r : a), []);
      const [lon, lat] = big.reduce((a, [x, y]) => [a[0] + x / big.length, a[1] + y / big.length], [0, 0]);
      const [x, y] = proj.px(lat, lon);
      text(s.name, x, y - 16, "600 15px 'Instrument Sans', system-ui, sans-serif", "rgba(238,243,251,0.95)");
    }
    const small = W < 600;
    [...D].sort((a, b) => b.cells - a.cells).forEach((x) => {
      if (!focusIds.has(x.id) || (small && !(x.cells > 0))) return;
      const [px, py] = proj.px(x.label[0], x.label[1]);
      text(x.name, px, py, `500 ${small ? 10 : 11}px 'Instrument Sans', system-ui, sans-serif`,
           "rgba(210,226,248,0.9)");
    });
  }

  const toLL = (e) => {
    const r = canvas.getBoundingClientRect();
    return proj.ll(e.clientX - r.left, e.clientY - r.top);
  };
  const districtAt = (lat, lon) => D.findIndex((x) =>
    lat >= x.box[0] && lat <= x.box[2] && lon >= x.box[1] && lon <= x.box[3] && inRings(x.rings, lon, lat));

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { start: toLL(e), x: e.clientX, y: e.clientY, bbox: null, moved: false };
    hideTip();
  });
  canvas.addEventListener("pointermove", (e) => {
    const [lat, lon] = toLL(e);
    if (drag) {
      drag.moved = drag.moved || (Math.abs(e.clientX - drag.x) > 6 && Math.abs(e.clientY - drag.y) > 6);
      if (!drag.moved) return;
      const [la0, lo0] = drag.start;
      drag.bbox = [Math.min(la0, lat), Math.min(lo0, lon), Math.max(la0, lat), Math.max(lo0, lon)];
      draw();
      return;
    }
    const di = districtAt(lat, lon);
    if (di !== hover) { hover = di; draw(); }
    if (di >= 0) {
      showTip(e, `<div class="t">${D[di].name}${D[di].state ? `, ${D[di].state}` : ""}</div>${describe(di)}<div class="r muted">Click for a close-up map</div>`);
    } else hideTip();
  });
  canvas.addEventListener("pointerleave", () => { hideTip(); if (hover !== -1) { hover = -1; draw(); } });
  canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const { moved, bbox: b } = drag;
    drag = null;
    const d = meta.cellDeg;
    if (moved && b) {
      const snap = (v, f) => +(f(v / d) * d).toFixed(4);
      onSelect({ kind: "bbox", bbox: [snap(b[0], Math.floor), snap(b[1], Math.floor),
                                      snap(b[2], Math.ceil), snap(b[3], Math.ceil)] });
      hint.textContent = "Drag again, or click a district";
    } else {
      const [lat, lon] = toLL(e);
      const di = districtAt(lat, lon);
      if (di >= 0) onSelect({ kind: "districts", ids: [di] });
    }
    draw();
  });

  new ResizeObserver(() => layout()).observe(root);
  return {
    setDots(list, scale) { dots = list; scaleT = scale; renderCache(); draw(); },
    // room on the right for the close-up panel (0 when it is closed)
    setInset(px) { if (px !== inset) { inset = px; if (ctx) layout(); } },
    setFlags(ids) { flags = new Set(ids); draw(); },
    setSelection(sel) {
      selection = sel.kind === "districts" ? { kind: "districts", ids: new Set(sel.ids) } : sel;
      renderCache(); draw();
    },
  };
}
