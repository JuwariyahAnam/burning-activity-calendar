// Explorer map: Web Mercator, CARTO dark tiles, canvas fire grid.
// No map library, so the page works with one small set of files.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import { ember, fmt, showTip, hideTip } from "./viz.js";

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
