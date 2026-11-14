// Compare two places on the same scale: a typical year, yearly totals and the
// key numbers side by side. Places can be any study area, any district of the
// area on screen, or the selection on the map.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import * as E from "./engine.js";
import * as S from "./season.js";
import { el, fmt, pct, axis, short, showTip, hideTip, MONTHS, MONTH_NAMES } from "./viz.js";

export const PAIR = { a: "#e8622a", b: "#6aa6f5" };
const KM_LAT = 110.57, KM_LON = 111.32;

// ------------------------------------------------------------- areas
function ringKm2(r) {
  const lat0 = (r.reduce((s, p) => s + p[1], 0) / r.length) * Math.PI / 180;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += (r[j][0] * KM_LON * Math.cos(lat0)) * (r[i][1] * KM_LAT) - (r[i][0] * KM_LON * Math.cos(lat0)) * (r[j][1] * KM_LAT);
  }
  return Math.abs(a) / 2;
}
function inRing(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// area of an even-odd set of rings: rings inside an odd number of others are holes
export function ringsKm2(rings) {
  return rings.reduce((sum, r, i) => {
    const depth = rings.filter((o, j) => j !== i && inRing(o, r[0][0], r[0][1])).length;
    return sum + (depth % 2 ? -1 : 1) * ringKm2(r);
  }, 0);
}
const boxKm2 = ([s, w, n, e]) => (n - s) * KM_LAT * (e - w) * KM_LON * Math.cos(((s + n) / 2) * Math.PI / 180);

// ------------------------------------------------------------- data
export function createCompare(root, ctx) {
  const cache = new Map();                       // region slug -> { meta, rows, districts }
  cache.set(ctx.current?.slug || "_", { meta: ctx.meta, rows: ctx.rows, districts: ctx.districts });
  const view = { a: "sel", b: null, mode: "area" };

  async function region(slug) {
    if (cache.has(slug)) return cache.get(slug);
    const base = `data/${slug}/`;
    const [meta, buf, districts] = await Promise.all([
      fetch(`${base}meta.json`).then((r) => r.json()),
      fetch(`${base}cells.bin`).then((r) => r.arrayBuffer()),
      fetch(`${base}districts.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (districts) {
      districts.focusIds ||= districts.districts.filter((d) => districts.focus.includes(d.state)).map((d) => d.id);
    }
    const v = { meta, rows: E.decode(meta, buf), districts };
    cache.set(slug, v);
    return v;
  }

  // a choice -> { name, area km², source data, selection options }
  async function resolve(choice) {
    const here = cache.get(ctx.current?.slug || "_");
    if (choice.startsWith("region:")) {
      const slug = choice.slice(7), r = ctx.regions.find((x) => x.slug === slug);
      const src = await region(slug), d = src.districts;
      if (d?.focusIds?.length) {
        return { name: r.name, src, opts: { mask: E.districtMask(src.meta, d.cellDistrict, d.focusIds) },
                 area: d.focusIds.reduce((s, i) => s + ringsKm2(d.districts[i].rings), 0) };
      }
      return { name: r.name, src, opts: { bbox: src.meta.bbox }, area: boxKm2(src.meta.bbox) };
    }
    if (choice.startsWith("district:")) {
      const id = +choice.slice(9), d = here.districts.districts[id];
      return { name: `${d.name}, ${d.state}`, src: here, area: ringsKm2(d.rings),
               opts: { mask: E.districtMask(here.meta, here.districts.cellDistrict, [id]) } };
    }
    const sel = ctx.getSel();                      // the selection on the map
    if (sel.kind === "districts") {
      return { name: ctx.selName(sel), src: here, opts: { mask: E.districtMask(here.meta, here.districts.cellDistrict, sel.ids) },
               area: sel.ids.reduce((s, i) => s + ringsKm2(here.districts.districts[i].rings), 0) };
    }
    return { name: ctx.selName(sel), src: here, opts: { bbox: sel.bbox }, area: boxKm2(sel.bbox) };
  }

  function measure(p, years) {
    const st = ctx.state;
    const res = E.analyse(p.src.meta, p.src.rows, { ...p.opts, method: st.method, aquaOnly: st.aquaOnly, viirsAll: st.viirsAll });
    const curve = S.seasonCurve(p.src.meta, res.harm, years[0], years[1]);
    const annual = [...res.annualHarm.entries()].filter(([y, v]) => Number.isFinite(v) && y >= years[0] && y <= years[1])
      .sort((a, b) => a[0] - b[0]);
    const cal = E.calendar(res.hMonths, years[0], years[1]);
    const byMonth = MONTHS.map((_, i) => {
      const v = cal.values.map((r) => r[i]).filter(Number.isFinite).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : NaN;
    });
    const timing = curve && curve.ref.length >= 3 ? S.seasonTiming(curve).filter((t) => t.rows.length >= 6) : [];
    const main = timing.reduce((b, t) => (!b || t.window.share > b.window.share ? t : b), null);
    return { ...p, res, curve, annual, byMonth, main, trend: S.yearlyTrend(annual),
             perYear: annual.length ? annual.reduce((s, [, v]) => s + v, 0) / annual.length : NaN };
  }

  // years both places observed, within the years chosen above
  function sharedYears(a, b) {
    const span = (src) => [E.dayToDate(src.meta, Math.min(src.meta.coverage.MODIS[0], src.meta.coverage.VIIRS[0])).getUTCFullYear(),
                           E.dayToDate(src.meta, Math.max(src.meta.coverage.MODIS[1], src.meta.coverage.VIIRS[1])).getUTCFullYear()];
    const [a0, a1] = span(a.src), [b0, b1] = span(b.src);
    return [Math.max(a0, b0, ctx.state.yearFrom ?? -Infinity), Math.min(a1, b1, ctx.state.yearTo ?? Infinity)];
  }

  // ------------------------------------------------------------- render
  const $ = (id) => root.querySelector(`#${id}`);
  function options() {
    const here = cache.get(ctx.current?.slug || "_");
    const regs = ctx.regions.length ? ctx.regions : [];
    const focus = here.districts ? here.districts.focusIds.map((i) => here.districts.districts[i])
      .filter((d) => d.cells > 0).sort((x, y) => x.state.localeCompare(y.state) || x.name.localeCompare(y.name)) : [];
    const byState = new Map();
    for (const d of focus) { if (!byState.has(d.state)) byState.set(d.state, []); byState.get(d.state).push(d); }
    return `<option value="sel">Your selection on the map</option>` +
      (regs.length ? `<optgroup label="Study areas">${regs.map((r) => `<option value="region:${r.slug}">${r.name}</option>`).join("")}</optgroup>` : "") +
      [...byState].map(([st, ds]) => `<optgroup label="Districts of ${st}">${ds.map((d) => `<option value="district:${d.id}">${d.name}</option>`).join("")}</optgroup>`).join("");
  }
  function defaultB() {
    const other = ctx.regions.find((r) => r.slug !== ctx.current?.slug);
    if (other) return `region:${other.slug}`;
    if (ctx.current) return `region:${ctx.current.slug}`;
    const here = cache.get("_");
    const id = here.districts?.focusIds?.[0];
    return id != null ? `district:${id}` : "sel";
  }

  let busy = 0;
  async function render() {
    const html = options();
    for (const k of ["a", "b"]) {
      const s = $(`cmp-${k}`);
      if (s.dataset.html !== html) { s.innerHTML = html; s.dataset.html = html; }
    }
    view.b ||= defaultB();
    $("cmp-a").value = view.a; $("cmp-b").value = view.b;
    if ($("cmp-a").value !== view.a) view.a = $("cmp-a").value = "sel";
    if ($("cmp-b").value !== view.b) view.b = $("cmp-b").value = defaultB();
    const ticket = ++busy;
    $("cmp-status").textContent = "Comparing…";
    let A, B;
    try {
      const [pa, pb] = await Promise.all([resolve(view.a), resolve(view.b)]);
      if (ticket !== busy) return;
      const years = sharedYears(pa, pb);
      A = measure(pa, years); B = measure(pb, years);
      A.years = B.years = years;
    } catch (err) {
      if (ticket !== busy) return;
      $("cmp-status").textContent = `Could not compare these places: ${err.message}`;
      $("cmp-body").hidden = true;
      return;
    }
    $("cmp-status").textContent = `Years compared: ${A.years[0]}–${A.years[1]}, when both places have data. ` +
      `Each place is harmonized with its own scaling factors.`;
    $("cmp-body").hidden = false;
    table(A, B);
    legend(A, B);
    typicalChart($("cmp-year-svg"), A, B, view.mode);
    yearsChart($("cmp-total-svg"), A, B, view.mode);
  }

  const unit = (mode) => (mode === "area" ? "fire-days per 1,000 km²" : mode === "share" ? "% of the year" : "fire-days");
  function scale(P, mode) { return mode === "area" ? 1000 / P.area : 1; }

  function legend(A, B) {
    $("cmp-legend").innerHTML = [[A, PAIR.a], [B, PAIR.b]].map(([P, c]) =>
      `<li><i style="background:${c}"></i>${P.name}</li>`).join("");
  }

  function table(A, B) {
    const peak = (P) => { const m = Math.max(...P.byMonth.filter(Number.isFinite)); const i = P.byMonth.indexOf(m); return i >= 0 ? MONTH_NAMES[i] : "–"; };
    const periods = (P) => (P.curve?.periods.length
      ? [...P.curve.periods].sort((x, y) => x.start - y.start).map((p) => `${S.doyLabel(p.start)} – ${S.doyLabel(p.end)}`).join("; ") : "–");
    const trend = (P) => (Number.isFinite(P.trend.pct) ? `${pct(P.trend.pct)} a year${P.trend.p < 0.05 ? "" : " (not clear)"}` : "–");
    const shift = (P) => {
      if (!P.main) return "–";
      const v = P.main.midShift.perDecade;
      return `${Math.abs(v) < 1 ? "about the same" : `${fmt(Math.abs(v), 1)} days ${v > 0 ? "later" : "earlier"} per decade`}${P.main.midShift.p < 0.05 ? "" : " (not clear)"}`;
    };
    const rowsHtml = [
      ["Area", (P) => `${fmt(P.area)} km²`],
      ["Fire-days a year (average)", (P) => fmt(P.perYear)],
      ["Fire-days a year per 1,000 km²", (P) => fmt(P.perYear * 1000 / P.area, 1)],
      ["Busiest month", peak],
      ["Critical periods", periods],
      ["Long-term trend", trend],
      ["Main season's halfway date", shift],
    ].map(([k, f]) => `<tr><th scope="row">${k}</th><td>${f(A)}</td><td>${f(B)}</td></tr>`).join("");
    $("cmp-table").innerHTML = `<thead><tr><th></th><th><i class="sw" style="background:${PAIR.a}"></i>${A.name}</th>` +
      `<th><i class="sw" style="background:${PAIR.b}"></i>${B.name}</th></tr></thead><tbody>${rowsHtml}</tbody>`;
  }

  // a typical year for both places, as medians with light bands
  function typicalChart(svg, A, B, mode) {
    svg._cmp = () => typicalChart(svg, A, B, view.mode);
    observe(svg);
    const W = svg.clientWidth || svg.parentElement.clientWidth;
    if (W < 80 || !A.curve || !B.curve) return;
    const H = 300, m = { l: 52, r: 14, t: 16, b: 30 };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("height", H); svg.replaceChildren();
    const conv = (P) => {
      if (mode === "share") {
        const tot = P.curve.med.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) || 1;
        return (v) => (100 * v) / tot;
      }
      const f = scale(P, mode);
      return (v) => v * f;
    };
    const ca = conv(A), cb = conv(B);
    const all = [...A.curve.p90].map(ca).concat([...B.curve.p90].map(cb)).filter(Number.isFinite);
    const ax = axis(Math.max(1e-6, ...all));
    const x = (j) => m.l + (j / 364) * (W - m.l - m.r), yv = (v) => H - m.b - (v / ax.max) * (H - m.t - m.b);
    gridY(svg, ax, m, W, yv);
    [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334].forEach((d, i) => {
      if (W < 520 && i % 2) return;
      el("text", { x: x(d + 14), y: H - 10, "text-anchor": "middle" }, svg).textContent = MONTHS[i];
    });
    for (const [P, c, f] of [[A, PAIR.a, ca], [B, PAIR.b, cb]]) {
      let band = "";
      for (let j = 0; j < 365; j++) if (Number.isFinite(P.curve.p90[j])) band += `${band ? "L" : "M"}${x(j).toFixed(1)},${yv(f(P.curve.p90[j])).toFixed(1)}`;
      for (let j = 364; j >= 0; j--) if (Number.isFinite(P.curve.p10[j])) band += `L${x(j).toFixed(1)},${yv(f(P.curve.p10[j])).toFixed(1)}`;
      if (band) el("path", { d: `${band}Z`, fill: c, opacity: 0.13 }, svg);
    }
    for (const [P, c, f] of [[A, PAIR.a, ca], [B, PAIR.b, cb]]) {
      let d = "";
      P.curve.med.forEach((v, j) => { if (Number.isFinite(v)) d += `${d ? "L" : "M"}${x(j).toFixed(1)},${yv(f(v)).toFixed(1)}`; });
      el("path", { d, class: "series", stroke: c }, svg);
    }
    hover(svg, W, H, m, (px) => Math.max(0, Math.min(364, Math.round(((px - m.l) / (W - m.l - m.r)) * 364))), x,
      (j) => `<div class="t">${S.doyLabel(j)}, usual</div>` +
        [[A, PAIR.a, ca], [B, PAIR.b, cb]].map(([P, c, f]) => `<div class="r"><span><i class="sw" style="background:${c}"></i>${P.name}</span><b>${fmt(f(P.curve.med[j]), mode === "share" ? 2 : 1)}</b></div>`).join("") +
        `<div class="r muted">${unit(mode)}${mode === "share" ? " per day" : " per day, 15-day average"}</div>`);
  }

  // yearly totals for both places
  function yearsChart(svg, A, B, mode) {
    svg._cmp = () => yearsChart(svg, A, B, view.mode);
    observe(svg);
    const W = svg.clientWidth || svg.parentElement.clientWidth;
    if (W < 80) return;
    const H = 260, m = { l: 52, r: 14, t: 16, b: 30 };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("height", H); svg.replaceChildren();
    const years = [...new Set([...A.annual, ...B.annual].map(([y]) => y))].sort((a, b) => a - b);
    if (years.length < 2) return;
    const conv = (P) => {
      if (mode === "share") { const avg = P.perYear || 1; return (v) => (100 * v) / avg; }
      const f = scale(P, mode); return (v) => v * f;
    };
    const ca = conv(A), cb = conv(B);
    const ax = axis(Math.max(1e-6, ...A.annual.map(([, v]) => ca(v)), ...B.annual.map(([, v]) => cb(v))));
    const x = (y) => m.l + ((y - years[0]) / (years.at(-1) - years[0])) * (W - m.l - m.r);
    const yv = (v) => H - m.b - (v / ax.max) * (H - m.t - m.b);
    gridY(svg, ax, m, W, yv);
    const every = W < 520 ? 5 : 2;
    years.forEach((y, i) => { if (i % every === 0 || i === years.length - 1) el("text", { x: x(y), y: H - 10, "text-anchor": "middle" }, svg).textContent = y; });
    if (mode === "share") el("line", { x1: m.l, x2: W - m.r, y1: yv(100), y2: yv(100), stroke: "rgba(238,241,247,.5)", "stroke-dasharray": "4 4" }, svg);
    for (const [P, c, f] of [[A, PAIR.a, ca], [B, PAIR.b, cb]]) {
      const d = P.annual.map(([y, v], i) => `${i ? "L" : "M"}${x(y).toFixed(1)},${yv(f(v)).toFixed(1)}`).join("");
      el("path", { d, class: "series", stroke: c }, svg);
      for (const [y, v] of P.annual) el("circle", { cx: x(y), cy: yv(f(v)), r: 2.6, fill: c }, svg);
    }
    const mapA = new Map(A.annual), mapB = new Map(B.annual);
    hover(svg, W, H, m, (px) => years.reduce((b, y) => (Math.abs(x(y) - px) < Math.abs(x(b) - px) ? y : b)), x,
      (y) => `<div class="t">${y}</div>` +
        [[A, PAIR.a, ca, mapA], [B, PAIR.b, cb, mapB]].map(([P, c, f, mp]) => `<div class="r"><span><i class="sw" style="background:${c}"></i>${P.name}</span><b>${mp.has(y) ? fmt(f(mp.get(y)), mode === "share" ? 0 : 1) : "–"}</b></div>`).join("") +
        `<div class="r muted">${mode === "share" ? "% of its average year" : unit(mode)}</div>`);
  }

  function gridY(svg, ax, m, W, yv) {
    const g = el("g", { class: "grid" }, svg);
    for (const t of ax.ticks) {
      el("line", { x1: m.l, x2: W - m.r, y1: yv(t), y2: yv(t) }, g);
      el("text", { x: m.l - 10, y: yv(t) + 4, "text-anchor": "end" }, svg).textContent = short(t, ax.digits);
    }
  }
  function hover(svg, W, H, m, pick, x, html) {
    const cross = el("line", { class: "crosshair", y1: m.t, y2: H - m.b, opacity: 0 }, svg);
    const hit = el("rect", { x: m.l, y: m.t, width: Math.max(0, W - m.l - m.r), height: Math.max(0, H - m.t - m.b), fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect(), k = pick(((e.clientX - r.left) / r.width) * W);
      cross.setAttribute("x1", x(k)); cross.setAttribute("x2", x(k)); cross.setAttribute("opacity", 1);
      showTip(e, html(k));
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", 0); hideTip(); });
  }
  function observe(svg) {
    if (svg._cmpRO) return;
    svg._cmpRO = new ResizeObserver(() => svg._cmp?.());
    svg._cmpRO.observe(svg.parentElement);
  }

  // ------------------------------------------------------------- wiring
  $("cmp-a").addEventListener("change", (e) => { view.a = e.target.value; render(); });
  $("cmp-b").addEventListener("change", (e) => { view.b = e.target.value; render(); });
  $("cmp-swap").addEventListener("click", () => { [view.a, view.b] = [view.b, view.a]; render(); });
  $("cmp-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("cmp-mode").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    view.mode = b.dataset.v;
    $("cmp-year-svg")._cmp?.(); $("cmp-total-svg")._cmp?.();
    $("cmp-unit").textContent = view.mode === "share" ? "Each place as a share of its own burning, so timing can be compared whatever the size."
      : view.mode === "area" ? "Per 1,000 km² of each place, so places of different size can be compared." : "Totals for each place.";
  });

  // work only once the section is near the screen, so visitors who never
  // scroll here do not download a second area's data
  let near = false, dirty = true;
  new IntersectionObserver((entries) => {
    near = entries.some((e) => e.isIntersecting);
    if (near && dirty) { dirty = false; render(); }
  }, { rootMargin: "600px 0px" }).observe(root);
  return {
    render() { if (near) { dirty = false; render(); } else dirty = true; },
    view,
  };
}
