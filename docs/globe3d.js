// Hero globe: a realistic Earth in WebGL that spins in space with the four
// satellites behind the record. Click it to fly to the study area; there the
// states and districts are outlined, fires glow red, and clicking a place opens
// its close-up map.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import { reduceMotion } from "./viz.js";
import { inRings, ringsBox } from "./map.js";
import { red } from "./hotspots.js";

const RAD = Math.PI / 180;
// NASA Blue Marble (public domain) via the three-globe package; two mirrors.
const DAY_URLS = ["https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg",
                  "https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"];
// Fallback texture: Natural Earth land outlines via world-atlas
const LAND_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json";

const SATS = [   // sun-synchronous orbits; Terra 10:30, the others 13:30 (45 degrees apart)
  { name: "Terra", inst: "MODIS", alt: 1.2, node: 62, phase: 0.08, color: "#3987e5" },
  { name: "Aqua", inst: "MODIS", alt: 1.2, node: 107, phase: 0.58, color: "#3987e5" },
  { name: "Suomi NPP", inst: "VIIRS", alt: 1.34, node: 110, phase: 0.3, color: "#199e70" },
  { name: "NOAA-20", inst: "VIIRS", alt: 1.34, node: 110, phase: 0.8, color: "#199e70" },
];
const INC = 98.2 * RAD;

// ------------------------------------------------------------ geometry
const vec = (lat, lon) => [Math.cos(lat * RAD) * Math.cos(lon * RAD),
                           Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function basis(lat0, lon0) {
  return {
    e: [-Math.sin(lon0 * RAD), Math.cos(lon0 * RAD), 0],
    n: [-Math.sin(lat0 * RAD) * Math.cos(lon0 * RAD), -Math.sin(lat0 * RAD) * Math.sin(lon0 * RAD), Math.cos(lat0 * RAD)],
    f: vec(lat0, lon0),
  };
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// ------------------------------------------------------------- shaders
const VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uDpr; uniform vec3 uGlobe;
uniform vec3 uE, uN, uF, uSun;
uniform sampler2D uDay; uniform float uTex, uLod, uTime, uClouds;
out vec4 o;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s / 0.96875; }
void main() {
  vec2 css = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec2 v = (css - uGlobe.xy) / uGlobe.z; v.y = -v.y;
  float d2 = dot(v, v), r = sqrt(d2);
  vec3 L = normalize(uSun);
  if (d2 > 1.0) {                                  // atmosphere halo
    if (r > 1.16) { o = vec4(0.0); return; }
    float side = dot(normalize(v), normalize(L.xy));
    float h = pow(smoothstep(1.16, 1.0, r), 2.2) * (0.25 + 0.75 * smoothstep(-0.5, 0.8, side));
    o = vec4(vec3(0.42, 0.68, 1.0) * h, h) * 0.85;
    return;
  }
  vec3 n = vec3(v, sqrt(1.0 - d2));
  vec3 w = uE * n.x + uN * n.y + uF * n.z;
  float lat = asin(clamp(w.z, -1.0, 1.0)), lon = atan(w.y, w.x);
  vec3 day = vec3(0.03, 0.11, 0.24);
  if (uTex > 0.5) day = textureLod(uDay, vec2(lon / 6.2831853 + 0.5, 0.5 - lat / 3.14159265), uLod).rgb;
  float ndl = dot(n, L);
  vec3 col = day * (0.05 + 1.12 * pow(max(ndl, 0.0), 0.85));
  float water = smoothstep(0.03, 0.14, day.b - day.r) * (1.0 - smoothstep(0.9, 1.2, day.r + day.g + day.b));
  // clouds drift slowly eastward
  float q = fbm(w * 1.9 + 5.2);
  float c = fbm(w * 4.2 + q * 2.6 + vec3(uTime * 0.004, 0.0, 0.0));
  float cloud = smoothstep(0.5, 0.78, c * (0.8 + 0.2 * cos(lat * 3.2)) + 0.05) * 0.85 * uClouds;
  col = mix(col, vec3(0.94, 0.97, 1.0) * (0.04 + 1.0 * max(ndl, 0.0)), cloud);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  col += pow(max(dot(n, H), 0.0), 60.0) * 0.35 * water * (1.0 - cloud) * vec3(1.0, 0.95, 0.88);
  col = mix(vec3(0.004, 0.018, 0.045), col, 0.1 + 0.9 * smoothstep(-0.22, 0.12, ndl));   // night side
  float rim = pow(1.0 - n.z, 2.4);
  col = mix(col, vec3(0.42, 0.7, 1.0), min(0.9, 0.03 + rim * (0.15 + 1.0 * smoothstep(-0.3, 0.55, ndl))));
  float a = clamp((1.0 - r) * uGlobe.z * uDpr, 0.0, 1.0);
  o = vec4(col * a, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function loadImage(url) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img); img.onerror = fail; img.src = url;
  });
}
async function earthImage() {
  for (const url of DAY_URLS) { try { return await loadImage(url); } catch { /* next */ } }
  try {   // fallback: land outlines painted onto an equirectangular canvas
    const topo = await fetch(LAND_URL).then((r) => r.json());
    const { topoRings } = await import("./topo.js");
    const W = 2048, H = 1024, c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d");
    g.fillStyle = "#0a2a52"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#3b6b4a";
    for (const poly of topoRings(topo, "land")) {
      g.beginPath();
      for (const ring of poly) ring.forEach(([lon, lat], i) => {
        const x = ((lon + 180) / 360) * W, y = ((90 - lat) / 180) * H;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.fill("evenodd");
    }
    return c;
  } catch { return null; }
}

// --------------------------------------------------------------- globe
export function createGlobe(root, { meta, districts, fireDots, onPlace, describe, onMode,
                                     regions = [], current = null, onRegion }) {
  const glCanvas = root.querySelector(".globe-gl"), over = root.querySelector(".globe-over");
  const D = districts?.districts || [], S = districts?.states || [];
  const focusIds = new Set(districts?.focusIds || []);
  // shapes outlined in the study area: whole states, or the chosen districts
  const byStates = (districts?.focusMode || "states") === "states";
  const focusStates = byStates
    ? S.filter((s) => (districts?.focus || []).includes(s.name))
    : [{ name: meta.region, rings: D.filter((d) => focusIds.has(d.id)).flatMap((d) => d.rings), label: true }];
  D.forEach((x) => (x.box ||= ringsBox(x.rings)));
  // the study area: focus shapes if known, else the data extent
  let area = focusStates.length && focusStates[0].rings.length ? focusStates.map((s) => ringsBox(s.rings))
    .reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])])
    : meta.extent;
  const areaC = [(area[0] + area[2]) / 2, (area[1] + area[3]) / 2];

  // --- WebGL setup (falls back to a painted sphere without WebGL2)
  const gl = glCanvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  let prog = null, uni = {}, tex = null, texW = 2048, hasTex = 0;
  if (gl) {
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const u of ["uRes", "uDpr", "uGlobe", "uE", "uN", "uF", "uSun", "uDay", "uTex", "uLod", "uTime", "uClouds"]) {
        uni[u] = gl.getUniformLocation(prog, u);
      }
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      earthImage().then((img) => {
        if (!img) return;
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        texW = img.width; hasTex = 1;
      });
    } catch (err) { console.warn("Globe: WebGL unavailable,", err.message); prog = null; }
  }
  const SUN = (() => { const L = [-0.8, 0.4, 0.45], k = Math.hypot(...L); return L.map((x) => x / k); })();

  // --- camera
  let W = 0, H = 0, dpr = 1, octx;
  let mode = "orbit";                 // orbit -> flying -> area -> flying -> orbit
  let cam = { lat: 18, lon: areaC[1] - 40, R: 300, cx: 0, cy: 0, clouds: 1 };
  let flight = null, spin = 0, hover = -1, dotsCache = null, dotsFor = "", inset = 0;
  const homeCam = () => (W >= 960
    ? { lat: 18, R: Math.min(H * 0.36, W * 0.25), cx: W * 0.72, cy: H * 0.5, clouds: 1 }
    : { lat: 18, R: Math.min(W * 0.4, H * 0.24), cx: W * 0.5, cy: H * 0.68, clouds: 1 });
  function areaCam() {
    const span = Math.max(area[2] - area[0], (area[3] - area[1]) * Math.cos(areaC[0] * RAD)) * RAD;
    const R = (Math.min(H * 0.44, (W - inset) * (W < 700 ? 0.78 : 0.5))) / span;
    return { lat: areaC[0], lon: areaC[1], R, cx: (W - inset) * 0.5, cy: H * (W >= 960 ? 0.5 : 0.45), clouds: 0.25 };
  }

  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = root.clientWidth; H = root.clientHeight;
    for (const c of [glCanvas, over]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    octx = over.getContext("2d"); octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (gl) gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    if (flight) {                        // size changed mid-flight: retarget the landing
      flight.b = flight.to === "area" ? areaCam() : { ...homeCam(), lon: flight.b.lon };
    } else {
      const target = mode === "area" ? areaCam() : homeCam();
      Object.assign(cam, mode === "area" ? target : { ...target, lon: cam.lon });
    }
    dotsFor = "";
  }

  // --- projection
  let B = basis(cam.lat, cam.lon);
  const toScreen = (lat, lon) => {
    const w = vec(lat, lon);
    return [cam.cx + dot3(w, B.e) * cam.R, cam.cy - dot3(w, B.n) * cam.R, dot3(w, B.f)];
  };
  const toLatLon = (x, y) => {
    const vx = (x - cam.cx) / cam.R, vy = -(y - cam.cy) / cam.R, d2 = vx * vx + vy * vy;
    if (d2 > 1) return null;
    const vz = Math.sqrt(1 - d2);
    const w = [0, 1, 2].map((i) => B.e[i] * vx + B.n[i] * vy + B.f[i] * vz);
    return [Math.asin(Math.max(-1, Math.min(1, w[2]))) / RAD, Math.atan2(w[1], w[0]) / RAD];
  };

  // --- drawing
  function drawGL(time) {
    if (!prog) return;
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uni.uRes, glCanvas.width, glCanvas.height);
    gl.uniform1f(uni.uDpr, dpr);
    gl.uniform3f(uni.uGlobe, cam.cx, cam.cy, cam.R);
    gl.uniform3fv(uni.uE, B.e); gl.uniform3fv(uni.uN, B.n); gl.uniform3fv(uni.uF, B.f);
    gl.uniform3fv(uni.uSun, SUN);
    gl.uniform1f(uni.uTex, hasTex);
    gl.uniform1f(uni.uLod, Math.max(0, Math.log2(texW / (2 * Math.PI * cam.R * dpr))));
    gl.uniform1f(uni.uTime, time / 1000);
    gl.uniform1f(uni.uClouds, cam.clouds);
    if (tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(uni.uDay, 0); }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  function drawFallbackSphere() {   // no WebGL2: a lit blue sphere
    const g = octx, { cx, cy, R } = cam;
    const grad = g.createRadialGradient(cx - R * 0.4, cy - R * 0.35, R * 0.1, cx, cy, R);
    grad.addColorStop(0, "#3c86c9"); grad.addColorStop(0.6, "#123e73"); grad.addColorStop(1, "#04142c");
    g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  }
  const ringPath = (rings) => {
    const p = new Path2D();
    for (const r of rings) {
      let pen = false;
      for (const [lon, lat] of r) {
        const [x, y, z] = toScreen(lat, lon);
        if (z < 0) { pen = false; continue; }
        pen ? p.lineTo(x, y) : p.moveTo(x, y); pen = true;
      }
    }
    return p;
  };
  function orbitPoint(s, a) {
    const node = (cam.lon + s.node) * RAD;
    const x = Math.cos(a), y = Math.sin(a);
    const w = [x * Math.cos(node) - y * Math.cos(INC) * Math.sin(node),
               x * Math.sin(node) + y * Math.cos(INC) * Math.cos(node), y * Math.sin(INC)];
    const vx = dot3(w, B.e) * s.alt, vy = dot3(w, B.n) * s.alt, vz = dot3(w, B.f);
    return { x: cam.cx + vx * cam.R, y: cam.cy - vy * cam.R, behind: vz < 0 && vx * vx + vy * vy < 1 };
  }
  function drawOrbits(time, alpha) {
    if (alpha <= 0.01) return;
    const g = octx, seen = new Set();
    g.lineWidth = 1;
    for (const s of SATS) {
      const key = `${s.alt}|${s.node}`;
      if (seen.has(key)) continue;
      seen.add(key);
      g.beginPath();
      let pen = false;
      for (let i = 0; i <= 240; i++) {
        const p = orbitPoint(s, (i / 240) * Math.PI * 2);
        if (p.behind) { pen = false; continue; }
        pen ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); pen = true;
      }
      g.strokeStyle = s.color; g.globalAlpha = 0.5 * alpha; g.stroke();
    }
    for (const s of SATS) {
      const p = orbitPoint(s, (s.phase + time / 26000) * Math.PI * 2);
      if (p.behind) continue;
      g.globalAlpha = alpha;
      const glow = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, 10);
      glow.addColorStop(0, s.color); glow.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = glow; g.beginPath(); g.arc(p.x, p.y, 10, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#eef6ff"; g.beginPath(); g.arc(p.x, p.y, 2.2, 0, Math.PI * 2); g.fill();
      if (!overText(p.x, p.y)) {
        g.font = "500 12px 'Instrument Sans', system-ui, sans-serif"; g.textAlign = "left";
        g.fillStyle = "rgba(238,241,247,.85)"; g.fillText(s.name, p.x + 9, p.y - 7);
        g.fillStyle = "rgba(163,173,194,.75)"; g.fillText(s.inst, p.x + 9, p.y + 7);
      }
    }
    g.globalAlpha = 1;
  }
  const overText = (x, y) => {
    const c = root.querySelector(".hero-copy");
    if (!c || mode !== "orbit" || W < 960) return false;
    const r = c.getBoundingClientRect(), h = root.getBoundingClientRect();
    return x > r.left - h.left - 20 && x < r.right - h.left + 90 && y > r.top - h.top && y < r.bottom - h.top;
  };

  // a pin for every study area; the current one is brighter
  let pinHits = [];
  function drawPins(time, alpha) {
    pinHits = [];
    if (alpha <= 0.01 || !regions.length) return;
    const g = octx, labelBoxes = [];
    g.globalAlpha = alpha;
    // the current area first, so its label gets the best spot
    for (const r of [...regions].sort((a, b) => (b.slug === current) - (a.slug === current))) {
      const [x, y, z] = toScreen(r.center[0], r.center[1]);
      if (z < 0.08) continue;
      const on = r.slug === current, pulse = reduceMotion ? 0.5 : (Math.sin(time / 450 + r.center[1]) + 1) / 2;
      const rad = (on ? 7 : 5) + pulse * 4;
      const glow = g.createRadialGradient(x, y, 0, x, y, rad * 2.2);
      glow.addColorStop(0, on ? "rgba(255,120,60,0.85)" : "rgba(255,150,90,0.55)");
      glow.addColorStop(1, "rgba(255,120,60,0)");
      g.fillStyle = glow; g.beginPath(); g.arc(x, y, rad * 2.2, 0, Math.PI * 2); g.fill();
      g.fillStyle = on ? "#ffe2cf" : "#ffb38a";
      g.beginPath(); g.arc(x, y, on ? 3.2 : 2.6, 0, Math.PI * 2); g.fill();
      let lx = x + 10, ly = y, align = "left";
      if (!overText(x, y) && z > 0.3) {
        g.font = `${on ? 600 : 500} 12px 'Instrument Sans', system-ui, sans-serif`;
        const w = g.measureText(r.name).width;
        // first free spot: right, left, right above, right below, left above, left below
        const spots = [[10, 0, "left"], [-10, 0, "right"], [10, -15, "left"], [10, 15, "left"],
                       [-10, -15, "right"], [-10, 15, "right"], [10, -29, "left"], [10, 29, "left"],
                       [-10, -29, "right"], [-10, 29, "right"]];
        let placed = false;
        for (const [dx, dy, al] of spots) {
          const x0 = al === "left" ? x + dx : x + dx - w, box = [x0 - 2, y + dy - 8, x0 + w + 2, y + dy + 8];
          if (labelBoxes.every((q) => box[2] < q[0] || box[0] > q[2] || box[3] < q[1] || box[1] > q[3])) {
            labelBoxes.push(box); lx = x + dx; ly = y + dy; align = al; placed = true; break;
          }
        }
        if (placed || on) {   // no free spot: leave that label out rather than overprint (the pin still works)
          g.textAlign = align; g.textBaseline = "middle";
          g.lineWidth = 3; g.strokeStyle = "rgba(3,9,21,0.75)"; g.strokeText(r.name, lx, ly);
          g.fillStyle = on ? "#ffffff" : "rgba(235,241,250,0.85)"; g.fillText(r.name, lx, ly);
        }
      }
      pinHits.push({ x, y, slug: r.slug, name: r.name, lx, ly, align });
    }
    g.globalAlpha = 1;
  }
  const pinAt = (x, y) => pinHits.find((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < 14 ** 2 ||
    (Math.abs(y - p.ly) < 9 && (p.align === "left" ? x > p.lx - 2 && x < p.lx + p.name.length * 6.5
                                                     : x < p.lx + 2 && x > p.lx - p.name.length * 6.5)));

  // study area: shapes, district lines, fire dots (cached when the camera is still)
  function drawArea(alpha) {
    if (alpha <= 0.01 || !S.length) return;
    const g = octx;
    g.globalAlpha = alpha;
    g.lineJoin = "round";
    // dim the world around the study area so the eye goes to it
    const around = new Path2D();
    around.rect(0, 0, W, H);
    for (const st of focusStates) around.addPath(ringPath(st.rings));
    g.fillStyle = "rgba(3,9,21,0.5)"; g.fill(around, "evenodd");
    for (const st of focusStates) {
      g.fillStyle = "rgba(10,24,52,0.4)"; g.fill(ringPath(st.rings), "evenodd");
    }
    if (mode === "area" && fireDots) {
      const key = `${W}|${H}|${cam.cx.toFixed(1)}|${cam.cy.toFixed(1)}|${cam.R.toFixed(1)}|${fireDots.key}`;
      if (dotsFor !== key) {
        dotsFor = key;
        dotsCache ||= document.createElement("canvas");
        dotsCache.width = over.width; dotsCache.height = over.height;
        const c = dotsCache.getContext("2d");
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, W, H);
        const nMax = Math.max(1, ...fireDots.dots.map((d) => d.n));
        const sorted = [...fireDots.dots].map((d) => ({ d, t: fireDots.t(d) })).sort((a, b) => a.t - b.t);
        c.globalCompositeOperation = "lighter";
        for (const { d, t } of sorted) {
          const [x, y, z] = toScreen(d.lat, d.lon);
          if (z < 0) continue;
          const r = 0.8 + 2.2 * Math.sqrt(d.n / nMax);
          c.globalAlpha = 0.35 + 0.65 * t;
          c.fillStyle = red(t);
          c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        }
      }
      g.drawImage(dotsCache, 0, 0, W, H);
    }
    D.forEach((d, i) => {
      if (!focusIds.has(i)) return;
      const p = ringPath(d.rings);
      if (i === hover) { g.fillStyle = "rgba(92,200,242,0.16)"; g.fill(p, "evenodd"); }
      g.strokeStyle = i === hover ? "#5cc8f2" : "rgba(190,215,255,0.35)";
      g.lineWidth = i === hover ? 1.8 : 0.7; g.stroke(p);
    });
    for (const st of focusStates) {
      g.strokeStyle = "rgba(240,246,255,0.95)"; g.lineWidth = 1.6; g.stroke(ringPath(st.rings));
    }
    // state names
    g.font = "600 16px 'Instrument Sans', system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    for (const st of focusStates) {
      let lat, lon;
      if (st.label) [lat, lon] = areaC;
      else {
        const big = st.rings.reduce((a, r) => (r.length > a.length ? r : a), []);
        [lon, lat] = big.reduce((a, [x, y]) => [a[0] + x / big.length, a[1] + y / big.length], [0, 0]);
      }
      const [x, y, z] = toScreen(lat, lon);
      if (z < 0) continue;
      g.lineWidth = 4; g.strokeStyle = "rgba(3,9,21,0.8)"; g.strokeText(st.name, x, y);
      g.fillStyle = "#f2f6fd"; g.fillText(st.name, x, y);
    }
    g.globalAlpha = 1;
  }

  function frame(time) {
    requestAnimationFrame(frame);
    if (!visible) return;
    if (flight) {
      const k = Math.min(1, (time - flight.t0) / flight.ms), e = ease(k);
      for (const key of ["lat", "R", "cx", "cy", "clouds"]) cam[key] = flight.a[key] + (flight.b[key] - flight.a[key]) * e;
      let dl = flight.b.lon - flight.a.lon; dl = ((dl + 540) % 360) - 180;   // shortest way round
      cam.lon = flight.a.lon + dl * e;
      if (k >= 1) { mode = flight.to; flight = null; onMode?.(mode); }
    } else if (mode === "orbit" && !reduceMotion) {
      cam.lon += (time - (spin || time)) * 0.004;        // slow spin
    }
    spin = time;
    B = basis(cam.lat, cam.lon);
    drawGL(time);
    octx.clearRect(0, 0, W, H);
    if (!prog) drawFallbackSphere();
    const areaVis = mode === "area" || flight?.keep ? 1 : flight ? (flight.to === "area" ? ease(Math.min(1, (time - flight.t0) / flight.ms)) : 1 - ease(Math.min(1, (time - flight.t0) / flight.ms))) : 0;
    drawOrbits(time, 1 - areaVis);
    drawPins(time, 1 - areaVis);
    drawArea(areaVis);
  }

  function fly(to) {
    if (flight) return;
    const b = to === "area" ? areaCam() : { ...homeCam(), lon: areaC[1] - 40 };
    if (reduceMotion) { Object.assign(cam, b); mode = to; onMode?.(mode); return; }
    flight = { a: { ...cam }, b, t0: performance.now(), ms: to === "area" ? 2200 : 1600, to };
    mode = "flying"; onMode?.("flying-" + to);
    hover = -1;
  }

  // --- interaction
  const districtAt = (x, y) => {
    const ll = toLatLon(x, y);
    if (!ll) return -1;
    const [lat, lon] = ll;
    return D.findIndex((d) => focusIds.has(d.id) && lat >= d.box[0] && lat <= d.box[2] &&
      lon >= d.box[1] && lon <= d.box[3] && inRings(d.rings, lon, lat));
  };
  const local = (e) => { const r = over.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  over.addEventListener("pointermove", (e) => {
    const [x, y] = local(e);
    if (mode === "orbit") {
      const pin = pinAt(x, y);
      over.style.cursor = pin || (x - cam.cx) ** 2 + (y - cam.cy) ** 2 < cam.R ** 2 ? "pointer" : "default";
      const tip = document.getElementById("tooltip");
      if (pin) {
        tip.innerHTML = `<div class="t">${pin.name}</div><div class="r muted">${pin.slug === current ? "Click to fly in" : "Click to open this study area"}</div>`;
        tip.classList.add("show");
        tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 220)}px`; tip.style.top = `${e.clientY + 14}px`;
      } else tip.classList.remove("show");
      return;
    }
    if (mode !== "area") return;
    const di = districtAt(x, y);
    if (di !== hover) hover = di;
    over.style.cursor = di >= 0 ? "pointer" : "default";
    const tip = document.getElementById("tooltip");
    if (di >= 0) {
      tip.innerHTML = `<div class="t">${D[di].name}, ${D[di].state}</div>${describe?.(di) || ""}<div class="r muted">Click for a close-up map</div>`;
      tip.classList.add("show");
      const r = tip.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
      tip.style.top = `${Math.min(e.clientY + 14, innerHeight - r.height - 8)}px`;
    } else tip.classList.remove("show");
  });
  over.addEventListener("pointerleave", () => { hover = -1; document.getElementById("tooltip").classList.remove("show"); });
  over.addEventListener("click", (e) => {
    const [x, y] = local(e);
    const pin = mode === "orbit" ? pinAt(x, y) : null;
    if (pin) { document.getElementById("tooltip").classList.remove("show"); onRegion ? onRegion(pin.slug) : fly("area"); }
    else if (mode === "orbit" && (x - cam.cx) ** 2 + (y - cam.cy) ** 2 < cam.R ** 2) fly("area");
    else if (mode === "area") {
      const di = districtAt(x, y);
      if (di >= 0) { document.getElementById("tooltip").classList.remove("show"); onPlace?.({ kind: "district", id: di }); }
    }
  });

  let visible = true;
  new IntersectionObserver(([en]) => (visible = en.isIntersecting)).observe(root);
  new ResizeObserver(() => resize()).observe(root);
  resize();
  requestAnimationFrame(frame);

  return {
    flyToArea: () => fly("area"),
    flyHome: () => fly("orbit"),
    get mode() { return mode; },
    setFireDots(fd) { fireDots = fd; dotsFor = ""; },
    // room on the right for the close-up panel; the study area glides aside
    setInset(px) {
      if (px === inset) return;
      inset = px;
      if (mode === "area" && !reduceMotion) {
        flight = { a: { ...cam }, b: areaCam(), t0: performance.now(), ms: 700, to: "area", keep: true };
        mode = "flying";
      } else if (mode === "area") Object.assign(cam, areaCam());
    },
    hasWebGL: !!prog,
  };
}
