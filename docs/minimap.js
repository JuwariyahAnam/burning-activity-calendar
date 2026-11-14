// District close-up map: opens when a district is clicked. Red dots mark where
// fires were detected; redder and brighter = more intense fire (mean fire
// radiative power), bigger = more detections at that spot.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import { fmt, showTip, hideTip } from "./viz.js";
import { merc, fit, setupCanvas, ringsBox } from "./map.js";

const RED = [[0, "#4a0a0e"], [0.3, "#8c1018"], [0.55, "#d01a22"], [0.78, "#ff3b2f"], [1, "#ffa070"]];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function red(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < RED.length - 1; i++) {
    const [a, ca] = RED[i], [b, cb] = RED[i + 1];
    if (t <= b) {
      const A = hex(ca), B = hex(cb), k = (t - a) / (b - a);
      return `rgb(${A.map((x, j) => Math.round(x + (B[j] - x) * k)).join(",")})`;
    }
  }
  return RED.at(-1)[1];
}
export const redGradient = `linear-gradient(90deg, ${RED.map(([, c]) => c).join(",")})`;

export function createMiniMap(panel, meta, districts, rows, { onToggle } = {}) {
  const $ = (sel) => panel.querySelector(sel);
  const canvas = $("canvas"), tiles = $(".tiles"), labels = $(".labels");
  const D = districts.districts;
  D.forEach((x) => (x.box ||= ringsBox(x.rings)));
  let hot = null, hotLoading = null, current = -1, mode = "latest", years = [0, 9999];
  let ctx, W, H, proj, dots = [];

  async function loadHot() {
    if (!meta.hotspots) return null;
    if (hot) return hot;
    hotLoading ||= fetch("data/hotspots.bin").then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => {
      if (!b) return null;
      const n = meta.hotspots.rows;
      hot = { cell: new Uint16Array(b, 0, n), n: new Uint16Array(b, 2 * n, n),
              frp: new Uint16Array(b, 4 * n, n), sub: new Uint8Array(b, 6 * n, n),
              year: new Uint8Array(b, 7 * n, n) };
      return hot;
    }).catch(() => null);
    return hotLoading;
  }

  // Spots for one district and year span: [{lat, lon, n, frp}]
  function spots(id, y0, y1) {
    const cd = districts.cellDistrict, out = new Map();
    if (hot) {
      const h = meta.hotspots, c = meta.cellDeg, f = h.fine;
      for (let i = 0; i < hot.cell.length; i++) {
        if (cd[hot.cell[i]] !== id) continue;
        const y = hot.year[i] + h.year0;
        if (y < y0 || y > y1) continue;
        const key = hot.cell[i] * 256 + hot.sub[i];
        let s = out.get(key);
        if (!s) {
          const [la, lo] = meta.cells[hot.cell[i]];
          const iy = Math.floor(hot.sub[i] / h.per), ix = hot.sub[i] % h.per;
          s = { lat: la - c / 2 + (iy + 0.5) * f, lon: lo - c / 2 + (ix + 0.5) * f, n: 0, frpSum: 0 };
          out.set(key, s);
        }
        s.n += hot.n[i]; s.frpSum += (hot.frp[i] / 10) * hot.n[i];
      }
      return [...out.values()].map((s) => ({ ...s, frp: s.frpSum / s.n, size: meta.hotspots.fine }));
    }
    // fallback without raw files: 10 km cells, intensity = fire-days
    const d0 = Math.round((Date.UTC(y0, 0, 1) - Date.parse(`${meta.date0}T00:00:00Z`)) / 864e5);
    const d1 = Math.round((Date.UTC(y1 + 1, 0, 1) - Date.parse(`${meta.date0}T00:00:00Z`)) / 864e5);
    for (let i = 0; i < rows.day.length; i++) {
      const c = rows.cell[i];
      if (cd[c] !== id || rows.day[i] < d0 || rows.day[i] >= d1) continue;
      const s = out.get(c) || { lat: meta.cells[c][0], lon: meta.cells[c][1], n: 0, frp: NaN, size: meta.cellDeg };
      s.n++; out.set(c, s);
    }
    return [...out.values()];
  }

  function placeTiles(layer, style) {
    layer.replaceChildren();
    const z = Math.max(4, Math.min(13, Math.floor(Math.log2(proj.scale / 256))));
    const n = 2 ** z, size = proj.scale / n;
    const [lat0, lon0] = proj.ll(0, H), [lat1, lon1] = proj.ll(W, 0);
    const [tx0, ty1] = merc(lat0, lon0).map((v) => Math.floor(v * n));
    const [tx1, ty0] = merc(lat1, lon1).map((v) => Math.floor(v * n));
    const retina = devicePixelRatio > 1 ? "@2x" : "";
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      const img = new Image();
      img.alt = ""; img.decoding = "async";
      const [x, y] = proj.world(tx / n, ty / n);
      Object.assign(img.style, { left: `${x}px`, top: `${y}px`, width: `${size + 0.5}px`, height: `${size + 0.5}px` });
      img.onerror = () => img.remove();
      img.src = `https://${"abcd"[(tx + ty) % 4]}.basemaps.cartocdn.com/${style}/${z}/${tx}/${ty}${retina}.png`;
      layer.appendChild(img);
    }
  }
  const ringPath = (rings) => {
    const p = new Path2D();
    for (const r of rings) r.forEach(([lon, lat], i) => {
      const [x, y] = proj.px(lat, lon);
      i ? p.lineTo(x, y) : p.moveTo(x, y);
    });
    return p;
  };

  function render() {
    if (current < 0) return;
    ({ ctx, W, H } = setupCanvas(canvas));
    const dist = D[current], b = dist.box;
    const padLat = (b[2] - b[0]) * 0.08, padLon = (b[3] - b[1]) * 0.08;
    proj = fit([b[0] - padLat, b[1] - padLon, b[2] + padLat, b[3] + padLon], W, H,
               { l: 10, r: 10, t: 10, b: 10 });
    placeTiles(tiles, "dark_nolabels");
    placeTiles(labels, "dark_only_labels");
    ctx.clearRect(0, 0, W, H);
    // dim everything outside the district, outline neighbours and the district
    const own = ringPath(dist.rings);
    ctx.save();
    ctx.fillStyle = "rgba(3,9,21,0.55)";
    ctx.beginPath(); ctx.rect(0, 0, W, H);
    ctx.fill(new Path2D(`M0,0H${W}V${H}H0Z`), "nonzero");
    ctx.globalCompositeOperation = "destination-out";
    ctx.fill(own, "evenodd");
    ctx.restore();
    ctx.lineJoin = "round";
    D.forEach((x, i) => {
      if (i === current || x.box[2] < b[0] - 1 || x.box[0] > b[2] + 1) return;
      ctx.strokeStyle = "rgba(170,205,255,0.28)"; ctx.lineWidth = 0.8; ctx.stroke(ringPath(x.rings));
    });
    ctx.strokeStyle = "#eef3fb"; ctx.lineWidth = 1.8; ctx.stroke(own);

    const [yA, yB] = mode === "latest" ? [years[1], years[1]] : years;
    const list = spots(current, yA, yB);
    const hasFrp = list.some((s) => Number.isFinite(s.frp));
    const vals = list.map((s) => (hasFrp ? s.frp : s.n)).filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] || 1;
    const lo = Math.log(q(0.05)), hi = Math.log(q(0.97));
    const nMax = Math.max(1, ...list.map((s) => s.n));
    const [ax] = proj.px(0, 0), [bx] = proj.px(0, list[0]?.size || 0.02);
    const spotPx = Math.max(2, bx - ax);
    dots = list.map((s) => {
      const [x, y] = proj.px(s.lat, s.lon);
      const v = hasFrp ? s.frp : s.n;
      const t = hi > lo ? (Math.log(Math.max(v, 1e-3)) - lo) / (hi - lo) : 1;
      const r = Math.max(1.4, Math.min(spotPx * 0.55, 8) * (0.45 + 0.55 * Math.sqrt(s.n / nMax)));
      return { ...s, x, y, r, t: Math.max(0, Math.min(1, t)) };
    }).sort((a, b) => a.t - b.t);                          // most intense drawn last, on top
    // glow, then solid cores
    ctx.globalCompositeOperation = "lighter";
    for (const d of dots) {
      ctx.globalAlpha = 0.1 + 0.22 * d.t;
      ctx.fillStyle = red(d.t);
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r * 1.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    for (const d of dots) {
      ctx.globalAlpha = 0.6 + 0.4 * d.t;
      ctx.fillStyle = red(d.t);
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    const total = list.reduce((s, x) => s + x.n, 0);
    const span = yA === yB ? `${yA}` : `${yA}–${yB}`;
    const sensor = !hot ? "10 km grid cells"
      : yB < meta.hotspots.switchYear ? "MODIS 1 km detections"
      : yA >= meta.hotspots.switchYear ? "VIIRS 375 m detections"
      : `MODIS before ${meta.hotspots.switchYear}, VIIRS after`;
    $(".mini-sub").textContent = `${span}. ${sensor}.`;
    $(".mini-stats").innerHTML = list.length
      ? `<b>${fmt(total)}</b> ${hot ? "fire detections" : "fire-days"} at <b>${fmt(list.length)}</b> spots` +
        (hasFrp ? `. Most intense spot: <b>${fmt(Math.max(...list.map((s) => s.frp)), 0)} MW</b> average.` : ".")
      : `No fires detected in ${span}.`;
    $(".mini-legend").innerHTML = hasFrp
      ? `<span>Lower</span><span class="bar" style="background:${redGradient}"></span><span>Higher fire intensity</span><span class="muted">Bigger dot: more detections</span>`
      : `<span>Fewer</span><span class="bar" style="background:${redGradient}"></span><span>More fire-days</span>`;
    $(".mini-legend").title = hasFrp ? "Intensity is the mean fire radiative power (FRP) of the detections at each spot, in megawatts." : "";
  }

  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 1e9;
    for (const d of dots) {
      const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (dd < bd && dd <= Math.max(d.r, 6) ** 2) { bd = dd; best = d; }
    }
    if (!best) return hideTip();
    showTip(e, `<div class="t">${best.lat.toFixed(3)}°N, ${best.lon.toFixed(3)}°E</div>` +
      `<div class="r"><span>${hot ? "Detections" : "Fire-days"}</span><b>${fmt(best.n)}</b></div>` +
      (Number.isFinite(best.frp) ? `<div class="r"><span>Average intensity</span><b>${fmt(best.frp, 1)} MW</b></div>` : ""));
  });
  canvas.addEventListener("pointerleave", hideTip);
  $(".mini-close").addEventListener("click", () => api.close());
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") api.close(); });
  $(".mini-years").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.v;
    $(".mini-years").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    render();
  });
  new ResizeObserver(() => { if (!panel.hidden) render(); }).observe(panel);

  const api = {
    async open(id, yearSpan) {
      current = id; years = yearSpan;
      const d = D[id];
      $(".mini-title").textContent = `${d.name}${d.state ? `, ${d.state}` : ""}`;
      $(".mini-years").querySelector('[data-v="latest"]').textContent = `${yearSpan[1]}`;
      $(".mini-years").querySelector('[data-v="span"]').textContent = `${yearSpan[0]}–${yearSpan[1]}`;
      panel.hidden = false;
      onToggle?.(panel.offsetWidth);
      $(".mini-close").focus({ preventScroll: true });
      await loadHot();
      render();
    },
    setYears(yearSpan) { years = yearSpan; if (!panel.hidden) api.open(current, yearSpan); },
    close() { if (panel.hidden) return; panel.hidden = true; current = -1; hideTip(); onToggle?.(0); },
    get isOpen() { return !panel.hidden; },
  };
  return api;
}
