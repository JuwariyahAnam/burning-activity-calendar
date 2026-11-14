// Burning Activity Calendar: page logic.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import * as E from "./engine.js";
import { lineChart, renderCalendar, calendarTable, barChart, showTip, fmt, pct, median,
         ember, COLORS, MONTHS, MONTH_NAMES } from "./viz.js";
import { createMap } from "./map.js";
import { createGlobeHero } from "./globe.js";
import { createMiniMap } from "./minimap.js";

const $ = (id) => document.getElementById(id);
// selection: { kind: "bbox", bbox } or { kind: "districts", ids: [...] }
const state = { sel: null, method: "monthly", aquaOnly: false, viirsAll: false,
                yearFrom: null, yearTo: null, calMode: "activity", allDistricts: false };
let meta, rows, result, map, mini = null, districts = null, defaultSel, dStats = null, regionK = null;

async function load() {
  try {
    const [m, b] = await Promise.all([
      fetch("data/meta.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch("data/cells.bin").then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    ]);
    meta = m; rows = E.decode(meta, b);
    districts = await fetch("data/districts.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  } catch (err) {
    $("loading").textContent = "No data yet. Run python build_site.py, then reload this page.";
    throw err;
  }
  const focusIds = districts ? districts.districts.filter((d) => districts.focus.includes(d.state)).map((d) => d.id) : [];
  defaultSel = focusIds.length ? { kind: "districts", ids: focusIds, label: districts.focus.join(" and ") }
                               : { kind: "bbox", bbox: [...meta.bbox] };
  state.sel = defaultSel;
  $("sample-banner").hidden = !meta.sample;
  document.querySelectorAll(".region-name").forEach((n) => (n.textContent = meta.region));
  $("hero-text").textContent = `Since ${E.dayToDate(meta, meta.coverage.MODIS[0]).getUTCFullYear()}, NASA satellites have logged burning across ${meta.region}, with two instruments that count differently. This calendar puts them on one scale, so you can see when burning happens and whether this season is unusual.`;
  $("data-note").textContent = `Data processed ${meta.generated}. Records from ${fmtDate(meta.coverage.MODIS[0])} to ${fmtDate(Math.max(meta.coverage.MODIS[1], meta.coverage.VIIRS[1]))}.`;

  createGlobeHero($("hero-canvas"), meta, rows,
    { monthEl: $("hero-month"), trackEl: $("hero-track"), clockEl: $("hero-clock"), districts });
  $("hero-note").textContent = `${meta.region}: fires on each date, all years. Brighter cells burned on that date in more years.`;
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
  update();
  $("loading").classList.add("done");
}

const fmtDate = (d) => E.dayToDate(meta, d).toLocaleDateString("en-GB",
  { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

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
  if (state.yearFrom == null) { state.yearFrom = years[0]; state.yearTo = years.at(-1); }
  for (const id of ["y-from", "y-to"]) {
    $(id).innerHTML = years.map((y) => `<option>${y}</option>`).join("");
  }
  $("y-from").value = state.yearFrom; $("y-to").value = state.yearTo;
  renderAll();
}

function renderAll() {
  if (!result) return;
  const max = map.setHeat(heat());
  $("map-legend").innerHTML = `Fire-days per 10 km cell, ${state.yearFrom}–${state.yearTo}
    <div class="bar" style="background:linear-gradient(90deg,${[0.18, 0.4, 0.6, 0.8, 1].map(ember).join(",")})"></div>
    <div class="ends"><span>1</span><span>${fmt(max)} (log scale)</span></div>
    ${districts ? `<div class="lines"><span><i style="border-top:1.6px solid rgba(225,238,255,.8)"></i>State</span><span><i style="border-top:1px solid rgba(170,205,255,.5)"></i>District</span></div>` : ""}`;
  renderDistricts();
  renderFigures();
  renderCalendarBlock();
  renderMtd();
  renderTrust();
}

function heat() {
  const v = new Float32Array(meta.cells.length);
  const from = Date.UTC(state.yearFrom, 0, 1), to = Date.UTC(state.yearTo + 1, 0, 1);
  const d0 = Math.round((from - Date.parse(`${meta.date0}T00:00:00Z`)) / 864e5);
  const d1 = Math.round((to - Date.parse(`${meta.date0}T00:00:00Z`)) / 864e5);
  for (let i = 0; i < rows.day.length; i++) {
    if (rows.day[i] >= d0 && rows.day[i] < d1) v[rows.cell[i]]++;
  }
  return v;
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
    `<div class="r"><span>Average per year</span><b>${fmt(s.perYear)}</b></div>`;
}

function renderDistricts() {
  dStats = computeDistrictStats();
  $("districts-block").hidden = !dStats;
  if (!dStats) return;
  const focus = new Set(districts.focus);
  const label = `${MONTH_NAMES[dStats.month - 1]} 1–${dStats.day}, ${dStats.year}`;
  $("districts-title").textContent = `Where it is burning: ${label}`;
  const list = dStats.districts
    .map((s) => ({ ...s, d: districts.districts[s.id] }))
    .filter((s) => s.d.cells > 0 && (!focus.size || focus.has(s.d.state)))
    .sort((a, b) => (b.now || 0) - (a.now || 0));
  const shown = state.allDistricts ? list : list.slice(0, 10);
  $("districts-toggle").textContent = state.allDistricts ? "Show top 10" : `Show all ${list.length} districts`;
  $("districts-toggle").hidden = list.length <= 10;
  const top = Math.max(1, ...list.map((s) => Math.max(s.now || 0, s.usual || 0)));
  const selIds = state.sel.kind === "districts" ? new Set(state.sel.ids) : new Set();
  $("districts-table").innerHTML = `<thead><tr><th>District</th><th class="barcell">This month so far
      <span class="muted">(bar) and usual (line)</span></th><th>Fire-days</th><th>Usual</th><th>Change</th><th class="py">Per year</th></tr></thead><tbody>${
    shown.map((s) => {
      const diff = s.usual > 0 ? 100 * (s.now / s.usual - 1) : NaN;
      const cls = diff > 10 ? "up" : diff < -10 ? "down" : "";
      return `<tr tabindex="0" data-id="${s.id}" class="${selIds.size === 1 && selIds.has(s.id) ? "on" : ""}">
        <td>${s.d.name}<span class="st">${s.d.state}</span></td>
        <td class="barcell"><div class="bar"><span style="width:${(100 * (s.now || 0)) / top}%"></span>${Number.isFinite(s.usual) ? `<em style="left:${(100 * s.usual) / top}%"></em>` : ""}</div></td>
        <td>${fmt(s.now)}</td><td>${fmt(s.usual)}</td><td class="${cls}">${pct(diff)}</td><td class="py">${fmt(s.perYear)}</td></tr>`;
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
