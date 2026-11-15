// Burning Activity Calendar: page logic.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import * as E from "./engine.js";
import { lineChart, renderCalendar, calendarTable, barChart, showTip, fmt, pct, median,
         COLORS, MONTHS, MONTH_NAMES, seasonChart, timingChart, SEASON_COLORS } from "./viz.js";
import * as S from "./season.js";
import { createCompare } from "./compare.js";
import { createMap } from "./map.js";
import { createGlobe } from "./globe3d.js";
import { createMiniMap } from "./minimap.js";
import "./overview.js";            // "When India burns" (renders itself)
import { loadHotspots, aggregate, intensity, redGradient } from "./hotspots.js";

const $ = (id) => document.getElementById(id);
// selection: { kind: "bbox", bbox } or { kind: "districts", ids: [...] }
const DEFAULT_METHOD = "monthly";            // the team's chosen calibration
const state = { sel: null, method: DEFAULT_METHOD, aquaOnly: false, viirsAll: false,
                yearFrom: null, yearTo: null, calMode: "activity", allDistricts: false,
                compareYear: null, timingIdx: null, alertDays: 7, alertSort: { key: "ratio", dir: -1 },
                view: "simple" };
let season = null;                           // typical year for the current selection
let compare = null;
let hot = null, dotsKey = "";
let meta, rows, result, map, mini = null, districts = null, defaultSel, dStats = null, regionK = null;

// study areas: docs/data/regions.json lists them; ?region=<slug> picks one
let regions = [], current = null;
async function load() {
  try {
    const idx = await fetch("data/regions.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    regions = idx?.regions || [];
    const want = new URLSearchParams(location.search).get("region");
    current = regions.find((r) => r.slug === want) || regions[0] || null;
    const base = current ? `data/${current.slug}/` : "data/";
    // all four files at once: the record, the boundaries and the close-up spots
    const metaP = fetch(`${base}meta.json`).then((r) => { if (!r.ok) throw new Error(`meta.json: HTTP ${r.status}`); return r.json(); });
    const [m, b, d, h] = await Promise.all([
      metaP,
      fetch(`${base}cells.bin`).then((r) => { if (!r.ok) throw new Error(`cells.bin: HTTP ${r.status}`); return r.arrayBuffer(); }),
      fetch(`${base}districts.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      metaP.then((mm) => { mm.base = base; return loadHotspots(mm); }),
    ]);
    meta = m; rows = E.decode(meta, b); districts = d; hot = h;
    if (districts) {        // older exports: focus by whole states
      districts.focusIds ||= districts.districts.filter((x) => districts.focus.includes(x.state)).map((x) => x.id);
      districts.focusMode ||= "states";
    }
  } catch (err) {
    $("loading").innerHTML = navigator.onLine === false
      ? "You are offline. Connect to the internet and reload this page."
      : "The fire data could not be loaded. Reload the page to try again." +
        "<small>If you run this site yourself: build the data with python build_site.py.</small>";
    $("loading").classList.add("failed");
    throw err;
  }
  const focusIds = districts ? districts.focusIds : [];
  defaultSel = focusIds.length ? { kind: "districts", ids: focusIds, label: meta.region }
                               : { kind: "bbox", bbox: [...meta.bbox] };
  renderRegionPickers();
  state.sel = defaultSel;
  readUrl();
  $("sample-banner").hidden = !meta.sample;
  document.body.classList.toggle("has-banner", !!meta.sample);
  document.querySelectorAll(".region-name").forEach((n) => (n.textContent = meta.region));
  $("hero-text").textContent = `Since ${E.dayToDate(meta, meta.coverage.MODIS[0]).getUTCFullYear()}, NASA satellites have logged burning across ${meta.region}, with two instruments that count differently. This calendar puts them on one scale, so fire managers, scientists and land managers can see when burning happens and whether this season is unusual.`;
  $("data-note").textContent = `Data processed ${meta.generated}. Records from ${fmtDate(meta.coverage.MODIS[0])} to ${fmtDate(Math.max(meta.coverage.MODIS[1], meta.coverage.VIIRS[1]))}.`;

  hero();
  story();
  map = createMap($("map"), meta, { districts, describe: describeDistrict, onSelect: (sel) => {
    state.sel = sel; update();
    // a clicked district opens its close-up map; a drawn rectangle closes it
    if (mini && sel.kind === "districts" && sel.ids.length === 1) mini.open(sel.ids[0], [state.yearFrom, state.yearTo]);
    else mini?.close();
  } });
  if (districts) mini = createMiniMap($("mini"), meta, districts, rows,
    { onToggle: (w) => map.setInset(innerWidth >= 700 ? w : 0) });
  wireControls();
  wireEase();
  compare = createCompare($("compare"), { regions, current, meta, rows, districts, state,
                                         getSel: () => state.sel, selName });
  update();
  reveals();
  $("loading").classList.add("done");
  if (location.hash === "#fly") {               // arrived from another area's pin
    history.replaceState(null, "", location.pathname + location.search);
    setTimeout(() => globe.flyToArea(), reduced() ? 0 : 700);
  } else if (location.hash === "#explore") {    // arrived from the district search
    history.replaceState(null, "", location.pathname + location.search);
    setTimeout(() => {
      $("map").scrollIntoView({ behavior: "auto", block: "start" });
      if (mini && state.sel.kind === "districts" && state.sel.ids.length === 1) mini.open(state.sel.ids[0], [state.yearFrom, state.yearTo]);
    }, 50);
  }
}

const fmtDate = (d) => E.dayToDate(meta, d).toLocaleDateString("en-GB",
  { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------- hero globe
let globe, heroMini;
function hero() {
  const years = () => [state.yearFrom ?? firstYear(), state.yearTo ?? lastYear()];
  // this year's fires in the study area, as red dots on the globe
  const focusIds = defaultSel.kind === "districts" ? new Set(defaultSel.ids) : null;
  const y = lastYear();
  const fd = aggregate(meta, hot, rows, districts?.cellDistrict, { y0: y, y1: y, ids: focusIds });
  globe = createGlobe($("hero"), {
    meta, districts, describe: describeDistrict,
    regions, current: current?.slug, onRegion: goRegion,
    fireDots: { dots: fd.dots, t: intensity(fd.dots, fd.hasFrp), key: `${y}` },
    onPlace: (p) => heroMini?.open(p.id, years()),
    onMode: (m) => {
      const zoomed = m === "area" || m === "flying-area";
      $("hero").classList.toggle("zoomed", zoomed);
      $("places").hidden = m !== "area";
      $("places-tip").hidden = m !== "area";
      if (!zoomed) heroMini?.close();
    },
  });
  $("globe-go").addEventListener("click", () => globe.flyToArea());
  $("globe-back").addEventListener("click", () => globe.flyHome());
  if (districts) {
    heroMini = createMiniMap($("place-modal"), meta, districts, rows, {
      onToggle: (w) => {
        $("hero").classList.toggle("modal-open", w > 0);
        globe.setInset(innerWidth >= 960 && w > 0 ? w + 32 : 0);
      },
      onShow: (place) => {
        state.sel = { kind: "districts", ids: [...place.ids], label: place.ids.size > 1 ? place.title : undefined };
        heroMini.close();
        update();
        $("explore").scrollIntoView({ behavior: reduced() ? "auto" : "smooth" });
      },
    });
    // whole states get a chip each; part of a state gets one chip for the area
    const chips = districts.focusMode === "states"
      ? districts.focus.map((n) => `<button class="chip" type="button" data-state="${n}">${n}</button>`)
      : [`<button class="chip" type="button" data-area="1">${meta.region}</button>`];
    $("place-chips").innerHTML = chips.join("");
    $("place-chips").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b?.dataset.state) heroMini.openState(b.dataset.state, years());
      else if (b?.dataset.area) heroMini.openDistricts(meta.region, districts.focusIds, years());
    });
  } else {
    $("place-chips").previousElementSibling.hidden = true;
  }
}
// ---------------------------------------------------------- study areas
function goRegion(slug) {
  if (!slug || slug === current?.slug) { globe.flyToArea(); return; }
  location.href = `?region=${encodeURIComponent(slug)}#fly`;     // load that area, then fly in
}
function renderRegionPickers() {
  const story = current?.story || "";
  $("places-tip").textContent = `${story}${story ? " " : ""}${districts ? "Click any district for a close-up." : ""}`;
  if (regions.length < 2) { $("regions").hidden = true; $("region-select").hidden = true; return; }
  $("regions").innerHTML = `<span class="regions-label">Study areas</span>` + regions.map((r) =>
    `<button type="button" class="region${r.slug === current.slug ? " on" : ""}" data-slug="${r.slug}"
       aria-pressed="${r.slug === current.slug}">${r.name}</button>`).join("");
  $("regions").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-slug]"); if (b) goRegion(b.dataset.slug);
  });
  $("region-select").innerHTML = regions.map((r) =>
    `<option value="${r.slug}"${r.slug === current.slug ? " selected" : ""}>${r.name}</option>`).join("");
  $("region-select").addEventListener("change", (e) => {
    location.href = `?region=${encodeURIComponent(e.target.value)}${location.hash || ""}`;
  });
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const firstYear = () => E.dayToDate(meta, Math.min(meta.coverage.MODIS[0], meta.coverage.VIIRS[0])).getUTCFullYear();
const lastYear = () => E.dayToDate(meta, Math.max(meta.coverage.MODIS[1], meta.coverage.VIIRS[1])).getUTCFullYear();

// sections ease in as they scroll into view
function reveals() {
  const els = document.querySelectorAll(".reveal");
  if (reduced() || !("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
  }), { rootMargin: "0px 0px -8% 0px" });
  els.forEach((e) => io.observe(e));
}

// ---------------------------------------------------------- scroll story
function story() {
  const r = E.analyse(meta, rows, { ...selOpts(defaultSel), method: "monthly" });
  const series = [
    { id: "modis", name: "MODIS", color: COLORS.modis, values: r.annualModis },
    { id: "viirs", name: "VIIRS", color: COLORS.viirs, values: r.annualViirs },
    { id: "harm", name: "Harmonized", color: COLORS.harm, values: r.annualHarm },
  ];
  const jump = r.steps?.rawSplice;
  if (Number.isFinite(jump)) $("story-jump").textContent = `about ${fmt(jump, 1)} times higher`;
  if (r.steps) {
    const y0 = E.dayToDate(meta, meta.coverage.MODIS[0]).getUTCFullYear();
    $("story-years").textContent = `${y0}–${r.steps.year - 1}`;
  }
  let step = 0;
  $("story-legend").innerHTML = series.map((s) =>
    `<li data-id="${s.id}"><i style="background:${s.color}"></i>${s.name}</li>`).join("");
  const chart = lineChart($("story-svg"), {
    series, yLabel: "Fire-days per year",
    height: () => Math.max(260, Math.min(520, $("story-svg").parentElement.clientHeight - 70)),
    marker: r.steps && {
      year: r.steps.year,
      text: () => (step === 1 && Number.isFinite(jump) ? `VIIRS begins: ×${fmt(jump, 1)} jump` : "VIIRS begins"),
      opacity: () => (step >= 1 ? 1 : 0),
    },
  });
  const states = [
    { modis: 1, viirs: 0, harm: 0 },
    { modis: 1, viirs: 1, harm: 0 },
    { modis: 0.28, viirs: 0.28, harm: 1 },
  ];
  const apply = (i) => {
    step = i;
    chart.setVisible(states[i]);
    document.querySelectorAll("#story-legend li").forEach((li) =>
      (li.style.opacity = states[i][li.dataset.id] > 0.5 ? 1 : 0.35));
    document.querySelectorAll(".story-step").forEach((s) =>
      s.classList.toggle("active", +s.dataset.step === i));
  };
  apply(0);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) apply(+e.target.dataset.step);
  }, { rootMargin: "-45% 0px -45% 0px" });
  document.querySelectorAll(".story-step").forEach((s) => io.observe(s));
}

// ---------------------------------------------------------- controls
function seg(id, key, after) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $(id).querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    state[key] = b.dataset.v;
    after();
  });
}
function wireControls() {
  seg("method", "method", update);
  seg("cal-mode", "calMode", renderCalendarBlock);
  $("aqua-only").addEventListener("change", (e) => { state.aquaOnly = e.target.checked; update(); });
  $("viirs-all").addEventListener("change", (e) => { state.viirsAll = e.target.checked; update(); });
  $("reset-area").addEventListener("click", () => { state.sel = defaultSel; mini?.close(); update(); });
  $("apply-coords").addEventListener("click", () => {
    const v = ["c-s", "c-w", "c-n", "c-e"].map((id) => parseFloat($(id).value));
    if (v.some((x) => !Number.isFinite(x)) || v[0] >= v[2] || v[1] >= v[3]) {
      return message("Enter South below North and West left of East, in degrees.");
    }
    state.sel = { kind: "bbox", bbox: v }; mini?.close(); update();
  });
  for (const id of ["y-from", "y-to"]) $(id).addEventListener("change", () => {
    state.yearFrom = +$("y-from").value; state.yearTo = +$("y-to").value;
    if (state.yearFrom > state.yearTo) [state.yearFrom, state.yearTo] = [state.yearTo, state.yearFrom];
    renderAll();
    mini?.setYears([state.yearFrom, state.yearTo]);
  });
  $("cal-table-toggle").addEventListener("click", (e) => {
    const t = $("cal-table"); t.hidden = !t.hidden;
    e.target.textContent = t.hidden ? "View as table" : "Hide table";
  });
  $("districts-toggle").addEventListener("click", () => { state.allDistricts = !state.allDistricts; renderDistricts(); });
  $("dl-monthly").addEventListener("click", downloadMonthly);
  $("dl-daily").addEventListener("click", downloadDaily);
  $("dl-cells").addEventListener("click", downloadCells);
  $("dl-season").addEventListener("click", downloadSeason);
  $("dl-timing").addEventListener("click", downloadTiming);
  $("dl-districts").addEventListener("click", downloadDistricts);
  $("share").addEventListener("click", (e) => { writeUrl(); copyText(viewUrl(), e.currentTarget, "Link copied"); });
  $("copy-coords").addEventListener("click", (e) => copyText($("firms-coords").textContent, e.currentTarget, "Copied"));
  $("copy-cite").addEventListener("click", (e) => copyText($("cite-view").textContent, e.currentTarget, "Citation copied"));
  $("compare-year").addEventListener("change", (e) => {
    state.compareYear = +e.target.value || null;
    renderSeason(); writeUrl();
  });
  $("alert-days").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("alert-days").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    state.alertDays = +b.dataset.v; renderAlerts(); renderStatus();
  });
  $("timing-season").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.timingIdx = +b.dataset.i; renderTiming();
  });
}

// ------------------------------------------------- shareable view links
// ?region=&area=d:1,2|b:s,w,n,e&from=&to=&cal=&aqua=1&viirs=all&compare=
function readUrl() {
  const q = new URLSearchParams(location.search);
  const area = q.get("area") || "";
  if (area.startsWith("d:") && districts) {
    const n = districts.districts.length;
    const ids = area.slice(2).split(",").map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < n);
    if (ids.length) state.sel = { kind: "districts", ids };
  } else if (area.startsWith("b:")) {
    const v = area.slice(2).split(",").map(Number);
    if (v.length === 4 && v.every(Number.isFinite) && v[0] < v[2] && v[1] < v[3]) state.sel = { kind: "bbox", bbox: v };
  }
  if (["monthly", "simple"].includes(q.get("cal"))) state.method = q.get("cal");
  state.aquaOnly = q.get("aqua") === "1";
  state.viirsAll = q.get("viirs") === "all";
  const f = parseInt(q.get("from"), 10), t = parseInt(q.get("to"), 10);
  if (f && t) { state.yearFrom = Math.min(f, t); state.yearTo = Math.max(f, t); }
  if (parseInt(q.get("compare"), 10)) state.compareYear = parseInt(q.get("compare"), 10);
  $("method").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === state.method));
  $("aqua-only").checked = state.aquaOnly;
  $("viirs-all").checked = state.viirsAll;
}
let allYears = [];
function viewUrl() {
  const q = new URLSearchParams();
  if (current) q.set("region", current.slug);
  if (state.sel !== defaultSel) {
    q.set("area", state.sel.kind === "districts" ? `d:${state.sel.ids.join(",")}`
                                                 : `b:${state.sel.bbox.join(",")}`);
  }
  if (allYears.length && (state.yearFrom !== allYears[0] || state.yearTo !== allYears.at(-1))) {
    q.set("from", state.yearFrom); q.set("to", state.yearTo);
  }
  if (state.method !== DEFAULT_METHOD) q.set("cal", state.method);
  if (state.aquaOnly) q.set("aqua", "1");
  if (state.viirsAll) q.set("viirs", "all");
  if (state.compareYear) q.set("compare", state.compareYear);
  if (state.view === "detailed") q.set("view", "detailed");
  const qs = q.toString().replace(/%3A/g, ":").replace(/%2C/g, ",");
  return `${location.origin}${location.pathname}${qs ? `?${qs}` : ""}`;
}
function writeUrl() {
  try { history.replaceState(null, "", viewUrl().slice(location.origin.length) + location.hash); } catch { /* file:// */ }
  renderCite();
}
async function copyText(text, button, done) {
  const label = button.textContent;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
  }
  button.textContent = done;
  setTimeout(() => (button.textContent = label), 1800);
}
const METHOD_NAME = { monthly: "one scaling factor per calendar month", simple: "one scaling factor" };
function renderCite() {
  if (!result) return;
  const today = new Date().toLocaleDateString("en-CA");          // YYYY-MM-DD, local
  $("cite-view").textContent = `Burning Activity Calendar (${new Date().getFullYear()}). Harmonized MODIS and VIIRS ` +
    `fire-days for ${selName(state.sel)}, ${state.yearFrom}–${state.yearTo}; calibration: ` +
    `${METHOD_NAME[state.method]}. Data: NASA FIRMS. NASA Space Apps Challenge 2026. ${viewUrl()} (accessed ${today}).`;
}

// how old the newest fire data is
function renderFreshness() {
  const lastDay = Math.max(meta.coverage.MODIS[1], meta.coverage.VIIRS[1]);
  const now = new Date();
  const age = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
                          E.dayToDate(meta, lastDay).getTime()) / 86400000);
  const el = $("freshness");
  el.classList.toggle("stale", age > 3);
  el.textContent = age > 3
    ? `The newest fire data is from ${fmtDate(lastDay)}, ${age} days ago, so the figures for this month and the next two weeks may be out of date.`
    : `Fire data up to ${fmtDate(lastDay)}. Recent days use near-real-time data.`;
}

function message(text) {
  $("message").hidden = !text;
  $("message").textContent = text || "";
}

// ---------------------------------------------------------- analysis
// ---------------------------------------------------------- selection
function selOpts(sel) {
  if (sel.kind === "districts") return { mask: E.districtMask(meta, districts.cellDistrict, sel.ids) };
  return { bbox: sel.bbox };
}
function selBox(sel) {
  if (sel.kind === "bbox") return sel.bbox;
  const m = E.districtMask(meta, districts.cellDistrict, sel.ids);
  let s = 90, w = 180, n = -90, e = -180;
  meta.cells.forEach(([la, lo], i) => { if (m[i]) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); } });
  const h = meta.cellDeg / 2;
  return [s - h, w - h, n + h, e + h].map((v) => +v.toFixed(2));
}
function selName(sel) {
  if (sel.kind === "bbox") {
    const [s, w, n, e] = sel.bbox;
    return `the area ${s}–${n}°N, ${w}–${e}°E`;
  }
  if (sel.label) return `${sel.label} (${sel.ids.length} districts)`;
  return sel.ids.map((i) => { const d = districts.districts[i]; return `${d.name} district${d.state ? `, ${d.state}` : ""}`; }).join(", ");
}

function update() {
  selBox(state.sel).forEach((v, i) => ($(["c-s", "c-w", "c-n", "c-e"][i]).value = v));
  map.setSelection(state.sel);
  $("selection-label").innerHTML = `Showing <b>${selName(state.sel)}</b>`;
  try {
    // the wider area's scaling factors are used for the district table
    regionK = E.analyse(meta, rows, { ...selOpts(defaultSel), method: state.method,
                                      aquaOnly: state.aquaOnly, viirsAll: state.viirsAll }).k;
    result = E.analyse(meta, rows, { ...state, ...selOpts(state.sel) });
    message("");
  } catch (err) {
    result = null;
    message(`${err.message} Drag a larger area, or one with more burning.`);
    return;
  }
  const years = [...new Set(result.hMonths.map((m) => m.year))];
  allYears = years;
  if (state.yearFrom == null || !years.includes(state.yearFrom) || !years.includes(state.yearTo)) {
    state.yearFrom = years[0]; state.yearTo = years.at(-1);
  }
  for (const id of ["y-from", "y-to"]) {
    $(id).innerHTML = years.map((y) => `<option>${y}</option>`).join("");
  }
  $("y-from").value = state.yearFrom; $("y-to").value = state.yearTo;
  renderAll();
}

function renderAll() {
  if (!result) return;
  season = S.seasonCurve(meta, result.harm, state.yearFrom, state.yearTo);
  renderMapDots();
  renderDistricts();
  renderFigures();
  renderFreshness();
  renderOutlook();
  renderAlerts();
  renderStatus();
  renderCalendarBlock();
  renderSeason();
  renderTiming();
  renderMtd();
  renderTrust();
  compare?.render();
  writeUrl();
  updateTabs();
}

// ------------------------------------------------- outlook (early warning)
const dl = (j) => S.doyLabel(j);
function renderOutlook() {
  const ok = season && season.ref.length >= 3;
  $("outlook-block").hidden = !ok;
  if (!ok) return;
  const o = S.outlook(season, 14);
  const verb = { rises: "usually rises", falls: "usually falls", steady: "usually stays at about the same level",
                 quiet: "is usually quiet" }[o.direction];
  let lead = o.direction === "quiet"
    ? `The next two weeks (${dl(o.next.from)} – ${dl(o.next.to)}) are usually quiet here.`
    : `Burning here <b>${verb}</b> over the next two weeks (${dl(o.next.from)} – ${dl(o.next.to)}).`;
  if (o.period?.now) lead += ` These days fall in the usual peak, ${dl(o.period.start)} – ${dl(o.period.end)}.`;
  else if (o.period) lead += ` The next usual peak starts around ${dl(o.period.start)}, in about ${o.period.wait} days.`;
  $("outlook-lead").innerHTML = lead;

  const diff = o.last.median > 0 ? 100 * (o.last.value / o.last.median - 1) : NaN;
  const cls = diff > 10 ? "up" : diff < -10 ? "down" : "";
  const cards = [
    `<div class="card glass"><h4>Usual for ${dl(o.next.from)} – ${dl(o.next.to)}</h4>
       <div class="v">${fmt(o.next.median)}<small>fire-days</small></div>
       <p class="k">In most years between ${fmt(o.next.low)} and ${fmt(o.next.high)} (${o.next.years} years).</p></div>`,
    `<div class="card glass"><h4>Last 14 days, to ${dl(o.last.to)}</h4>
       <div class="v ${cls}">${fmt(o.last.value)}<small>${Number.isFinite(diff) ? `${pct(diff)} against usual` : "fire-days"}</small></div>
       <p class="k">Usual for these dates: ${fmt(o.last.median)}. More burning than in ${o.last.below} of ${o.last.years} earlier years.</p></div>`,
  ];
  if (o.season && Number.isFinite(o.season.done)) {
    const sd = o.season, sdiff = sd.usual > 0 ? 100 * (sd.sofar / sd.usual - 1) : NaN;
    const fill = Math.min(100, 100 * sd.done * (sd.usual > 0 ? sd.sofar / sd.usual : 0));
    cards.push(`<div class="card glass"><h4>Season ${dl(sd.start)} – ${dl(sd.end)}</h4>
       <div class="v">${fmt(100 * sd.done)}%<small>usually burned by now</small></div>
       <div class="meter" title="Bar: this season so far. Line: where a usual season is by this date."><span style="width:${fill}%"></span><em style="left:${100 * sd.done}%"></em></div>
       <p class="k">This season so far: ${fmt(sd.sofar)} fire-days, ${pct(sdiff)} against the usual ${fmt(sd.usual)} by this date.</p></div>`);
  } else {
    cards.push(`<div class="card glass"><h4>Season</h4><div class="v">Off season</div>
       <p class="k">${o.period ? `The next usual peak is ${dl(o.period.start)} – ${dl(o.period.end)}.` : "No clear burning season in this area."}</p></div>`);
  }
  $("outlook").innerHTML = cards.join("");
  const ref = season.ref;
  $("outlook-base").textContent = `Usual means the median of ${ref.length} earlier years (${ref[0]}–${ref.at(-1)}). ` +
    "Burning habits change, so to compare with recent years only, change Years above.";
}

// ------------------------------------------------- unusual activity
let recent = null, rKey = "";
function computeRecent() {
  if (!districts || !regionK) return null;
  const key = [state.method, state.aquaOnly, state.viirsAll, state.yearFrom, state.yearTo, state.alertDays].join("|");
  if (key !== rKey) {
    rKey = key;
    recent = E.districtRecent(meta, rows, districts.cellDistrict, districts.districts.length, regionK,
                              state, state.alertDays, state.yearFrom, state.yearTo);
  }
  return recent;
}
const recentOf = (id) => (recent ? recent.districts[id] : null);
function rankText(r) {
  if (!r || !r.years) return "–";
  if (r.record) return `highest in ${r.years} years`;
  return `more than ${r.below} of ${r.years} years`;
}
// links to follow the alerts elsewhere: the feed, the data file, NASA FIRMS
let feedChecked = false;
function renderGetAlerts() {
  if (current) $("alerts-json").href = `data/${current.slug}/alerts.json`;
  if (!feedChecked) {           // older data builds have no feed yet: hide its buttons
    feedChecked = true;
    for (const id of ["alerts-rss", "alerts-json"]) {
      fetch($(id).href, { method: "HEAD" }).then((r) => { $(id).hidden = !r.ok; }).catch(() => { $(id).hidden = true; });
    }
  }
  const [s, w, n, e] = selBox(state.sel);
  $("firms-coords").textContent = `west ${w}, south ${s}, east ${e}, north ${n}`;
  const span = Math.max(n - s, (e - w) * Math.cos(((s + n) / 2) * Math.PI / 180));
  const zoom = Math.max(4, Math.min(11, Math.log2(360 / Math.max(span, 0.05)) - 0.6));
  $("firms-map").href = `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${((w + e) / 2).toFixed(2)},${((s + n) / 2).toFixed(2)},${zoom.toFixed(1)}z`;
}

function renderAlerts() {
  const R = computeRecent();
  const ok = R && R.years >= 5 && R.from;
  $("alerts-block").hidden = !ok;
  if (!ok) { map.setFlags([]); return; }
  const focus = new Set(districts.focusIds);
  const list = R.districts.filter((r) => districts.districts[r.id].cells > 0 && (!focus.size || focus.has(r.id)) && Number.isFinite(r.now));
  const flagged = list.filter((r) => r.flagged);
  map.setFlags(flagged.map((r) => r.id));
  const key = $("legend-flag"); if (key) key.hidden = !flagged.length;
  const short = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const span = `${short(R.from)} to ${short(R.to)}`;
  $("alerts-title").textContent = `Burning more than usual: last ${R.days} days`;
  renderGetAlerts();
  $("alerts-lead").innerHTML = flagged.length
    ? `<b class="flag">${flagged.length} of ${list.length} districts</b> burned far more than usual from ${span}` +
      (flagged.some((r) => r.record) ? `, ${flagged.filter((r) => r.record).length} of them more than in any of the ${R.years} earlier years.` : ".")
    : `No district burned far more than usual from ${span}. These were closest:`;
  const shown = (flagged.length ? flagged : [...list].filter((r) => r.now > 0)
    .sort((a, b) => (b.ratio || 0) - (a.ratio || 0)).slice(0, 5));
  const { key: sk, dir } = state.alertSort;
  const val = { name: (r) => districts.districts[r.id].name, now: (r) => r.now, median: (r) => r.median,
                ratio: (r) => (Number.isFinite(r.ratio) ? r.ratio : r.now > 0 ? Infinity : 0), rank: (r) => r.below / Math.max(1, r.years) };
  shown.sort((a, b) => { const x = val[sk](a), y = val[sk](b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  const th = (k, label, cls = "") => `<th class="${cls}"${k === sk ? ` aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}><button type="button" data-k="${k}">${label}</button></th>`;
  $("alerts-table").innerHTML = `<thead><tr>${th("name", "District")}${th("now", `Last ${R.days} days`)}${th("median", "Usual")}` +
    `${th("ratio", "Times usual")}${th("rank", "Against earlier years", "hist")}</tr></thead><tbody>${
    shown.map((r) => {
      const d = districts.districts[r.id];
      return `<tr tabindex="0" data-id="${r.id}"><td>${d.name}<span class="st">, ${d.state}</span>${r.record ? '<span class="badge">record</span>' : ""}</td>` +
        `<td class="${r.flagged ? "flag" : ""}">${fmt(r.now)}</td><td>${fmt(r.median)}</td>` +
        `<td class="${r.flagged ? "flag" : ""}">${Number.isFinite(r.ratio) ? `×${fmt(r.ratio, 1)}` : r.now > 0 ? "new" : "–"}</td>` +
        `<td class="hist">${rankText(r)}</td></tr>`;
    }).join("")}</tbody>`;
  $("alerts-table").querySelectorAll("th button").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    state.alertSort = { key: k, dir: state.alertSort.key === k ? -state.alertSort.dir : (k === "name" ? 1 : -1) };
    renderAlerts();
  }));
  $("alerts-table").querySelectorAll("tbody tr").forEach((tr) => {
    const pick = () => {
      state.sel = { kind: "districts", ids: [+tr.dataset.id] };
      update();
      mini?.open(+tr.dataset.id, [state.yearFrom, state.yearTo]);
      $("map").scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
    };
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });
}

// ------------------------------------------------- typical year
function renderSeason() {
  const ok = season && season.ref.length >= 3;
  $("season-block").hidden = !ok;
  if (!ok) return;
  const ys = [...season.ref].reverse();
  if (state.compareYear && !season.yearLine(state.compareYear)) state.compareYear = null;
  $("compare-year").innerHTML = `<option value="">No other year</option>` +
    [...new Set([...ys, season.current.year - 1])].filter((y) => season.yearLine(y) && y !== season.current.year)
      .sort((a, b) => b - a).map((y) => `<option value="${y}">${y}</option>`).join("");
  $("compare-year").value = state.compareYear || "";
  const cy = state.compareYear;
  seasonChart($("season-svg"), {
    med: season.med, p10: season.p10, p90: season.p90, periods: season.periods, label: dl,
    current: season.current, compare: cy ? { year: cy, values: season.yearLine(cy) } : null,
  });
  $("season-legend").innerHTML = [
    `<li><i style="background:${SEASON_COLORS.usual}"></i>Usual (median of ${season.ref.length} years)</li>`,
    `<li><i class="band" style="background:${SEASON_COLORS.usual}"></i>Most years</li>`,
    `<li><i style="background:${SEASON_COLORS.now}"></i>${season.current.year} so far</li>`,
    cy ? `<li><i class="dash" style="color:${SEASON_COLORS.compare}"></i>${cy}</li>` : "",
    season.periods.length ? `<li><i class="band" style="background:rgba(241,127,58,0.35)"></i>Critical periods</li>` : "",
  ].join("");
  const ps = [...season.periods].sort((a, b) => a.start - b.start);
  const days = ps.reduce((n, p) => n + p.days, 0);
  $("critical").innerHTML = ps.length
    ? `<p>Critical periods, when usual burning is at least ${ps[0].level <= 0.26 ? "a quarter" : `${fmt(100 * ps[0].level)}%`} of its yearly peak: ${days} days that hold ${fmt(100 * ps.reduce((t, p) => t + p.share, 0))}% of a typical year's burning.</p>` +
      ps.map((p) => `<span class="period"><b>${dl(p.start)} – ${dl(p.end)}</b>: ${fmt(100 * p.share)}% of the year, busiest around ${dl(p.peak)}</span>`).join("")
    : "";
}

// ------------------------------------------------- season timing
let timing = [];
function renderTiming() {
  timing = season && season.ref.length >= 3 ? S.seasonTiming(season).filter((t) => t.rows.length >= 6) : [];
  $("timing-block").hidden = !timing.length;
  if (!timing.length) return;
  timing.sort((a, b) => a.window.start - b.window.start);
  if (state.timingIdx == null || state.timingIdx >= timing.length) {   // start with the main season
    const main = timing.reduce((b, t, i) => (t.window.share > timing[b].window.share ? i : b), 0);
    state.timingIdx = main;
  }
  $("timing-season").hidden = timing.length < 2;
  $("timing-season").innerHTML = timing.map((t, i) =>
    `<button type="button" data-i="${i}" aria-pressed="${i === state.timingIdx}">${t.name}</button>`).join("");
  const t = timing[state.timingIdx], rows = t.rows;
  const clear = (p) => (Number.isFinite(p) && p < 0.05 ? "a clear trend" : "not a clear trend");
  const pv = (p) => (Number.isFinite(p) ? (p < 0.001 ? "p < 0.001" : `p = ${fmt(p, 3)}`) : "too few years");
  const sh = t.midShift.perDecade;
  const shift = Math.abs(sh) < 1
    ? "has stayed about the same"
    : `has moved <b>${fmt(Math.abs(sh), 1)} days ${sh > 0 ? "later" : "earlier"} per decade</b>`;
  const tt = t.totalTrend.pctPerYear;
  $("timing-summary").innerHTML = `Since ${rows[0].year}, the halfway date of the ${t.name} season ${shift} ` +
    `(${clear(t.midShift.p)}, ${pv(t.midShift.p)}). The season's total burning ` +
    (Number.isFinite(tt) ? `changed by <b>${pct(tt)} a year</b> (${clear(t.totalTrend.p)}, ${pv(t.totalTrend.p)}).` : "has too few years for a trend.");
  timingChart($("timing-svg"), { season: t, trend: S.theilSen(rows.map((r) => [r.year, r.mid])) });
}

// red dots on the map for the years shown (recomputed only when the years change)
function renderMapDots() {
  const key = `${state.yearFrom}|${state.yearTo}`;
  if (key === dotsKey) return;
  dotsKey = key;
  const { dots, hasFrp, unit } = aggregate(meta, hot, rows, districts?.cellDistrict,
                                           { y0: state.yearFrom, y1: state.yearTo });
  map.setDots(dots, intensity(dots, hasFrp));
  const span = state.yearFrom === state.yearTo ? `${state.yearFrom}` : `${state.yearFrom}–${state.yearTo}`;
  $("map-legend").innerHTML = `Fires detected, ${span}
    <div class="bar" style="background:${redGradient}"></div>
    <div class="ends"><span>${hasFrp ? "Lower" : "Fewer"}</span><span>${hasFrp ? "Higher fire intensity" : "More fire-days"}</span></div>
    <div class="ends"><span>${hasFrp ? "Bigger dot: more detections" : "Dots are 10 km cells"}</span></div>
    ${districts ? `<div class="lines"><span><i style="border-top:1.6px solid rgba(225,238,255,.8)"></i>State</span><span><i style="border-top:1px solid rgba(170,205,255,.5)"></i>District</span><span class="flagkey" id="legend-flag" hidden><i></i>More than usual</span></div>` : ""}`;
  void unit;
}

function mtdYears() {
  const m = result.mtd;
  return m ? m.years.filter((y) => y.year >= state.yearFrom && y.year <= state.yearTo) : [];
}

function renderFigures() {
  const m = result.mtd, ys = mtdYears();
  const cur = ys.at(-1), past = ys.slice(0, -1).map((y) => y.value);
  const med = median(past);
  const diff = med > 0 ? 100 * (cur.value / med - 1) : NaN;
  const rank = past.length ? (100 * past.filter((v) => v < cur.value).length) / past.length : NaN;
  const cal = E.calendar(result.hMonths, state.yearFrom, state.yearTo);
  const typical = MONTHS.map((_, i) => median(cal.values.map((r) => r[i]).filter(Number.isFinite)));
  const peak = typical.indexOf(Math.max(...typical.filter(Number.isFinite)));
  const label = `${MONTH_NAMES[m.month - 1]} 1–${m.day}, ${cur.year}`;
  $("figures").innerHTML = [
    [fmt(cur.value), `fire-days, ${label}`, ""],
    [pct(diff), `compared with the median of ${past.length} earlier years`, diff > 0 ? "up" : diff < 0 ? "down" : ""],
    [Number.isFinite(rank) ? `${fmt(rank)}%` : "–", "of earlier years had less burning on these days", ""],
    [peak >= 0 ? MONTH_NAMES[peak] : "–", "is usually the peak month", ""],
  ].map(([v, k, c]) => `<div class="figure glass"><div class="v ${c}">${v}</div><div class="k">${k}</div></div>`).join("");
  $("mtd-title").textContent = `${MONTH_NAMES[m.month - 1]} 1–${m.day} in every year`;
}

function renderCalendarBlock() {
  if (!result) return;
  const cal = E.calendar(result.hMonths, state.yearFrom, state.yearTo);
  const last = result.mtd?.lastDate;
  const medians = renderCalendar($("calendar"), $("cal-scale"), cal, {
    mode: state.calMode, lastDate: last,
    onCell: (e, c) => {
      const lines = [];
      if (Number.isFinite(c.v)) {
        lines.push(`<div class="r"><span>Fire-days</span><b>${fmt(c.v)}</b></div>`);
        if (!c.inProgress && Number.isFinite(c.diff)) {
          lines.push(`<div class="r"><span>Against usual ${MONTHS[c.mi]}</span><b>${pct(c.diff)}</b></div>`);
        }
        const src = c.cell && c.cell.viirs && c.cell.modis ? "VIIRS and scaled MODIS"
          : c.cell && c.cell.viirs ? "VIIRS observed" : "MODIS scaled to VIIRS";
        lines.push(`<div class="r"><span>Source</span><b>${src}</b></div>`);
        if (c.inProgress) lines.push(`<div class="r"><span>Month in progress</span><b>to ${last.getUTCDate()} ${MONTHS[c.mi]}</b></div>`);
      } else {
        lines.push(`<div class="r">No satellite observation</div>`);
      }
      showTip(e, `<div class="t">${MONTH_NAMES[c.mi]} ${c.year}</div>${lines.join("")}`);
    },
  });
  $("cal-note").textContent = state.calMode === "activity"
    ? "Each square is one month of harmonized fire-days. Brighter means more burning."
    : "Each square compares a month with the median of that month across the years shown. Red is more burning than usual, blue is less.";
  calendarTable($("cal-table"), cal);
  return medians;
}

function renderMtd() {
  const ys = mtdYears();
  if (!ys.length) return;
  const cur = ys.at(-1);
  const med = median(ys.slice(0, -1).map((y) => y.value));
  barChart($("mtd-svg"), {
    items: ys.map((y) => ({ key: y.year, label: `${y.year}`, value: y.value })),
    highlight: cur.year, refLine: med, refLabel: `Median of earlier years: ${fmt(med)}`,
    unit: "Fire-days", height: 300,
  });
}

function renderTrust() {
  const s = result.steps;
  $("verdict").innerHTML = s ? [
    ["raw", `×${fmt(s.rawSplice, 2)}`, `if the raw records were simply joined in ${s.year}`],
    ["harm", `×${fmt(s.harmonized, 2)}`, "after harmonization"],
    ["real", `×${fmt(s.modisOnly, 2)}`, "the real change, seen by MODIS alone"],
  ].map(([c, v, k]) => `<div class="${c}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("")
    : "<p class='muted'>VIIRS starts too late in this data to test the join.</p>";
  const sum = result.validation.summary;
  const name = { monthly: "By month", simple: "One ratio" };
  $("validation").innerHTML = `<table class="data"><thead><tr><th>Calibration</th><th>Monthly error</th><th>Annual bias</th><th>Years tested</th></tr></thead><tbody>${
    Object.entries(sum).map(([k, v]) => `<tr><td>${name[k]}${k === state.method ? " <span class='muted'>(in use)</span>" : ""}</td><td>${fmt(v.wape, 1)}%</td><td>${pct(v.bias)}</td><td>${v.years}</td></tr>`).join("")
  }</tbody></table><p class="muted small">Monthly error is the total absolute monthly error divided by the total observed. Lower is better.</p>`;
  const n20 = meta.n20Scale;
  $("handover").innerHTML = meta.snppEnd != null && n20 && n20 !== 1
    ? `<strong>The 2026 satellite handover.</strong> Suomi NPP's record here ends on ${fmtDate(meta.snppEnd)}, and NOAA-20 takes over. ` +
      `Over the months both flew, NOAA-20 counted ${fmt((1 / n20 - 1) * 100, 0)}% more fire-days here, so its days after the handover are scaled by ×${fmt(n20, 2)} to stay on the same scale.`
    : "";
  $("handover").hidden = !$("handover").innerHTML;
  barChart($("k-svg"), {
    items: MONTHS.map((mo, i) => ({ key: i, label: mo, value: result.k[i + 1], digits: 2 })),
    unit: "VIIRS per MODIS fire-day", height: 220, color: "#3c4a6b", labelEvery: 1,
  });
}

// ---------------------------------------------------------- districts
let dKey = "";
function computeDistrictStats() {
  if (!districts || !regionK) return null;
  const key = [state.method, state.aquaOnly, state.viirsAll, state.yearFrom, state.yearTo].join("|");
  if (key === dKey && dStats) return dStats;      // selection changes don't affect this
  dKey = key;
  return E.districtStats(meta, rows, districts.cellDistrict, districts.districts.length, regionK,
                         state, state.yearFrom, state.yearTo);
}

function describeDistrict(i) {
  const s = dStats?.districts[i];
  if (!s) return "";
  const label = `${MONTHS[dStats.month - 1]} 1–${dStats.day}`;
  const diff = s.usual > 0 ? 100 * (s.now / s.usual - 1) : NaN;
  return `<div class="r"><span>${label}, ${dStats.year}</span><b>${fmt(s.now)} fire-days</b></div>` +
    `<div class="r"><span>Usual for these days</span><b>${fmt(s.usual)}</b></div>` +
    (Number.isFinite(diff) ? `<div class="r"><span>Change</span><b>${pct(diff)}</b></div>` : "") +
    `<div class="r"><span>Average per year</span><b>${fmt(s.perYear)}</b></div>` +
    (Number.isFinite(trendOf(s).pct) ? `<div class="r"><span>Long-term trend</span><b>${pct(trendOf(s).pct)} a year</b></div>` : "") +
    (recentOf(i) && Number.isFinite(recentOf(i).now)
      ? `<div class="r"><span>Last ${recent.days} days</span><b>${fmt(recentOf(i).now)} (usual ${fmt(recentOf(i).median)})</b></div>` +
        (recentOf(i).flagged ? `<div class="r"><span>Burning far more than usual</span><b>${rankText(recentOf(i))}</b></div>` : "")
      : "");
}

const trendCache = new WeakMap();
function trendOf(s) {
  if (!trendCache.has(s)) trendCache.set(s, S.yearlyTrend(s.series || []));
  return trendCache.get(s);
}
const trendCell = (t) => (Number.isFinite(t.pct)
  ? `<td class="py trend ${t.p < 0.05 ? "" : "flat"}" title="${t.p < 0.05 ? "Clear trend" : "Not a clear trend"} (Mann-Kendall p = ${fmt(t.p, 3)})">${t.pct > 0 ? "+" : ""}${fmt(t.pct, 1)}%</td>`
  : '<td class="py">–</td>');

function renderDistricts() {
  dStats = computeDistrictStats();
  $("districts-block").hidden = !dStats;
  if (!dStats) return;
  const focus = new Set(districts.focusIds);
  const label = `${MONTH_NAMES[dStats.month - 1]} 1–${dStats.day}, ${dStats.year}`;
  $("districts-title").textContent = `Where it is burning: ${label}`;
  const list = dStats.districts
    .map((s) => ({ ...s, d: districts.districts[s.id] }))
    .filter((s) => s.d.cells > 0 && (!focus.size || focus.has(s.id)))
    .sort((a, b) => (b.now || 0) - (a.now || 0));
  const shown = state.allDistricts ? list : list.slice(0, 10);
  $("districts-toggle").textContent = state.allDistricts ? "Show top 10" : `Show all ${list.length} districts`;
  $("districts-toggle").hidden = list.length <= 10;
  const top = Math.max(1, ...list.map((s) => Math.max(s.now || 0, s.usual || 0)));
  const selIds = state.sel.kind === "districts" ? new Set(state.sel.ids) : new Set();
  $("districts-table").innerHTML = `<thead><tr><th>District</th><th class="barcell">This month so far
      <span class="muted">(bar) and usual (line)</span></th><th>Fire-days</th><th>Usual</th><th>Change</th><th class="py">Per year</th><th class="py" title="Theil-Sen slope of yearly fire-days, as % of the median year. Faded: not a clear trend.">Trend a year</th></tr></thead><tbody>${
    shown.map((s) => {
      const diff = s.usual > 0 ? 100 * (s.now / s.usual - 1) : NaN;
      const cls = diff > 10 ? "up" : diff < -10 ? "down" : "";
      return `<tr tabindex="0" data-id="${s.id}" class="${selIds.size === 1 && selIds.has(s.id) ? "on" : ""}">
        <td>${s.d.name}<span class="st">, ${s.d.state}</span></td>
        <td class="barcell"><div class="bar"><span style="width:${(100 * (s.now || 0)) / top}%"></span>${Number.isFinite(s.usual) ? `<em style="left:${(100 * s.usual) / top}%"></em>` : ""}</div></td>
        <td>${fmt(s.now)}</td><td>${fmt(s.usual)}</td><td class="${cls}">${pct(diff)}</td><td class="py">${fmt(s.perYear)}</td>${trendCell(trendOf(s))}</tr>`;
    }).join("")}</tbody>`;
  $("districts-table").querySelectorAll("tbody tr").forEach((tr) => {
    const pick = () => {
      state.sel = { kind: "districts", ids: [+tr.dataset.id] };
      update();
      mini?.open(+tr.dataset.id, [state.yearFrom, state.yearTo]);
      $("map").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    };
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });
}

// ---------------------------------------------------------- downloads
function save(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const header = () => `# Burning Activity Calendar export. Area: ${selName(state.sel)}; calibration ${state.method}; MODIS ${state.aquaOnly ? "Aqua" : "Terra+Aqua"}; VIIRS ${state.viirsAll ? "all satellites" : "reference satellite"}. Source: NASA FIRMS.\n`;
const iso = (d) => E.dayToDate(meta, d).toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(v) ? +v.toFixed(3) : "");

function downloadMonthly() {
  if (!result) return;
  const raw = new Map(result.months.map((m) => [m.key, m]));
  const lines = result.hMonths.map((m) => {
    const r = raw.get(m.key) || {};
    return [`${m.year}-${String(m.month).padStart(2, "0")}`, num(m.value), num(r.MODIS), num(r.VIIRS)].join(",");
  });
  save("burning_calendar_monthly.csv", header() + "month,harmonized_fire_days,modis_raw,viirs_raw\n" + lines.join("\n"));
}
function downloadDaily() {
  if (!result) return;
  const { harm, daily } = result, src = ["no observation", "VIIRS observed", "MODIS scaled"];
  const lines = [];
  for (let i = 0; i < harm.len; i++) {
    lines.push([iso(harm.start + i), num(harm.h[i]), src[harm.src[i]], num(daily.modis[i]), num(daily.viirs[i])].join(","));
  }
  save("burning_calendar_daily.csv", header() + "date,harmonized,source,modis_raw,viirs_raw\n" + lines.join("\n"));
}
function downloadSeason() {
  if (!season) return;
  const c = season.current.values || [];
  const lines = [...Array(365).keys()].map((j) => [j + 1, dl(j), num(season.med[j]), num(season.p10[j]),
    num(season.p90[j]), j <= season.current.lastDoy ? num(c[j]) : ""].join(","));
  save("typical_year.csv", header() + `# 15-day average of harmonized fire-days per day; usual = median of ${season.ref.length} complete years (${season.ref[0]}-${season.ref.at(-1)}).\n` +
    `day_of_year,date,usual,p10,p90,this_year_${season.current.year}\n` + lines.join("\n"));
}
function downloadTiming() {
  if (!timing.length) return;
  const lines = timing.flatMap((t) => t.rows.map((r) => [`"${t.name}"`, r.year, t.label(r.start), t.label(r.mid),
    t.label(r.end), t.label(r.peak), num(r.total)].join(",")));
  save("season_timing.csv", header() + "season,year,start_10,halfway_50,end_90,busiest_week,fire_days\n" + lines.join("\n"));
}
function downloadDistricts() {
  if (!dStats) return;
  const focus = new Set(districts.focusIds);
  const lines = dStats.districts.filter((s) => districts.districts[s.id].cells > 0 && (!focus.size || focus.has(s.id)))
    .map((s) => {
      const d = districts.districts[s.id], t = trendOf(s), r = recentOf(s.id) || {};
      const diff = s.usual > 0 ? 100 * (s.now / s.usual - 1) : NaN;
      return [`"${d.name}"`, `"${d.state}"`, num(s.now), num(s.usual), num(diff), num(s.perYear), num(t.pct), num(t.p),
              num(r.now), num(r.median), r.flagged ? 1 : 0].join(",");
    });
  save("districts.csv", header() + `# month so far: ${MONTH_NAMES[dStats.month - 1]} 1-${dStats.day}, ${dStats.year}; usual = median of earlier years for the same days.\n` +
    `district,state,fire_days_month_so_far,usual,change_pct,fire_days_per_year,trend_pct_per_year,trend_p,last_${state.alertDays}_days,usual_last_${state.alertDays}_days,more_than_usual\n` + lines.join("\n"));
}
function downloadCells() {
  const sel = selOpts(state.sel), names = ["Terra", "Aqua", "SNPP", "NOAA20"];
  const mask = sel.mask || E.cellMask(meta, sel.bbox);
  const lines = [];
  for (let i = 0; i < rows.day.length; i++) {
    if (!mask[rows.cell[i]]) continue;
    const f = rows.flags[i], [la, lo] = meta.cells[rows.cell[i]];
    const di = districts ? districts.cellDistrict[rows.cell[i]] : -1;
    const dn = di >= 0 ? `"${districts.districts[di].name}","${districts.districts[di].state}"` : ",";
    lines.push([iso(rows.day[i]), la, lo, dn, names.filter((_, b) => f & (1 << b)).join("+")].join(","));
  }
  save("fire_cell_days.csv", header() + "date,cell_lat,cell_lon,district,state,satellites\n" + lines.join("\n"));
}

load();


// =================================================== easier to use
// simple and detailed views, the status card, explanations, district search

const GLOSSARY = {
  "fire-day": "A fire-day is one 10 km square with at least one fire seen by a satellite on one day. It shows how much and how often an area burns, not how many fires there were or how big they were.",
  harmonized: "Harmonized means the older MODIS counts are scaled to the newer VIIRS level, so the record from 2001 reads as one line with no false jump in 2012.",
  modis: "MODIS is a NASA instrument on the Terra and Aqua satellites. It has looked for fires in 1 km pixels since 2000.",
  viirs: "VIIRS is a newer instrument on the Suomi NPP and NOAA-20 satellites. Its 375 m pixels catch small fires MODIS misses, so it counts about 2 to 3 times more.",
  usual: "Usual is the middle value of the same dates in earlier years: half of those years had more burning, half had less.",
  "far-above": "Far more than usual means more fire-days than in 9 of 10 earlier years on the same dates, and at least one and a half times the usual amount.",
  trend: "The trend is how fast yearly burning in the district has been rising or falling, as a share of a typical year. Faded numbers are not a clear trend.",
  critical: "Critical periods are the weeks when burning is usually at its highest. They are the times to plan monitoring and staff for.",
  "clear-trend": "A clear trend is a change so steady it would rarely happen by chance (a p-value below 0.05). Otherwise the change may just be year-to-year noise.",
  "per-area": "Per 1,000 km² divides fire-days by the size of the place, so a small district and a large state can be compared fairly.",
};

function setView(v, save = true) {
  state.view = v === "detailed" ? "detailed" : "simple";
  document.body.classList.toggle("simple", state.view === "simple");
  $("view-switch").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === state.view));
  if (save) { try { localStorage.setItem("bac-view", state.view); } catch { /* private mode */ } writeUrl(); }
  updateTabs();
}

function wireEase() {
  // view: the link wins, then the last choice, then simple
  const q = new URLSearchParams(location.search);
  let saved = null;
  try { saved = localStorage.getItem("bac-view"); } catch { /* private mode */ }
  const advanced = q.get("cal") || q.get("aqua") || q.get("viirs");
  setView(q.get("view") || (advanced ? "detailed" : saved) || "simple", false);
  $("view-switch").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (b) setView(b.dataset.v);
  });

  // the guide opens by itself on a first visit
  const guide = $("guide");
  let seen = false;
  try { seen = !!localStorage.getItem("bac-guide"); } catch { /* private mode */ }
  guide.hidden = seen;
  const closeGuide = () => { guide.hidden = true; try { localStorage.setItem("bac-guide", "1"); } catch { /* */ } };
  $("guide-close").addEventListener("click", closeGuide);
  $("guide-open").addEventListener("click", () => { guide.hidden = !guide.hidden; if (!guide.hidden) guide.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "nearest" }); });

  // explanations
  let openInfo = null;
  const box = $("explain");
  const closeInfo = () => { box.hidden = true; openInfo?.setAttribute("aria-expanded", "false"); openInfo = null; };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button.info");
    if (!b) { if (!e.target.closest("#explain")) closeInfo(); return; }
    e.preventDefault(); e.stopPropagation();
    if (openInfo === b) { closeInfo(); return; }
    closeInfo();
    $("explain-text").textContent = GLOSSARY[b.dataset.term] || "";
    box.hidden = false;
    const r = b.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
    box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left - 16))}px`;
    box.style.top = `${r.bottom + 8 + h > innerHeight ? r.top - h - 8 : r.bottom + 8}px`;
    b.setAttribute("aria-expanded", "true"); openInfo = b; openedAt = scrollY;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInfo(); });
  let openedAt = 0;          // close when the page has scrolled well away, not on a nudge
  addEventListener("scroll", () => { if (openInfo && Math.abs(scrollY - openedAt) > 120) closeInfo(); }, { passive: true });
  document.querySelectorAll("button.info").forEach((b) => b.setAttribute("aria-expanded", "false"));

  wireFinder();

  // section tabs: mark the part on screen
  const tabs = [...$("section-tabs").querySelectorAll("a")];
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      tabs.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${en.target.id}`));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  tabs.forEach((a) => { const t = document.querySelector(a.getAttribute("href")); if (t) io.observe(t); });
}

// hide tabs whose part is hidden (no districts, simple view)
function updateTabs() {
  $("section-tabs").querySelectorAll("a").forEach((a) => {
    const t = document.querySelector(a.getAttribute("href"));
    a.hidden = !t || t.hidden || getComputedStyle(t).display === "none";
  });
}

// ---------------------------------------------------- status at a glance
const ICONS = {
  far: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="currentColor" opacity=".25"/><path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 6v4M8 11.6v.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  above: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  normal: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  below: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  quiet: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};
const LEVEL_NAME = { far: "Far above usual", above: "Above usual", normal: "About usual", below: "Below usual", quiet: "Quiet season" };

function renderStatus() {
  const el = $("status");
  if (!season || season.ref.length < 3) { el.hidden = true; updateTabs(); return; }
  const o = S.outlook(season, 14), now = o.last.value, usual = o.last.median, yrs = o.last.years;
  if (!Number.isFinite(now)) { el.hidden = true; updateTabs(); return; }
  let level;
  if (!(usual >= 3) && now < 5) level = "quiet";
  else if (yrs >= 5 && now >= 5 && o.last.below >= Math.ceil(0.9 * yrs) && now >= 1.5 * usual) level = "far";
  else if (now > 1.2 * usual && o.last.below >= yrs / 2) level = "above";
  else if (now < 0.8 * usual) level = "below";
  else level = "normal";
  const name = selName(state.sel).replace(/\s*\(\d+ districts?\)$/, "");
  const phrase = { far: "far above usual", above: "above usual", normal: "about usual", below: "below usual", quiet: "low, as usual at this time of year" }[level];
  let text = `Right now in <b>${name}</b>, burning is <b>${phrase}</b>: ${fmt(now)} fire-days in the last 14 days, against a usual ${fmt(usual)} for these dates.`;
  // districts far above their usual level, within the selection
  if (recent && districts) {
    const inSel = state.sel.kind === "districts" ? new Set(state.sel.ids) : new Set(districts.focusIds);
    const list = recent.districts.filter((r) => inSel.has(r.id) && districts.districts[r.id].cells > 0 && Number.isFinite(r.now));
    const flagged = list.filter((r) => r.flagged);
    if (list.length > 1) {
      text += flagged.length
        ? ` <b>${flagged.length} of ${list.length} districts</b> ${flagged.length === 1 ? "is far above its" : "are far above their"} usual level in the last ${recent.days} days.`
        : ` No district is far above its usual level in the last ${recent.days} days.`;
    }
  }
  const verb = { rises: "usually rises", falls: "usually falls", steady: "usually stays about the same", quiet: "is usually quiet" }[o.direction];
  text += ` Burning ${verb} over the next two weeks.`;
  const main = [...season.periods].sort((a, b) => b.share - a.share)[0];
  if (main) text += ` The main burning season is ${S.doyLabel(main.start)} to ${S.doyLabel(main.end)}.`;
  const links = [
    recent && recent.districts.some((r) => r.flagged) ? `<a class="link" href="#alerts-block">See the districts</a>` : "",
    `<a class="link" href="#outlook-block">The next two weeks</a>`,
    `<a class="link" href="#calendar-block">The burning calendar</a>`,
  ].join("");
  el.className = `status ${level}`;
  el.innerHTML = `<span class="badge">${ICONS[level]}${LEVEL_NAME[level]}</span><div><p class="status-text">${text}</p><p class="status-more">${links}</p></div>`;
  el.hidden = false;
  updateTabs();
}

// ---------------------------------------------------- find a district
function wireFinder() {
  const input = $("find"), list = $("find-list");
  const plain = (t) => t.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  let index = [], others = null, active = -1, shown = [];
  const add = (slug, area, d) => {
    if (!d) return;
    const focus = new Set(d.focusIds || d.districts.filter((x) => d.focus.includes(x.state)).map((x) => x.id));
    for (const x of d.districts) {
      if (focus.has(x.id) && x.cells > 0) index.push({ slug, area, id: x.id, name: x.name, state: x.state, key: plain(x.name) });
    }
  };
  add(current?.slug, current?.name || meta.region, districts);
  const loadOthers = () => {
    others ||= Promise.all(regions.filter((r) => r.slug !== current?.slug).map((r) =>
      fetch(`data/${r.slug}/districts.json`).then((x) => (x.ok ? x.json() : null)).then((d) => add(r.slug, r.name, d)).catch(() => {})))
      .then(() => show());
    return others;
  };
  const show = () => {
    const q = plain(input.value.trim());
    if (q.length < 2) { list.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
    const starts = index.filter((e) => e.key.startsWith(q)), has = index.filter((e) => !e.key.startsWith(q) && e.key.includes(q));
    shown = [...starts, ...has].slice(0, 8);
    active = shown.length ? 0 : -1;
    list.innerHTML = shown.length
      ? shown.map((e, i) => `<li role="option" id="find-${i}" aria-selected="${i === active}" data-i="${i}">${e.name}, ${e.state}<small>${e.slug === current?.slug ? "" : e.area}</small></li>`).join("")
      : `<li class="none">No district by that name in the study areas</li>`;
    list.hidden = false; input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", active >= 0 ? `find-${active}` : "");
  };
  const pick = (e) => {
    list.hidden = true; input.value = `${e.name}, ${e.state}`; input.setAttribute("aria-expanded", "false");
    if (e.slug === current?.slug) {
      state.sel = { kind: "districts", ids: [e.id] };
      update();
      mini?.open(e.id, [state.yearFrom, state.yearTo]);
      $("map").scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
    } else {
      location.href = `?region=${encodeURIComponent(e.slug)}&area=d:${e.id}#explore`;
    }
  };
  input.addEventListener("focus", loadOthers);
  input.addEventListener("input", () => { show(); loadOthers(); });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !shown.length) { if (e.key === "Escape") list.hidden = true; return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      list.querySelectorAll("li").forEach((li, i) => li.setAttribute("aria-selected", i === active));
      input.setAttribute("aria-activedescendant", `find-${active}`);
    } else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) pick(shown.at(active)); }
    else if (e.key === "Escape") { list.hidden = true; input.setAttribute("aria-expanded", "false"); }
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]"); if (!li) return;
    e.preventDefault(); pick(shown.at(+li.dataset.i));
  });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; input.setAttribute("aria-expanded", "false"); }, 120));
}
