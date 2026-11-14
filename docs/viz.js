// Charts for the Burning Activity Calendar: plain SVG and HTML, no libraries.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
                            "August", "September", "October", "November", "December"];
export const COLORS = { modis: "#3987e5", viirs: "#199e70", harm: "#d95926" };
const NS = "http://www.w3.org/2000/svg";
export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export const fmt = (v, d = 0) => (Number.isFinite(v)
  ? v.toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
export const pct = (v) => (Number.isFinite(v) ? `${v > 0 ? "+" : ""}${fmt(v)}%` : "–");

export function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

// --------------------------------------------------------------- color
const EMBER = ["#2a1309", "#5a1d07", "#8f2c08", "#c4420f", "#e8622a", "#f58f4a",
               "#fbbd7d", "#ffe6bf"];
const DIVERGING = [[-100, "#6aa6f5"], [-50, "#3c6fb8"], [0, "#383a40"],
                   [50, "#b8483f"], [100, "#f37a5f"]];
export const ZERO = "#151a26";
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const A = hex(a), B = hex(b);
  return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(",")})`;
};
export function ember(t) {               // t in [0, 1]
  t = Math.max(0, Math.min(1, t)) * (EMBER.length - 1);
  const i = Math.min(EMBER.length - 2, Math.floor(t));
  return mix(EMBER[i], EMBER[i + 1], t - i);
}
export function diverging(p) {           // percent difference
  p = Math.max(-100, Math.min(100, p));
  for (let i = 0; i < DIVERGING.length - 1; i++) {
    const [a, ca] = DIVERGING[i], [b, cb] = DIVERGING[i + 1];
    if (p <= b) return mix(ca, cb, (p - a) / (b - a));
  }
  return DIVERGING.at(-1)[1];
}
export const emberGradient = `linear-gradient(90deg, ${EMBER.join(",")})`;
export const divergingGradient =
  `linear-gradient(90deg, ${DIVERGING.map(([, c]) => c).join(",")})`;

// ------------------------------------------------------------- tooltip
const tip = () => document.getElementById("tooltip");
export function showTip(evt, html) {
  const t = tip();
  t.innerHTML = html;
  t.classList.add("show");
  const pad = 14, r = t.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
export const hideTip = () => tip().classList.remove("show");

// ----------------------------------------------------------- scales
// Round axis: a nice step (1, 2, 2.5 or 5 x 10^n) and a top that is a multiple of it.
function axis(v, n = 4) {
  if (!(v > 0)) v = 1;
  const raw = v / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  const max = Math.ceil(v / step - 1e-9) * step;
  const digits = step < 1 ? (Number.isInteger(step * 10) ? 1 : 2) : Number.isInteger(step) ? 0 : 1;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step), digits };
}
const short = (v, d = 0) => (v >= 1e6 ? `${fmt(v / 1e6, 1)}M` : v >= 1e4 ? `${fmt(v / 1e3)}k` : fmt(v, d));
// Pick labels every `every` items, always keep `keep`, and drop any label that would
// sit closer than `every` to a kept one.
function labelIndexes(n, every, keep) {
  const out = new Set(keep.filter((k) => k >= 0 && k < n));
  for (let i = 0; i < n; i += every) {
    if ([...out].every((k) => Math.abs(k - i) >= every)) out.add(i);
  }
  return out;
}

// --------------------------------------------------------- line chart
// series: [{ id, name, color, values: Map(year -> number) }]
export function lineChart(svg, { series, height, yLabel, marker }) {
  const state = { visible: Object.fromEntries(series.map((s) => [s.id, 1])), drawn: new Set() };
  // only years with at least one complete value
  const years = [...new Set(series.flatMap((s) => [...s.values.entries()]
    .filter(([, v]) => Number.isFinite(v)).map(([y]) => y)))].sort((a, b) => a - b);
  const finite = (s) => years.filter((y) => Number.isFinite(s.values.get(y)));

  function render() {
    const W = svg.clientWidth || svg.parentElement.clientWidth;
    const H = typeof height === "function" ? height() : height;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", H);
    svg.replaceChildren();
    const m = { l: 48, r: W < 520 ? 72 : 96, t: 16, b: 34 };
    const ax = axis(Math.max(...series.flatMap((s) => finite(s).map((y) => s.values.get(y)))));
    const x = (y) => m.l + ((y - years[0]) / Math.max(1, years.at(-1) - years[0])) * (W - m.l - m.r);
    const yv = (v) => H - m.b - (v / ax.max) * (H - m.t - m.b);
    const g = el("g", { class: "grid" }, svg);
    for (const t of ax.ticks) {
      el("line", { x1: m.l, x2: W - m.r, y1: yv(t), y2: yv(t) }, g);
      el("text", { x: m.l - 10, y: yv(t) + 4, "text-anchor": "end" }, svg).textContent = short(t, ax.digits);
    }
    const every = W < 520 ? 5 : 2;
    for (const i of labelIndexes(years.length, every, [0, years.length - 1])) {
      el("text", { x: x(years[i]), y: H - 10, "text-anchor": "middle" }, svg).textContent = years[i];
    }
    const yl = el("text", { class: "axis-title", x: m.l, y: m.t - 4 }, svg);
    yl.textContent = yLabel;
    if (marker) {
      const mx = x(marker.year);
      el("line", { x1: mx, x2: mx, y1: m.t + 10, y2: H - m.b, stroke: "rgba(163,181,222,.35)",
                   "stroke-dasharray": "3 4" }, svg);
      el("text", { class: "note", x: mx + 8, y: m.t + 22, opacity: marker.opacity() }, svg)
        .textContent = marker.text();
    }
    for (const s of series) {
      const ys = finite(s);
      if (!ys.length) continue;
      const d = ys.map((y, i) => `${i ? "L" : "M"}${x(y).toFixed(1)},${yv(s.values.get(y)).toFixed(1)}`).join("");
      const p = el("path", { d, class: "series", stroke: s.color, opacity: state.visible[s.id] }, svg);
      const last = ys.at(-1);
      el("text", { class: `label ${s.id}`, x: x(last) + 8, y: yv(s.values.get(last)) + 4,
                   opacity: state.visible[s.id] }, svg).textContent = s.name;
      if (state.visible[s.id] > 0 && !state.drawn.has(s.id) && !reduceMotion) {
        const len = p.getTotalLength();
        p.style.strokeDasharray = `${len}`;
        p.style.strokeDashoffset = `${len}`;
        p.getBoundingClientRect();
        p.style.transition = "stroke-dashoffset 1.4s cubic-bezier(.3,.7,.2,1), opacity .6s";
        p.style.strokeDashoffset = "0";
      }
      if (state.visible[s.id] > 0) state.drawn.add(s.id);
    }
    // hover layer: crosshair + tooltip with every visible series
    const cross = el("line", { class: "crosshair", y1: m.t, y2: H - m.b, opacity: 0 }, svg);
    const hit = el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b,
                             fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const year = years.reduce((b, y) => (Math.abs(x(y) - px) < Math.abs(x(b) - px) ? y : b));
      cross.setAttribute("x1", x(year)); cross.setAttribute("x2", x(year));
      cross.setAttribute("opacity", 1);
      const rowsHtml = series.filter((s) => state.visible[s.id] > 0.5).map((s) =>
        `<div class="r"><span><i class="sw" style="background:${s.color}"></i>${s.name}</span><b>${fmt(s.values.get(year))}</b></div>`).join("");
      showTip(e, `<div class="t">${year}</div>${rowsHtml || '<div class="r">No complete data</div>'}`);
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", 0); hideTip(); });
  }
  new ResizeObserver(() => render()).observe(svg.parentElement);
  return {
    setVisible(v) { Object.assign(state.visible, v); render(); },
    render,
  };
}

// ------------------------------------------------------------ calendar
export function renderCalendar(root, scaleRoot, cal, { mode, lastDate, onCell }) {
  root.replaceChildren();
  const head = (txt, cls) => { const d = document.createElement("div"); d.className = cls; d.textContent = txt; root.appendChild(d); };
  head("", "mh");
  MONTHS.forEach((m) => head(m, "mh"));
  // log scale stretched between the quietest and busiest month shown
  const all = cal.values.flat().filter((v) => Number.isFinite(v) && v > 0);
  const lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1;
  const tOf = (v) => (hi > lo ? (Math.log1p(v) - Math.log1p(lo)) / (Math.log1p(hi) - Math.log1p(lo)) : 1);
  const medians = MONTHS.map((_, mi) => median(cal.values.map((r) => r[mi]).filter(Number.isFinite)));
  cal.years.forEach((year, yi) => {
    head(year, "yh");
    cal.values[yi].forEach((v, mi) => {
      const c = document.createElement("div");
      c.className = "c";
      c.tabIndex = -1;
      c.setAttribute("role", "gridcell");
      const inProgress = lastDate && year === lastDate.getUTCFullYear() && mi === lastDate.getUTCMonth();
      if (!Number.isFinite(v)) {
        c.classList.add("na");
      } else if (mode === "activity") {
        c.style.background = v > 0 ? ember(0.06 + 0.94 * tOf(v)) : ZERO;
      } else {
        const p = medians[mi] > 0 ? (100 * (v / medians[mi] - 1)) : NaN;
        c.style.background = Number.isFinite(p) && !inProgress ? diverging(p) : ZERO;
      }
      const diff = medians[mi] > 0 ? 100 * (v / medians[mi] - 1) : NaN;
      const label = `${MONTH_NAMES[mi]} ${year}: ${Number.isFinite(v) ? `${fmt(v)} fire-days` : "no satellite observation"}`;
      c.setAttribute("aria-label", label);
      c.addEventListener("pointermove", (e) => onCell(e, { year, mi, v, diff, inProgress, cell: cal.cells[yi][mi] }));
      c.addEventListener("pointerleave", hideTip);
      root.appendChild(c);
    });
  });
  // one roving tab stop for keyboard users
  const cells = [...root.querySelectorAll(".c")];
  if (cells.length) cells.at(-1).tabIndex = 0;
  root.onkeydown = (e) => {
    const i = cells.indexOf(document.activeElement);
    if (i < 0) return;
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 12, ArrowUp: -12 }[e.key];
    if (!d || !cells[i + d]) return;
    e.preventDefault();
    cells[i].tabIndex = -1; cells[i + d].tabIndex = 0; cells[i + d].focus();
  };
  root.onfocusin = (e) => {
    if (!e.target.classList.contains("c")) return;
    const r = e.target.getBoundingClientRect();
    showTip({ clientX: r.right, clientY: r.bottom }, `<div class="t">${e.target.getAttribute("aria-label")}</div>`);
  };
  root.onfocusout = hideTip;

  scaleRoot.innerHTML = mode === "activity"
    ? `<span>${fmt(lo)}</span><span class="bar" style="background:${emberGradient}"></span><span>${fmt(hi)} fire-days per month (log scale)</span><span><i class="na"></i>No observation</span>`
    : `<span>−100%</span><span class="bar" style="background:${divergingGradient}"></span><span>+100% or more, against that month's median</span><span><i class="na"></i>No observation</span>`;
  return medians;
}

export function calendarTable(root, cal) {
  const rows = cal.years.map((y, yi) =>
    `<tr><td>${y}</td>${cal.values[yi].map((v) => `<td>${Number.isFinite(v) ? fmt(v) : "–"}</td>`).join("")}</tr>`).join("");
  root.innerHTML = `<table class="data"><thead><tr><th>Year</th>${MONTHS.map((m) => `<th>${m}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// ------------------------------------------------------------ bar chart
export function barChart(svg, cfg) {
  svg._bar = cfg;                     // redraws reuse one resize observer
  if (!svg._barRO) {
    svg._barRO = new ResizeObserver(() => drawBars(svg));
    svg._barRO.observe(svg.parentElement);
  }
  drawBars(svg);
}

function drawBars(svg) {
  const { items, highlight, refLine, refLabel, unit, height = 300,
          color = "#4a5470", hiColor = "#f17f3a", labelEvery } = svg._bar;
  {
    const W = svg.clientWidth || svg.parentElement.clientWidth;
    const H = height;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", H);
    svg.replaceChildren();
    if (!items.length) return;
    const m = { l: 48, r: 12, t: refLine != null ? 34 : 14, b: 30 };
    const ax = axis(Math.max(...items.map((d) => d.value).filter(Number.isFinite), refLine || 0));
    const bw = (W - m.l - m.r) / items.length;
    const yv = (v) => H - m.b - (v / ax.max) * (H - m.t - m.b);
    const g = el("g", { class: "grid" }, svg);
    for (const t of ax.ticks) {
      el("line", { x1: m.l, x2: W - m.r, y1: yv(t), y2: yv(t) }, g);
      el("text", { x: m.l - 10, y: yv(t) + 4, "text-anchor": "end" }, svg).textContent = short(t, ax.digits);
    }
    const every = labelEvery || (W < 560 ? 5 : 2);
    const hi = items.findIndex((d) => d.key === highlight);
    const shown = labelIndexes(items.length, every, [hi, 0]);
    items.forEach((d, i) => {
      const x = m.l + i * bw + 1, w = Math.max(1, bw - 2), y = yv(d.value), h = H - m.b - y;
      const r = Math.min(4, w / 2, h);
      const path = h > 0
        ? `M${x},${H - m.b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${H - m.b}Z`
        : "";
      if (path) el("path", { d: path, fill: d.key === highlight ? hiColor : color }, svg);
      if (shown.has(i)) {
        el("text", { x: x + w / 2, y: H - 10, "text-anchor": "middle" }, svg).textContent = d.label;
      }
      const hit = el("rect", { x: m.l + i * bw, y: m.t, width: bw, height: H - m.t - m.b, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", (e) => showTip(e, `<div class="t">${d.label}</div><div class="r"><span>${unit}</span><b>${fmt(d.value, d.digits || 0)}</b></div>`));
      hit.addEventListener("pointerleave", hideTip);
    });
    if (Number.isFinite(refLine)) {
      el("line", { x1: m.l, x2: W - m.r, y1: yv(refLine), y2: yv(refLine), stroke: "#eef1f7",
                   "stroke-dasharray": "4 4", "stroke-width": 1, "pointer-events": "none" }, svg);
      // label sits in the top margin with a key, clear of the bars
      el("line", { x1: W - m.r - 24, x2: W - m.r, y1: 8, y2: 8, stroke: "#eef1f7",
                   "stroke-dasharray": "4 4" }, svg);
      el("text", { x: W - m.r - 30, y: 12, "text-anchor": "end", class: "note" }, svg)
        .textContent = refLabel;
    }
  }
}
