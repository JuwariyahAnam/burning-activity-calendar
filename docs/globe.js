// Hero: Earth centred on the study region, the four satellites behind the record
// on their orbits, and a lens that replays a year of fire in the region.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import { ember, reduceMotion, MONTH_NAMES } from "./viz.js";
import { dayToDate } from "./engine.js";

const RAD = Math.PI / 180;
// NASA Blue Marble, public domain, as redistributed in the three-globe
// package; used for continent shapes and terrain. Two mirrors, tried in order.
const DAY_URLS = ["https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg",
                  "https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"];
// Fallback if the imagery can't load: Natural Earth land outlines via world-atlas
const LAND_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json";
const TEX_W = 2048, TEX_H = 1024;

function loadImage(url) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = url;
  });
}
async function loadTexture(urls) {
  for (const url of urls) {
    try {
      const img = await loadImage(url);
      const c = document.createElement("canvas");
      c.width = TEX_W; c.height = TEX_H;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0, TEX_W, TEX_H);
      return g.getImageData(0, 0, TEX_W, TEX_H).data;   // throws if CORS failed
    } catch { /* try the next mirror */ }
  }
  return null;
}
// bilinear sample of an equirectangular RGBA texture into out[0..2]
function sample(tex, lon, lat, out) {
  const x = ((lon + 180) / 360) * TEX_W - 0.5, y = ((90 - lat) / 180) * TEX_H - 0.5;
  const x0 = Math.floor(x), y0 = Math.max(0, Math.min(TEX_H - 2, Math.floor(y)));
  const fx = x - x0, fy = Math.max(0, Math.min(1, y - y0));
  const xa = ((x0 % TEX_W) + TEX_W) % TEX_W, xb = (xa + 1) % TEX_W;
  const i00 = (y0 * TEX_W + xa) * 4, i10 = (y0 * TEX_W + xb) * 4;
  const i01 = ((y0 + 1) * TEX_W + xa) * 4, i11 = ((y0 + 1) * TEX_W + xb) * 4;
  for (let c = 0; c < 3; c++) {
    out[c] = (tex[i00 + c] * (1 - fx) + tex[i10 + c] * fx) * (1 - fy) +
             (tex[i01 + c] * (1 - fx) + tex[i11 + c] * fx) * fy;
  }
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------- geometry
const vec = (lat, lon) => [Math.cos(lat * RAD) * Math.cos(lon * RAD),
                           Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function viewBasis(lat0, lon0) {
  const f = vec(lat0, lon0);
  const e = [-Math.sin(lon0 * RAD), Math.cos(lon0 * RAD), 0];
  const n = [-Math.sin(lat0 * RAD) * Math.cos(lon0 * RAD),
             -Math.sin(lat0 * RAD) * Math.sin(lon0 * RAD), Math.cos(lat0 * RAD)];
  return { e, n, f };
}

// Decode a TopoJSON MultiPolygon/Polygon collection into rings of [lon, lat].
export function topoRings(topo, name) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  const arcs = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
  });
  const ring = (ids) => {
    const out = [];
    ids.forEach((i, k) => {
      const a = i < 0 ? [...arcs[~i]].reverse() : arcs[i];
      out.push(...(k ? a.slice(1) : a));
    });
    return out;
  };
  const polys = [];
  const walk = (g) => {
    if (g.type === "GeometryCollection") g.geometries.forEach(walk);
    else if (g.type === "Polygon") polys.push(g.arcs.map(ring));
    else if (g.type === "MultiPolygon") g.arcs.forEach((p) => polys.push(p.map(ring)));
  };
  walk(topo.objects[name]);
  return polys;
}

// Equirectangular land mask: 1 where land.
function landMask(polys, W = 2048, H = 1024) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  for (const poly of polys) {
    g.beginPath();
    for (const r of poly) r.forEach(([lon, lat], i) => {
      const x = ((lon + 180) / 360) * W, y = ((90 - lat) / 180) * H;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.fill("evenodd");
  }
  const px = g.getImageData(0, 0, W, H).data;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  return { mask, W, H };
}


// Sun direction in view space: upper left, mostly toward the viewer.
const SUN = (() => { const L = [-0.84, 0.38, 0.4], k = Math.hypot(...L); return L.map((v) => v / k); })();

// ---------------------------------------------------------- stylized Earth
// A cinematic, art-directed Earth: teal-blue oceans, muted teal land, swirling
// procedural clouds, cyan atmosphere on the sunlit limb and a deep navy night.
// NASA Blue Marble supplies the continents and terrain variation; without it,
// Natural Earth land outlines are used.
const PAL = {
  oceanDark: [2, 14, 36], oceanLit: [20, 84, 150], shallow: [30, 124, 164],
  landDark: [8, 32, 42], landLit: [50, 122, 114], dryLit: [98, 136, 114],
  cloudDark: [14, 34, 66], cloudLit: [228, 242, 255], haze: [84, 184, 255],
};
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// 3D value noise and fractal sum, seeded so the clouds look the same every visit
const PERM = (() => {
  const p = new Uint8Array(512), v = [...Array(256).keys()];
  let seed = 1337;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1); [v[i], v[j]] = [v[j], v[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = v[i & 255];
  return p;
})();
const RND = Float32Array.from({ length: 256 }, (_, i) => PERM[i] / 255);
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const X = xi & 255, Y = yi & 255, Z = zi & 255;
  const h = (a, b, c) => RND[PERM[PERM[PERM[a] + b] + c]];
  const X1 = (X + 1) & 255, Y1 = (Y + 1) & 255, Z1 = (Z + 1) & 255;
  const x00 = h(X, Y, Z) + (h(X1, Y, Z) - h(X, Y, Z)) * u;
  const x10 = h(X, Y1, Z) + (h(X1, Y1, Z) - h(X, Y1, Z)) * u;
  const x01 = h(X, Y, Z1) + (h(X1, Y, Z1) - h(X, Y, Z1)) * u;
  const x11 = h(X, Y1, Z1) + (h(X1, Y1, Z1) - h(X, Y1, Z1)) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}
function fbm(x, y, z, oct = 5) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, z * f); f *= 2.03; a *= 0.5; }
  return s / (1 - 0.5 ** oct);
}
// Cloud cover at a point on the unit sphere: warped noise, banded by latitude
function clouds(P0, P1, P2, lat) {
  const q = fbm(P0 * 1.9 + 5.2, P1 * 1.9 + 1.3, P2 * 1.9, 3);
  const c = fbm(P0 * 4.2 + q * 2.8, P1 * 4.2 + q * 1.7, P2 * 4.2 - q * 2.2, 6);
  const belts = 0.8 + 0.2 * Math.cos(lat * RAD * 3.2);       // storm tracks and the tropics
  return smooth(0.45, 0.74, c * belts + 0.06);
}

function renderGlobe(R, basis, land, tex) {
  if (tex?.day || land) return renderStylizedGlobe(R, basis, land, tex?.day);
  return renderSimpleGlobe(R, basis, null);
}

function renderStylizedGlobe(R, basis, land, day) {
  const size = Math.ceil(R * 2);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size), d = img.data;
  const { e, n, f } = basis, L = SUN;
  const H = [L[0], L[1], L[2] + 1], hk = Math.hypot(...H);
  H.forEach((v, i) => (H[i] = v / hk));
  const tc = [0, 0, 0];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const nx = (px + 0.5 - R) / R, ny = (R - py - 0.5) / R, d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2), r = Math.sqrt(d2);
      const P0 = nx * e[0] + ny * n[0] + nz * f[0], P1 = nx * e[1] + ny * n[1] + nz * f[1];
      const P2 = nx * e[2] + ny * n[2] + nz * f[2];
      const lat = Math.asin(Math.max(-1, Math.min(1, P2))) / RAD;
      const lon = Math.atan2(P1, P0) / RAD;
      // surface: water or land, plus brightness and dryness for variety
      let water, lum, dry;
      if (day) {
        sample(day, lon, lat, tc);
        water = tc[2] > tc[0] + 12 && tc[2] >= tc[1] && tc[0] + tc[1] + tc[2] < 260;
        lum = (0.3 * tc[0] + 0.59 * tc[1] + 0.11 * tc[2]) / 255;
        dry = Math.max(0, Math.min(1, (tc[0] - tc[1] * 0.85) / 60));
      } else {
        const mx = Math.min(land.W - 1, Math.floor(((lon + 180) / 360) * land.W));
        const my = Math.min(land.H - 1, Math.floor(((90 - lat) / 180) * land.H));
        water = !land.mask[my * land.W + mx];
        lum = 0.3 + 0.35 * fbm(P0 * 6, P1 * 6, P2 * 6, 3);
        dry = Math.max(0, 1 - Math.abs(lat - 24) / 14) * 0.6;   // subtropical deserts
      }
      if (Math.abs(lat) > 72 && !water) { dry = 0; lum = 0.9; }  // ice
      const ndl = nx * L[0] + ny * L[1] + nz * L[2];
      const light = 0.04 + 1.0 * Math.max(0, ndl) ** 0.9;
      let col;
      if (water) {
        col = mix3(PAL.oceanDark, mix3(PAL.oceanLit, PAL.shallow, Math.min(1, lum * 1.6)), light);
      } else {
        const lit = mix3(PAL.landLit, PAL.dryLit, dry);
        col = mix3(PAL.landDark, lit.map((v) => v * (0.75 + 0.6 * lum)), light);
      }
      // clouds, lit by the sun, with a slight shadow
      const cl = clouds(P0, P1, P2, lat) * 0.9;
      col = mix3(col, mix3(PAL.cloudDark, PAL.cloudLit, Math.min(1, light * 1.05)), cl);
      // soft sun glint on open water
      if (water) {
        const s = Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]) ** 40 * 0.35 * (1 - cl);
        col = col.map((v) => v + 255 * s);
      }
      // night side falls to deep navy
      const night = smooth(-0.25, 0.15, ndl);
      col = mix3([1, 6, 18], col, 0.14 + 0.86 * night);
      // atmosphere: cyan haze, strongest at the sunlit rim
      const rim = (1 - nz) ** 2.2;
      const a = Math.min(0.92, 0.025 + rim * (0.12 + 1.0 * smooth(-0.3, 0.5, ndl)));
      col = mix3(col, PAL.haze, a);
      const k = (py * size + px) * 4;
      d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2];
      d[k + 3] = 255 * Math.min(1, (1 - r) * R);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function renderSimpleGlobe(R, basis, land) {
  const size = Math.ceil(R * 2);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size), d = img.data;
  const L = SUN;
  const { e, n, f } = basis;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const nx = (px + 0.5 - R) / R, ny = (R - py - 0.5) / R, d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2), r = Math.sqrt(d2);
      const P0 = nx * e[0] + ny * n[0] + nz * f[0], P1 = nx * e[1] + ny * n[1] + nz * f[1];
      const P2 = nx * e[2] + ny * n[2] + nz * f[2];
      const lat = Math.asin(Math.max(-1, Math.min(1, P2))) / RAD;
      const lon = Math.atan2(P1, P0) / RAD;
      const light = 0.16 + 0.84 * Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]) ** 0.9;
      let isLand = 0;
      if (land) {
        const mx = Math.min(land.W - 1, Math.floor(((lon + 180) / 360) * land.W));
        const my = Math.min(land.H - 1, Math.floor(((90 - lat) / 180) * land.H));
        isLand = land.mask[my * land.W + mx];
      }
      let cr, cg, cb;
      if (isLand) { cr = 20 + 38 * light; cg = 44 + 70 * light; cb = 66 + 84 * light; }
      else { cr = 4 + 12 * light; cg = 12 + 36 * light; cb = 30 + 80 * light; }
      // graticule every 15 degrees, thinner toward the centre of the disc
      const w = Math.min(1.6, (0.55 / RAD / R) / Math.max(0.25, nz));
      const gl = Math.abs(((lat + 7.5) % 15 + 15) % 15 - 7.5) < w ||
                 (Math.abs(lat) < 75 && Math.abs(((lon + 7.5) % 15 + 15) % 15 - 7.5) < w / Math.max(0.2, Math.cos(lat * RAD)));
      if (gl) { const a = 0.22 * (0.35 + light); cr += (110 - cr) * a; cg += (190 - cg) * a; cb += (255 - cb) * a; }
      // atmosphere at the rim
      const rim = Math.max(0, (r - 0.9) / 0.1) ** 2;
      cr += (90 - cr) * rim * 0.55; cg += (180 - cg) * rim * 0.55; cb += (255 - cb) * rim * 0.55;
      const k = (py * size + px) * 4;
      d[k] = cr; d[k + 1] = cg; d[k + 2] = cb;
      d[k + 3] = 255 * Math.min(1, (1 - r) * R);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function starField(W, H) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < (W * H) / 2600; i++) {
    const r = rnd() < 0.92 ? 0.6 : 1.2;
    g.globalAlpha = 0.25 + rnd() * 0.6;
    g.fillStyle = rnd() < 0.15 ? "#ffe9c7" : rnd() < 0.3 ? "#bcd6ff" : "#ffffff";
    g.beginPath(); g.arc(rnd() * W, rnd() * H, r, 0, Math.PI * 2); g.fill();
  }
  return c;
}

// Fire replay data: per day of year, [cell, years burned on that date].
function doyLists(meta, rows) {
  const byDoy = Array.from({ length: 366 }, () => new Map());
  const info = new Map(), years = new Set();
  for (let i = 0; i < rows.day.length; i++) {
    const day = rows.day[i];
    let v = info.get(day);
    if (!v) {
      const dt = dayToDate(meta, day);
      v = [Math.min(364, Math.floor((dt - Date.UTC(dt.getUTCFullYear(), 0, 1)) / 864e5)), dt.getUTCFullYear()];
      info.set(day, v);
    }
    years.add(v[1]);
    const m = byDoy[v[0]];
    m.set(rows.cell[i], (m.get(rows.cell[i]) || 0) + 1);
  }
  const lists = byDoy.map((m) => [...m.entries()]);
  const totals = lists.map((l) => l.reduce((s, [, n]) => s + n, 0));
  return { lists, totals, maxTotal: Math.max(1, ...totals), nYears: Math.max(1, years.size) };
}

// Satellites behind the record. Sun-synchronous orbits, inclination ~98 degrees.
// Terra crosses the equator at 10:30, the others at 13:30: 3 h = 45 degrees apart.
// Planes are turned to face the viewer so they read as rings; radii are exaggerated.
const SATS = [
  { name: "Terra", inst: "MODIS", alt: 1.2, node: 62, phase: 0.08, color: "#3987e5" },
  { name: "Aqua", inst: "MODIS", alt: 1.2, node: 107, phase: 0.58, color: "#3987e5" },
  { name: "Suomi NPP", inst: "VIIRS", alt: 1.34, node: 110, phase: 0.3, color: "#199e70" },
  { name: "NOAA-20", inst: "VIIRS", alt: 1.34, node: 110, phase: 0.8, color: "#199e70" },
];
const INC = 98.2;

export function createGlobeHero(canvas, meta, rows, { monthEl, trackEl, clockEl }) {
  const fire = doyLists(meta, rows);
  const centre = [(meta.extent[0] + meta.extent[2]) / 2, (meta.extent[1] + meta.extent[3]) / 2];
  const viewLon = centre[1] - 6;
  const basis = viewBasis(centre[0] - 12, viewLon);   // region sits up and right of centre
  trackEl.replaceChildren(...MONTH_NAMES.map(() => document.createElement("span")));
  let land = null, tex = null, ctx, W, H, dpr, stars, globeImg, G, lens, lensCtx, lensProj;
  let textBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  // keep satellites and their labels off the headline and paragraph
  const overText = (x0, y0, x1, y1) =>
    x1 > textBox.x0 && x0 < textBox.x1 && y1 > textBox.y0 && y0 < textBox.y1;
  let t0 = 0, doy = 273, month = -1, running = false, visible = true, last = 0;

  // Imagery first; land outlines only if it can't load; graticule if neither does.
  loadTexture(DAY_URLS).then((day) => {
    if (day) { tex = { day }; layout(); return; }
    return fetch(LAND_URL).then((r) => r.json()).then((topo) => {
      land = landMask(topoRings(topo, "land"));
      layout();
    });
  }).catch(() => {});

  function layout() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const copy = canvas.parentElement.querySelector(".hero-copy");
    const cb = copy.getBoundingClientRect(), hb = canvas.getBoundingClientRect();
    textBox = { x0: cb.left - hb.left - 12, y0: cb.top - hb.top + 40,
                x1: cb.right - hb.left + 12, y1: cb.bottom - hb.top + 12 };
    if (W >= 960) {
      const R = Math.min(H * 0.36, W * 0.24);
      G = { x: W * 0.72, y: H * 0.5, R };
      lens = { x: G.x + R * 0.62, y: G.y + R * 1.02, r: Math.max(78, R * 0.34) };
    } else {
      const top = copy.offsetTop + copy.offsetHeight + 24;
      const R = Math.min(W * 0.36, (H - top) * 0.32);
      G = { x: W * 0.5, y: top + R * 1.35, R };
      lens = { x: G.x + R * 0.66, y: G.y + R * 1.12, r: Math.max(58, R * 0.42) };
    }
    stars = starField(Math.ceil(W), Math.ceil(H));
    const gr = Math.round(G.R * Math.min(dpr, 1.5));
    const kind = tex ? "tex" : land ? "land" : "grid";
    if (!globeImg || Math.abs(gr - globeImg._r) > 2 || globeImg._kind !== kind) {
      globeImg = renderGlobe(gr, basis, land, tex);   // slow step: only when size or data changes
      globeImg._r = gr; globeImg._kind = kind;
    }
    // lens: the region's grid cells fitted into a circle
    const size = Math.ceil(lens.r * 2 * dpr);
    lensCanvas.width = lensCanvas.height = size;
    lensCtx = lensCanvas.getContext("2d");
    lensCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [s, w, n, e] = meta.extent, pad = meta.cellDeg;
    const kx = Math.cos(((s + n) / 2) * RAD);
    const spanX = (e - w + 2 * pad) * kx, spanY = n - s + 2 * pad;
    const scale = (lens.r * 1.5) / Math.max(spanX, spanY);
    lensProj = {
      cell: Math.max(1.4, meta.cellDeg * scale * 0.55),
      px: (lat, lon) => [lens.r + (lon - (w + e) / 2) * kx * scale, lens.r - (lat - (s + n) / 2) * scale],
    };
    lensCtx.fillStyle = "#050c1c"; lensCtx.fillRect(0, 0, lens.r * 2, lens.r * 2);
    if (clockEl) {
      Object.assign(clockEl.style, {
        left: `${lens.x - lens.r - (W >= 960 ? 22 : 12)}px`, top: `${lens.y - (W >= 960 ? 6 : 34)}px`,
        bottom: "auto", transform: "translateX(-100%)", textAlign: "right",
      });
    }
    if (reduceMotion) drawStatic();
  }
  const lensCanvas = document.createElement("canvas");

  const project = (p) => [dot(p, basis.e), dot(p, basis.n), dot(p, basis.f)];
  function orbitPoint(s, a) {
    // circle of radius alt in a plane with inclination INC and ascending node s.node
    const node = (viewLon + s.node) * RAD, inc = INC * RAD;
    const x = Math.cos(a), y = Math.sin(a);
    const p = [x * Math.cos(node) - y * Math.cos(inc) * Math.sin(node),
               x * Math.sin(node) + y * Math.cos(inc) * Math.cos(node), y * Math.sin(inc)];
    const v = project(p);
    return { sx: G.x + v[0] * s.alt * G.R, sy: G.y - v[1] * s.alt * G.R, z: v[2],
             hidden: v[2] < 0 && Math.hypot(v[0] * s.alt, v[1] * s.alt) < 1 };
  }
  function drawOrbits(front) {
    const seen = new Set();
    for (const s of SATS) {
      const key = `${s.alt}|${s.node}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i <= 240; i++) {
        const p = orbitPoint(s, (i / 240) * Math.PI * 2);
        const ok = front ? p.z >= 0 : p.z < 0;
        if (ok) { pen ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy); pen = true; } else pen = false;
      }
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = front ? 0.55 : 0.18;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawSats(time, front) {
    for (const s of SATS) {
      const a = (s.phase + time / 26000) * Math.PI * 2;
      const p = orbitPoint(s, a);
      if (p.hidden || (front ? p.z < 0 : p.z >= 0)) continue;
      if (overText(p.sx - 10, p.sy - 20, p.sx + 80, p.sy + 12)) continue;
      ctx.globalAlpha = front ? 1 : 0.4;
      const glow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, 10);
      glow.addColorStop(0, s.color); glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.sx, p.sy, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#eef6ff"; ctx.beginPath(); ctx.arc(p.sx, p.sy, 2.2, 0, Math.PI * 2); ctx.fill();
      if (front) {
        ctx.font = "500 12px 'Instrument Sans', system-ui, sans-serif";
        ctx.fillStyle = "rgba(238,241,247,.85)";
        ctx.fillText(`${s.name}`, p.sx + 9, p.sy - 7);
        ctx.fillStyle = "rgba(163,173,194,.75)";
        ctx.fillText(s.inst, p.sx + 9, p.sy + 7);
      }
    }
    ctx.globalAlpha = 1;
  }
  function regionPoint() {
    const v = project(vec(centre[0], centre[1]));
    return [G.x + v[0] * G.R, G.y - v[1] * G.R];
  }
  function drawLens(day, decay = 0.1) {
    const g = lensCtx;
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    g.fillStyle = `rgba(5,12,28,${decay})`; g.fillRect(0, 0, lens.r * 2, lens.r * 2);
    g.globalCompositeOperation = "lighter";
    for (const [c, k] of fire.lists[day]) {
      const [la, lo] = meta.cells[c];
      const [x, y] = lensProj.px(la, lo);
      const t = k / fire.nYears;
      g.globalAlpha = Math.min(1, 0.3 + 0.7 * t);
      g.fillStyle = ember(0.35 + 0.65 * t);
      g.beginPath(); g.arc(x, y, lensProj.cell * (0.8 + 0.7 * t), 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
  }
  function compose(time, day) {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(stars, 0, 0, W, H);
    // wide faint halo, then a thin bright limb shifted toward the sun
    const halo = ctx.createRadialGradient(G.x, G.y, G.R * 0.9, G.x, G.y, G.R * 1.5);
    halo.addColorStop(0, "rgba(70,150,255,0.22)"); halo.addColorStop(1, "rgba(70,150,255,0)");
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(G.x, G.y, G.R * 1.5, 0, Math.PI * 2); ctx.fill();
    // faint all-round rim, then a brighter crescent on the sunlit side
    const rimAll = ctx.createRadialGradient(G.x, G.y, G.R * 0.98, G.x, G.y, G.R * 1.05);
    rimAll.addColorStop(0, "rgba(120,190,255,0.22)"); rimAll.addColorStop(1, "rgba(120,190,255,0)");
    ctx.fillStyle = rimAll; ctx.beginPath(); ctx.arc(G.x, G.y, G.R * 1.05, 0, Math.PI * 2); ctx.fill();
    const lx = G.x + SUN[0] * G.R * 0.06, ly = G.y - SUN[1] * G.R * 0.06;
    const limb = ctx.createRadialGradient(lx, ly, G.R * 0.96, lx, ly, G.R * 1.06);
    limb.addColorStop(0, "rgba(160,215,255,0.6)"); limb.addColorStop(1, "rgba(160,215,255,0)");
    ctx.save();
    ctx.beginPath(); ctx.arc(G.x, G.y, G.R * 1.12, 0, Math.PI * 2);
    ctx.arc(G.x, G.y, G.R * 0.995, 0, Math.PI * 2, true); ctx.clip();   // outside the disc only
    ctx.fillStyle = limb; ctx.beginPath(); ctx.arc(lx, ly, G.R * 1.06, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    drawOrbits(false); drawSats(time, false);
    ctx.drawImage(globeImg, G.x - G.R, G.y - G.R, G.R * 2, G.R * 2);
    // the region glows with the day's activity
    const [rx, ry] = regionPoint();
    const act = fire.totals[day] / fire.maxTotal;
    ctx.globalCompositeOperation = "lighter";
    const rg = ctx.createRadialGradient(rx, ry, 0, rx, ry, 6 + 26 * act);
    rg.addColorStop(0, ember(0.6 + 0.4 * act)); rg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.35 + 0.65 * act;
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(rx, ry, 6 + 26 * act, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffe6bf"; ctx.beginPath(); ctx.arc(rx, ry, 2, 0, Math.PI * 2); ctx.fill();
    drawOrbits(true); drawSats(time, true);
    // lens and its leader line
    const ang = Math.atan2(lens.y - ry, lens.x - rx);
    ctx.strokeStyle = "rgba(160,200,255,.45)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(rx + Math.cos(ang) * 6, ry + Math.sin(ang) * 6);
    ctx.lineTo(lens.x - Math.cos(ang) * lens.r, lens.y - Math.sin(ang) * lens.r); ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.arc(lens.x, lens.y, lens.r, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(lensCanvas, lens.x - lens.r, lens.y - lens.r, lens.r * 2, lens.r * 2);
    ctx.restore();
    ctx.strokeStyle = "rgba(160,200,255,.55)"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(lens.x, lens.y, lens.r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(160,200,255,.14)"; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(lens.x, lens.y, lens.r + 5, 0, Math.PI * 2); ctx.stroke();
  }
  function setMonth(day) {
    const m = dayToDate({ date0: "2001-01-01" }, day).getUTCMonth();
    if (m === month) return;
    month = m;
    monthEl.textContent = MONTH_NAMES[m];
    [...trackEl.children].forEach((s, i) => s.classList.toggle("on", i <= m));
  }
  function drawStatic() {
    for (let d = 0; d < 365; d++) drawLens(d, 0.004);
    monthEl.textContent = "The whole year";
    compose(0, 300);
  }
  function frame(t) {
    if (!running) return;
    const dt = Math.min(64, t - (last || t)); last = t; t0 += dt;
    doy = (doy + dt * 0.026) % 365;
    const day = Math.floor(doy);
    drawLens(day);
    setMonth(day);
    compose(t0, day);
    requestAnimationFrame(frame);
  }
  const start = () => { if (!running && visible && !reduceMotion && !document.hidden) {
    running = true; last = 0; requestAnimationFrame(frame); } };
  const stop = () => { running = false; };
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; visible ? start() : stop(); }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  new ResizeObserver(() => layout()).observe(canvas);
  layout();
  start();
}
