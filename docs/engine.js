// Harmonization engine for the browser. Mirrors harmonize.py step for step;
// tests/engine_parity.mjs checks both give the same numbers.
//
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
//
// Data model (built by build_site.py):
//   rows: one per (grid cell, local day) with at least one detection
//     day   Uint16  days since meta.date0
//     cell  Uint16  index into meta.cells ([lat, lon] centres)
//     flags Uint8   bit 1 Terra, 2 Aqua, 4 S-NPP, 8 NOAA-20

export const FLAG = { TERRA: 1, AQUA: 2, SNPP: 4, NOAA20: 8 };
export const METHODS = ["simple", "monthly"];
const DAY_MS = 86400000;

export function decode(meta, buffer) {
  const n = meta.rows;
  return {
    day: new Uint16Array(buffer, 0, n),
    cell: new Uint16Array(buffer, 2 * n, n),
    flags: new Uint8Array(buffer, 4 * n, n),
  };
}

export function dayToDate(meta, d) {
  return new Date(Date.parse(meta.date0 + "T00:00:00Z") + d * DAY_MS);
}

// ------------------------------------------------------------ selection
export function cellMask(meta, bbox) {
  const [s, w, n, e] = bbox;
  const mask = new Uint8Array(meta.cells.length);
  meta.cells.forEach(([lat, lon], i) => {
    if (lat >= s && lat <= n && lon >= w && lon <= e) mask[i] = 1;
  });
  return mask;
}

// Mask of the cells that belong to any of the given districts.
export function districtMask(meta, cellDistrict, ids) {
  const want = new Set(ids), mask = new Uint8Array(meta.cells.length);
  cellDistrict.forEach((d, i) => { if (want.has(d)) mask[i] = 1; });
  return mask;
}

// Weight of one VIIRS cell-day in the reference record. S-NPP counts 1. After
// S-NPP ended, NOAA-20 takes over at meta.n20Scale: S-NPP fire-days divided by
// NOAA-20 fire-days over the months both flew (NOAA-20 counts about 10% more),
// so the record does not step up at the handover. "All VIIRS" counts plainly.
export function viirsWeight(f, d, snppEnd, viirsAll, n20 = 1) {
  if (viirsAll) return f & (FLAG.SNPP | FLAG.NOAA20) ? 1 : 0;
  if (snppEnd == null) return f & FLAG.NOAA20 ? 1 : 0;
  if (f & FLAG.SNPP) return 1;
  return (f & FLAG.NOAA20) && d > snppEnd ? n20 : 0;
}

// Daily active-cell counts per instrument. NaN = instrument not observing.
// The area is opts.mask (one byte per cell) when given, otherwise the bbox.
export function dailyCounts(meta, rows, bbox, { aquaOnly = false, viirsAll = false, mask: given } = {}) {
  const start = Math.min(meta.coverage.MODIS[0], meta.coverage.VIIRS[0]);
  const end = Math.max(meta.coverage.MODIS[1], meta.coverage.VIIRS[1]);
  const len = end - start + 1;
  const modis = new Float64Array(len);
  const viirs = new Float64Array(len);
  const mask = given || cellMask(meta, bbox);
  const mBits = aquaOnly ? FLAG.AQUA : FLAG.TERRA | FLAG.AQUA;
  const snppEnd = meta.snppEnd; // null when S-NPP is absent
  const n20 = meta.n20Scale ?? 1;
  for (let i = 0; i < rows.day.length; i++) {
    if (!mask[rows.cell[i]]) continue;
    const d = rows.day[i], f = rows.flags[i], k = d - start;
    if (f & mBits) modis[k]++;
    const v = viirsWeight(f, d, snppEnd, viirsAll, n20);
    if (v) viirs[k] += v;
  }
  for (const [arr, inst] of [[modis, "MODIS"], [viirs, "VIIRS"]]) {
    const [a, b] = meta.coverage[inst];
    for (let k = 0; k < len; k++) {
      const d = start + k;
      if (d < a || d > b) arr[k] = NaN;
    }
  }
  return { start, len, modis, viirs };
}

// ------------------------------------------------------------- months
// Month keys are y * 12 + (m - 1). A month counts only if every day was observed.
export function monthlyCounts(meta, daily) {
  const out = new Map();
  for (let k = 0; k < daily.len; k++) {
    const dt = dayToDate(meta, daily.start + k);
    const key = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
    let m = out.get(key);
    if (!m) out.set(key, (m = { MODIS: 0, VIIRS: 0, seenM: 0, seenV: 0, days: daysInMonth(key) }));
    if (!Number.isNaN(daily.modis[k])) { m.MODIS += daily.modis[k]; m.seenM++; }
    if (!Number.isNaN(daily.viirs[k])) { m.VIIRS += daily.viirs[k]; m.seenV++; }
  }
  const months = [];
  for (const [key, m] of [...out.entries()].sort((a, b) => a[0] - b[0])) {
    months.push({
      key, year: Math.floor(key / 12), month: (key % 12) + 1,
      MODIS: m.seenM === m.days ? m.MODIS : NaN,
      VIIRS: m.seenV === m.days ? m.VIIRS : NaN,
    });
  }
  return months;
}

function daysInMonth(key) {
  const y = Math.floor(key / 12), m = key % 12;
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

// ---------------------------------------------------------- calibrate
// Scaling factor k for each calendar month (index 1..12): VIIRS ~ k x MODIS.
export function fitRatios(months, method = "monthly", minModis = 20) {
  const ov = months.filter((m) => !Number.isNaN(m.MODIS) && !Number.isNaN(m.VIIRS));
  const sumM = ov.reduce((s, m) => s + m.MODIS, 0);
  const sumV = ov.reduce((s, m) => s + m.VIIRS, 0);
  if (!ov.length || sumM <= 0) throw new Error("No overlap between MODIS and VIIRS in this area.");
  const kAll = sumV / sumM;
  const k = Array(13).fill(kAll);
  k[0] = NaN;
  if (method === "monthly") {
    const byM = Array.from({ length: 13 }, () => [0, 0]);
    for (const m of ov) { byM[m.month][0] += m.MODIS; byM[m.month][1] += m.VIIRS; }
    for (let i = 1; i <= 12; i++) if (byM[i][0] >= minModis) k[i] = byM[i][1] / byM[i][0];
  } else if (method !== "simple") {
    throw new Error(`unknown method ${method}`);
  }
  return k;
}

// ---------------------------------------------------------- harmonize
// VIIRS where it exists, otherwise MODIS scaled to VIIRS-equivalent.
export function harmonizeDaily(meta, daily, k) {
  const h = new Float64Array(daily.len);
  const src = new Uint8Array(daily.len); // 0 none, 1 VIIRS observed, 2 MODIS scaled
  for (let i = 0; i < daily.len; i++) {
    const v = daily.viirs[i];
    if (!Number.isNaN(v)) { h[i] = v; src[i] = 1; continue; }
    const m = daily.modis[i];
    if (Number.isNaN(m)) { h[i] = NaN; continue; }
    const month = dayToDate(meta, daily.start + i).getUTCMonth() + 1;
    h[i] = m * k[month]; src[i] = 2;
  }
  return { start: daily.start, len: daily.len, h, src };
}

// Monthly sums of harmonized fire-days; a partial month keeps its partial sum.
export function harmonizedMonths(meta, harm) {
  const map = new Map();
  for (let i = 0; i < harm.len; i++) {
    const dt = dayToDate(meta, harm.start + i);
    const key = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
    let m = map.get(key);
    if (!m) map.set(key, (m = { key, year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1,
                                 value: 0, seen: 0, viirs: 0, modis: 0, days: daysInMonth(key) }));
    if (!Number.isNaN(harm.h[i])) {
      m.value += harm.h[i]; m.seen++;
      if (harm.src[i] === 1) m.viirs++; else m.modis++;
    }
  }
  const out = [...map.values()].sort((a, b) => a.key - b.key);
  for (const m of out) if (!m.seen) m.value = NaN;
  return out;
}

// Years x months table: { years: [...], values: [[12 numbers or NaN], ...] }
export function calendar(hMonths, yearFrom = -Infinity, yearTo = Infinity) {
  const years = [...new Set(hMonths.map((m) => m.year))]
    .filter((y) => y >= yearFrom && y <= yearTo).sort((a, b) => a - b);
  const idx = new Map(years.map((y, i) => [y, i]));
  const values = years.map(() => Array(12).fill(NaN));
  const meta = years.map(() => Array(12).fill(null));
  for (const m of hMonths) {
    if (!idx.has(m.year)) continue;
    values[idx.get(m.year)][m.month - 1] = m.value;
    meta[idx.get(m.year)][m.month - 1] = m;
  }
  return { years, values, cells: meta };
}

// Latest month so far vs the same days of that month in earlier years.
export function monthToDate(meta, harm) {
  let last = -1;
  for (let i = harm.len - 1; i >= 0; i--) if (!Number.isNaN(harm.h[i])) { last = i; break; }
  if (last < 0) return null;
  const lastDate = dayToDate(meta, harm.start + last);
  const M = lastDate.getUTCMonth(), D = lastDate.getUTCDate();
  const byYear = new Map();
  for (let i = 0; i <= last; i++) {
    if (Number.isNaN(harm.h[i])) continue;
    const dt = dayToDate(meta, harm.start + i);
    if (dt.getUTCMonth() !== M || dt.getUTCDate() > D) continue;
    const y = dt.getUTCFullYear();
    const r = byYear.get(y) || { sum: 0, n: 0 };
    r.sum += harm.h[i]; r.n++;
    byYear.set(y, r);
  }
  const years = [...byYear.entries()].filter(([, r]) => r.n === D)
    .sort((a, b) => a[0] - b[0]).map(([year, r]) => ({ year, value: r.sum }));
  return { lastDate, month: M + 1, day: D, years };
}

// ----------------------------------------------------------- validate
// Leave-one-year-out on the overlap years. WAPE = sum|error| / sum observed.
export function loyoValidation(months, minModis = 20) {
  const ov = months.filter((m) => !Number.isNaN(m.MODIS) && !Number.isNaN(m.VIIRS));
  const years = [...new Set(ov.map((m) => m.year))].sort((a, b) => a - b);
  const perYear = [];
  for (const year of years) {
    const test = ov.filter((m) => m.year === year);
    const train = months.map((m) => (m.year === year ? { ...m, VIIRS: NaN } : m));
    for (const method of METHODS) {
      let k;
      try { k = fitRatios(train, method, minModis); } catch { continue; }
      let obs = 0, pred = 0, err = 0;
      for (const m of test) {
        const p = m.MODIS * k[m.month];
        obs += m.VIIRS; pred += p; err += Math.abs(p - m.VIIRS);
      }
      perYear.push({ year, method, observed: obs, predicted: pred, absError: err });
    }
  }
  const summary = {};
  for (const method of METHODS) {
    const r = perYear.filter((p) => p.method === method);
    if (!r.length) continue;
    const o = r.reduce((s, p) => s + p.observed, 0);
    summary[method] = {
      wape: (100 * r.reduce((s, p) => s + p.absError, 0)) / o,
      bias: 100 * (r.reduce((s, p) => s + p.predicted, 0) / o - 1),
      years: new Set(r.map((p) => p.year)).size,
    };
  }
  return { summary, perYear };
}

// Annual totals; a year counts only with 12 complete months.
export function annual(months, valueOf) {
  const by = new Map();
  for (const m of months) {
    const r = by.get(m.year) || { sum: 0, n: 0 };
    const v = valueOf(m);
    if (!Number.isNaN(v)) { r.sum += v; r.n++; }
    by.set(m.year, r);
  }
  return new Map([...by.entries()].map(([y, r]) => [y, r.n === 12 ? r.sum : NaN]));
}

// Is there an artificial jump where the record switches to VIIRS?
export function stepCheck(months, k, nYears = 3) {
  const firstV = months.find((m) => !Number.isNaN(m.VIIRS));
  if (!firstV) return null;
  const y0 = firstV.year;
  const scaled = (m) => m.MODIS * k[m.month];
  const series = {
    modisOnly: (m) => m.MODIS,
    rawSplice: (m) => (Number.isNaN(m.VIIRS) ? m.MODIS : m.VIIRS),
    harmonized: (m) => (Number.isNaN(m.VIIRS) ? scaled(m) : m.VIIRS),
  };
  const mean = (arr) => {
    const v = arr.filter((x) => !Number.isNaN(x));
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
  };
  const out = { year: y0 };
  for (const [name, f] of Object.entries(series)) {
    const a = annual(months, f);
    const before = mean(range(y0 - nYears, y0).map((y) => (a.has(y) ? a.get(y) : NaN)));
    const after = mean(range(y0, y0 + nYears).map((y) => (a.has(y) ? a.get(y) : NaN)));
    out[name] = before ? after / before : NaN;
  }
  return out;
}

function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }

// ------------------------------------------------------- per district
// Harmonized fire-days for every district in one pass, using the scaling
// factors k of the wider area (districts are too small to calibrate alone).
// Returns per district: this month so far, the median of earlier years for
// the same days, and the average per complete year in [yearFrom, yearTo].
export function districtStats(meta, rows, cellDistrict, nDistricts, k, opts, yearFrom, yearTo) {
  const { aquaOnly = false, viirsAll = false } = opts;
  const start = Math.min(meta.coverage.MODIS[0], meta.coverage.VIIRS[0]);
  const end = Math.max(meta.coverage.MODIS[1], meta.coverage.VIIRS[1]);
  const len = end - start + 1;
  const M = Array.from({ length: nDistricts }, () => new Float32Array(len));
  const V = Array.from({ length: nDistricts }, () => new Float32Array(len));
  const mBits = aquaOnly ? FLAG.AQUA : FLAG.TERRA | FLAG.AQUA, snppEnd = meta.snppEnd;
  const n20 = meta.n20Scale ?? 1;
  for (let i = 0; i < rows.day.length; i++) {
    const dist = cellDistrict[rows.cell[i]];
    if (dist < 0) continue;
    const d = rows.day[i], f = rows.flags[i], j = d - start;
    if (f & mBits) M[dist][j]++;
    const v = viirsWeight(f, d, snppEnd, viirsAll, n20);
    if (v) V[dist][j] += v;
  }
  // calendar of each daily index, computed once
  const year = new Int16Array(len), month = new Int8Array(len), dom = new Int8Array(len);
  for (let j = 0; j < len; j++) {
    const dt = dayToDate(meta, start + j);
    year[j] = dt.getUTCFullYear(); month[j] = dt.getUTCMonth() + 1; dom[j] = dt.getUTCDate();
  }
  const [vA, vB] = meta.coverage.VIIRS, [mA, mB] = meta.coverage.MODIS;
  const last = len - 1, lastY = year[last], lastM = month[last], lastD = dom[last];
  const out = [];
  for (let dist = 0; dist < nDistricts; dist++) {
    const byYearMtd = new Map(), byYear = new Map();
    for (let j = 0; j < len; j++) {
      const d = start + j;
      let h;
      if (d >= vA && d <= vB) h = V[dist][j];
      else if (d >= mA && d <= mB) h = M[dist][j] * k[month[j]];
      else continue;
      const y = year[j];
      const a = byYear.get(y) || { sum: 0, n: 0 };
      a.sum += h; a.n++; byYear.set(y, a);
      if (month[j] === lastM && dom[j] <= lastD) {
        const b = byYearMtd.get(y) || { sum: 0, n: 0 };
        b.sum += h; b.n++; byYearMtd.set(y, b);
      }
    }
    const daysIn = (y) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);
    const full = [...byYear.entries()].filter(([y, a]) => a.n === daysIn(y) && y >= yearFrom && y <= yearTo);
    const earlier = [...byYearMtd.entries()]
      .filter(([y, b]) => y < lastY && b.n === lastD && y >= yearFrom && y <= yearTo).map(([, b]) => b.sum)
      .sort((a, b) => a - b);
    const mid = Math.floor(earlier.length / 2);
    const median = earlier.length ? (earlier.length % 2 ? earlier[mid] : (earlier[mid - 1] + earlier[mid]) / 2) : NaN;
    out.push({
      id: dist,
      now: byYearMtd.get(lastY)?.sum ?? NaN,
      usual: median,
      perYear: full.length ? full.reduce((s, [, a]) => s + a.sum, 0) / full.length : NaN,
      series: full.map(([y, a]) => [y, a.sum]).sort((p, q) => p[0] - q[0]),   // complete years
    });
  }
  return { districts: out, month: lastM, day: lastD, year: lastY };
}

// ------------------------------------------------------------- run all
export function analyse(meta, rows, opts) {
  const daily = dailyCounts(meta, rows, opts.bbox, opts);
  const months = monthlyCounts(meta, daily);
  const k = fitRatios(months, opts.method);
  const harm = harmonizeDaily(meta, daily, k);
  const hMonths = harmonizedMonths(meta, harm);
  return {
    daily, months, k, harm, hMonths,
    mtd: monthToDate(meta, harm),
    validation: loyoValidation(months),
    steps: stepCheck(months, k),
    annualModis: annual(months, (m) => m.MODIS),
    annualViirs: annual(months, (m) => m.VIIRS),
    annualHarm: annual(hMonths, (m) => (m.seen === m.days ? m.value : NaN)),
  };
}

// ---------------------------------------------------- unusual activity
// For every district: harmonized fire-days in the last `days` days, and the
// same dates in each earlier year in [yearFrom, yearTo]. A district is
// flagged when it is above the 90th percentile of those years and at least
// 1.5 times their median (and at least 5 fire-days), so quiet districts with
// one or two fires are not flagged.
export function districtRecent(meta, rows, cellDistrict, nDistricts, k, opts, days, yearFrom, yearTo) {
  const { aquaOnly = false, viirsAll = false } = opts;
  const start = Math.min(meta.coverage.MODIS[0], meta.coverage.VIIRS[0]);
  const end = Math.max(meta.coverage.MODIS[1], meta.coverage.VIIRS[1]);
  const len = end - start + 1;
  const M = Array.from({ length: nDistricts }, () => new Float32Array(len));
  const V = Array.from({ length: nDistricts }, () => new Float32Array(len));
  const mBits = aquaOnly ? FLAG.AQUA : FLAG.TERRA | FLAG.AQUA, snppEnd = meta.snppEnd;
  const n20 = meta.n20Scale ?? 1;
  for (let i = 0; i < rows.day.length; i++) {
    const dist = cellDistrict[rows.cell[i]];
    if (dist < 0) continue;
    const d = rows.day[i], f = rows.flags[i], j = d - start;
    if (f & mBits) M[dist][j]++;
    const v = viirsWeight(f, d, snppEnd, viirsAll, n20);
    if (v) V[dist][j] += v;
  }
  const [vA, vB] = meta.coverage.VIIRS, [mA, mB] = meta.coverage.MODIS;
  const observed = (d) => (d >= vA && d <= vB) || (d >= mA && d <= mB);
  const value = (dist, d) => {
    const j = d - start;
    if (d >= vA && d <= vB) return V[dist][j];
    return M[dist][j] * k[dayToDate(meta, d).getUTCMonth() + 1];
  };
  // the window in the latest year and the same calendar dates in earlier years
  const lastDate = dayToDate(meta, end), lastYear = lastDate.getUTCFullYear();
  const date0 = Date.parse(meta.date0 + "T00:00:00Z");
  const windows = [];
  for (let y = lastYear; y >= Math.max(yearFrom, 1990); y--) {
    if (y > yearTo && y !== lastYear) continue;
    const e = (Date.UTC(y, lastDate.getUTCMonth(), lastDate.getUTCDate()) - date0) / DAY_MS;
    const s = e - days + 1;
    if (s < start || e > end) continue;
    let ok = true;
    for (let d = s; d <= e; d++) if (!observed(d)) { ok = false; break; }
    if (ok) windows.push({ year: y, s, e });
  }
  const cur = windows.find((w) => w.year === lastYear);
  const past = windows.filter((w) => w.year !== lastYear);
  const out = [];
  for (let dist = 0; dist < nDistricts; dist++) {
    const sum = (w) => { let t = 0; for (let d = w.s; d <= w.e; d++) t += value(dist, d); return t; };
    const now = cur ? sum(cur) : NaN;
    const hist = past.map(sum).sort((a, b) => a - b);
    const q = (p) => {
      if (!hist.length) return NaN;
      const x = (hist.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
      return hist[lo] + (hist[hi] - hist[lo]) * (x - lo);
    };
    const median = q(0.5), p90 = q(0.9), max = hist.length ? hist.at(-1) : NaN;
    const flagged = hist.length >= 5 && now >= 5 && now > p90 && now >= 1.5 * median;
    out.push({ id: dist, now, median, p90, max, below: hist.filter((v) => v < now).length,
               years: hist.length, ratio: median > 0 ? now / median : NaN, flagged,
               record: hist.length >= 5 && now > max && now >= 5 });
  }
  return { districts: out, days, from: cur ? dayToDate(meta, cur.s) : null, to: lastDate, years: past.length };
}
