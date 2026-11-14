// Explorer map: Web Mercator, CARTO dark tiles, fire grid, state and district
// boundaries with names. Click a district to select it, or drag a rectangle.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import { ember, fmt, showTip, hideTip } from "./viz.js";

const merc = (lat, lon) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
};
const unmerc = (x, y) => [
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI, x * 360 - 180];

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
function ringsBox(rings) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const r of rings) for (const [x, y] of r) { s = Math.min(s, y); n = Math.max(n, y); w = Math.min(w, x); e = Math.max(e, x); }
  return [s, w, n, e];
}

export function createMap(root, meta, { onSelect, describe, districts }) {
  const canvas = root.querySelector("canvas");
  const tiles = root.querySelector(".tiles"), labels = root.querySelector(".labels");
  const hint = root.querySelector(".hint");
  const d = meta.cellDeg, half = d / 2;
  const cellIndex = new Map(meta.cells.map(([la, lo], i) => [`${la.toFixed(2)},${lo.toFixed(2)}`, i]));
  const D = districts?.districts || [], S = districts?.states || [];
  const focus = new Set(districts?.focus || []);
  D.forEach((x) => (x.box = ringsBox(x.rings)));
  let heat = new Float32Array(meta.cells.length), max = 1, selection = null, hover = -1;
  let drag = null, proj, ctx, W, H, paths = null;

  // the view: the focus states if known, else the data
  let ext;
  if (focus.size) {
    const boxes = S.filter((s) => focus.has(s.name)).map((s) => ringsBox(s.rings));
    ext = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
           Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  } else {
    ext = [meta.extent[0] - half, meta.extent[1] - half, meta.extent[2] + half, meta.extent[3] + half];
  }
  ext = [ext[0] - 0.12, ext[1] - 0.12, ext[2] + 0.12, ext[3] + 0.12];

  function layout() {
    ({ ctx, W, H } = setupCanvas(canvas));
    proj = fit(ext, W, H, W < 700 ? { l: 10, r: 10, t: 58, b: 112 } : { l: 230, r: 150, t: 16, b: 16 });
    placeTiles(tiles, "dark_nolabels");
    placeTiles(labels, "dark_only_labels");
    paths = buildPaths();
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

  function path(rings) {
    const p = new Path2D();
    for (const r of rings) r.forEach(([lon, lat], i) => {
      const [x, y] = proj.px(lat, lon);
      i ? p.lineTo(x, y) : p.moveTo(x, y);
    });
    return p;
  }
  function buildPaths() {
    return { states: S.map((s) => ({ name: s.name, p: path(s.rings), focus: focus.has(s.name),
                                     box: ringsBox(s.rings) })),
             districts: D.map((x) => path(x.rings)) };
  }

  const selectedCell = (i) => {
    if (!selection) return true;
    if (selection.kind === "districts") return selection.ids.has(districts.cellDistrict[i]);
    const [s, w, n, e] = selection.bbox, [la, lo] = meta.cells[i];
    return la >= s && la <= n && lo >= w && lo <= e;
  };

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // fire grid; cells outside the selection are dimmed
    const lm = Math.log1p(max);
    meta.cells.forEach(([la, lo], i) => {
      const v = heat[i];
      if (!(v > 0)) return;
      const [x0, y0] = proj.px(la + half, lo - half);
      const [x1, y1] = proj.px(la - half, lo + half);
      ctx.globalAlpha = selectedCell(i) ? 1 : 0.22;
      ctx.fillStyle = ember(0.18 + 0.82 * (Math.log1p(v) / lm));
      ctx.fillRect(x0 + 0.4, y0 + 0.4, Math.max(1, x1 - x0 - 0.8), Math.max(1, y1 - y0 - 0.8));
    });
    ctx.globalAlpha = 1;
    if (paths) {
      // districts, then states on top
      ctx.lineJoin = "round";
      paths.districts.forEach((p, i) => {
        const sel = selection?.kind === "districts" && selection.ids.has(i) && selection.ids.size < 6;
        if (i === hover) { ctx.fillStyle = "rgba(92,200,242,0.12)"; ctx.fill(p, "evenodd"); }
        ctx.strokeStyle = sel ? "#eef3fb" : i === hover ? "#5cc8f2" : "rgba(170,205,255,0.32)";
        ctx.lineWidth = sel ? 2 : i === hover ? 1.6 : 0.7;
        ctx.stroke(p);
      });
      for (const s of paths.states) {
        ctx.strokeStyle = s.focus ? "rgba(225,238,255,0.8)" : "rgba(200,220,255,0.4)";
        ctx.lineWidth = s.focus ? 1.6 : 1.1;
        ctx.stroke(s.p);
      }
      drawLabels();
    }
    // a drawn rectangle: dim outside, outline inside
    const b = drag ? drag.bbox : selection?.kind === "bbox" ? selection.bbox : null;
    if (b) {
      const [x0, y0] = proj.px(b[2], b[1]), [x1, y1] = proj.px(b[0], b[3]);
      ctx.save();
      ctx.fillStyle = "rgba(3,9,21,0.5)";
      ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.fill("evenodd");
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
      if (small && !(focus.has(x.state) && x.cells > 0)) return;
      const [px, py] = proj.px(x.label[0], x.label[1]);
      text(x.name, px, py, `500 ${small ? 10 : 11}px 'Instrument Sans', system-ui, sans-serif`,
           focus.has(x.state) ? "rgba(210,226,248,0.92)" : "rgba(165,179,204,0.7)");
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
    const key = `${(Math.floor(lat / d) * d + half).toFixed(2)},${(Math.floor(lon / d) * d + half).toFixed(2)}`;
    const ci = cellIndex.get(key);
    const cellHtml = ci !== undefined && heat[ci] > 0
      ? `<div class="r"><span>This 10 km cell</span><b>${fmt(heat[ci])} fire-days</b></div>` : "";
    if (di >= 0) {
      showTip(e, `<div class="t">${D[di].name}${D[di].state ? `, ${D[di].state}` : ""}</div>${describe(di)}${cellHtml}<div class="r muted">Click to select this district</div>`);
    } else if (cellHtml) {
      showTip(e, `<div class="t">${lat.toFixed(2)}°N, ${lon.toFixed(2)}°E</div>${cellHtml}`);
    } else hideTip();
  });
  canvas.addEventListener("pointerleave", () => { hideTip(); if (hover !== -1) { hover = -1; draw(); } });
  canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const { moved, bbox: b } = drag;
    drag = null;
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
    setHeat(values) {
      heat = values;
      max = 1; for (const v of values) if (v > max) max = v;
      if (ctx) draw();
      return max;
    },
    setSelection(sel) {
      selection = sel.kind === "districts" ? { kind: "districts", ids: new Set(sel.ids) } : sel;
      if (ctx) draw();
    },
  };
}
