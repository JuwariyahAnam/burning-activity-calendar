// Fire spots for the maps: where fires were detected and how intense they were.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
//
// hotspots.bin (from build_site.py): detections grouped into small spots per
// year, one sensor per year, with the number of detections and mean fire
// radiative power (FRP, MW). Without it, 10 km grid cells stand in, with the
// number of fire-days as the measure.

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

let cached = null;
export function loadHotspots(meta) {
  if (!meta.hotspots) return Promise.resolve(null);
  cached ||= fetch("data/hotspots.bin").then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => {
    if (!b) return null;
    const n = meta.hotspots.rows;
    return { cell: new Uint16Array(b, 0, n), n: new Uint16Array(b, 2 * n, n),
             frp: new Uint16Array(b, 4 * n, n), sub: new Uint8Array(b, 6 * n, n),
             year: new Uint8Array(b, 7 * n, n) };
  }).catch(() => null);
  return cached;
}

// Dots for years y0..y1, optionally one district or a set of districts:
// [{lat, lon, n, frp, district, size}]
export function aggregate(meta, hot, rows, cellDistrict, { y0, y1, district = null, ids = null }) {
  const out = new Map();
  const distOf = (c) => (cellDistrict ? cellDistrict[c] : -1);
  if (hot) {
    const h = meta.hotspots, c = meta.cellDeg, f = h.fine;
    for (let i = 0; i < hot.cell.length; i++) {
      const cell = hot.cell[i];
      if (district != null && distOf(cell) !== district) continue;
      if (ids && !ids.has(distOf(cell))) continue;
      const y = hot.year[i] + h.year0;
      if (y < y0 || y > y1) continue;
      const key = cell * 256 + hot.sub[i];
      let s = out.get(key);
      if (!s) {
        const [la, lo] = meta.cells[cell];
        const iy = Math.floor(hot.sub[i] / h.per), ix = hot.sub[i] % h.per;
        s = { lat: la - c / 2 + (iy + 0.5) * f, lon: lo - c / 2 + (ix + 0.5) * f,
              n: 0, frpSum: 0, district: distOf(cell), size: f };
        out.set(key, s);
      }
      s.n += hot.n[i]; s.frpSum += (hot.frp[i] / 10) * hot.n[i];
    }
    const dots = [...out.values()].map((s) => ({ ...s, frp: s.frpSum / s.n }));
    return { dots, hasFrp: true, unit: "detections" };
  }
  const base = Date.parse(`${meta.date0}T00:00:00Z`);
  const d0 = Math.round((Date.UTC(y0, 0, 1) - base) / 864e5);
  const d1 = Math.round((Date.UTC(y1 + 1, 0, 1) - base) / 864e5);
  for (let i = 0; i < rows.day.length; i++) {
    const c = rows.cell[i];
    if (rows.day[i] < d0 || rows.day[i] >= d1) continue;
    if (cellDistrict && distOf(c) < 0) continue;
    if (district != null && distOf(c) !== district) continue;
    if (ids && !ids.has(distOf(c))) continue;
    const s = out.get(c) || { lat: meta.cells[c][0], lon: meta.cells[c][1], n: 0, frp: NaN,
                              district: distOf(c), size: meta.cellDeg };
    s.n++; out.set(c, s);
  }
  return { dots: [...out.values()], hasFrp: false, unit: "fire-days" };
}

// 0..1 intensity for each dot: log scale between the 5th and 97th percentile
export function intensity(dots, hasFrp) {
  const v = dots.map((d) => (hasFrp ? d.frp : d.n)).filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return () => 1;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const lo = Math.log(q(0.05)), hi = Math.log(q(0.97));
  return (d) => {
    const x = hasFrp ? d.frp : d.n;
    return hi > lo ? Math.max(0, Math.min(1, (Math.log(Math.max(x, 1e-3)) - lo) / (hi - lo))) : 1;
  };
}

// Draw dots: soft glow, then solid cores, most intense on top
export function drawDots(ctx, list, { glow = true } = {}) {
  const sorted = [...list].sort((a, b) => a.t - b.t);
  if (glow) {
    ctx.globalCompositeOperation = "lighter";
    for (const d of sorted) {
      ctx.globalAlpha = (0.08 + 0.2 * d.t) * (d.dim ?? 1);
      ctx.fillStyle = red(d.t);
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r * 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }
  for (const d of sorted) {
    ctx.globalAlpha = (0.6 + 0.4 * d.t) * (d.dim ?? 1);
    ctx.fillStyle = red(d.t);
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
