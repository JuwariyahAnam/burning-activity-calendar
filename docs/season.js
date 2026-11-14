// Season analytics on the harmonized daily record: a typical year, its
// critical periods, a two-week outlook and the timing of each season.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
//
// Every number here comes from the same harmonized daily series as the rest
// of the page (VIIRS where it exists, MODIS scaled to VIIRS before that).
// Days are placed on a 365-day year; 29 February is left out.
import { dayToDate } from "./engine.js";

const N = 365;
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// day of year 0..364 for a UTC date; -1 for 29 February
export function doyOf(dt) {
  const m = dt.getUTCMonth(), d = dt.getUTCDate();
  if (m === 1 && d === 29) return -1;
  return CUM[m] + d - 1;
}
export function doyLabel(i) {
  i = ((i % N) + N) % N;
  let m = 11;
  while (CUM[m] > i) m--;
  return `${i - CUM[m] + 1} ${MONTHS[m]}`;
}
const wrap = (i) => ((i % N) + N) % N;

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}
const median = (v) => quantile([...v].sort((a, b) => a - b), 0.5);

// years x 365 grid of daily harmonized fire-days (NaN where not observed)
export function yearGrid(meta, harm) {
  const grid = new Map();
  let last = null;
  for (let i = 0; i < harm.len; i++) {
    const dt = dayToDate(meta, harm.start + i), j = doyOf(dt);
    if (j < 0) continue;
    const y = dt.getUTCFullYear();
    if (!grid.has(y)) grid.set(y, new Float64Array(N).fill(NaN));
    grid.get(y)[j] = harm.h[i];
    if (!Number.isNaN(harm.h[i])) last = { year: y, doy: j, date: dt };
  }
  const years = [...grid.keys()].sort((a, b) => a - b);
  return { grid, years, last };
}

// centred rolling mean (window days) over the whole record, ignoring gaps
function smoothGrid(g, window = 15) {
  const { grid, years } = g, half = Math.floor(window / 2);
  const flat = new Float64Array(years.length * N);
  years.forEach((y, k) => flat.set(grid.get(y), k * N));
  const out = new Float64Array(flat.length).fill(NaN);
  for (let i = 0; i < flat.length; i++) {
    if (Number.isNaN(flat[i])) continue;
    let s = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(flat.length - 1, i + half); j++) {
      if (!Number.isNaN(flat[j])) { s += flat[j]; n++; }
    }
    if (n >= Math.ceil(window / 2)) out[i] = s / n;
  }
  const res = new Map();
  years.forEach((y, k) => res.set(y, out.subarray(k * N, (k + 1) * N)));
  return res;
}

// a year is a reference year when it is complete and earlier than the current one
function referenceYears(g, yearFrom, yearTo) {
  return g.years.filter((y) => {
    if (y >= g.last.year || y < yearFrom || y > yearTo) return false;
    let seen = 0;
    for (const v of g.grid.get(y)) if (!Number.isNaN(v)) seen++;
    return seen >= 360;
  });
}

// ------------------------------------------------------- typical year
// Median and 10th-90th percentile of the 15-day average for each day of the
// year, plus the current year and the critical periods.
export function seasonCurve(meta, harm, yearFrom = -Infinity, yearTo = Infinity) {
  const g = yearGrid(meta, harm);
  if (!g.last) return null;
  const smooth = smoothGrid(g);
  const ref = referenceYears(g, yearFrom, yearTo);
  const med = new Float64Array(N), p10 = new Float64Array(N), p90 = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const v = ref.map((y) => smooth.get(y)[j]).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    med[j] = quantile(v, 0.5); p10[j] = quantile(v, 0.1); p90[j] = quantile(v, 0.9);
  }
  const yearLine = (y) => (smooth.has(y) ? Array.from(smooth.get(y)) : null);
  return {
    grid: g, smooth, ref, med, p10, p90,
    current: { year: g.last.year, values: yearLine(g.last.year), lastDoy: g.last.doy },
    yearLine,
    periods: criticalPeriods(med),
  };
}

// Critical periods: runs of days when usual burning is at least a quarter of
// the year's peak, so a smaller second season (such as wheat stubble in spring)
// is kept. Gaps of up to 10 days are merged and runs under a week dropped.
// Where burning goes on for much of the year, the level is raised (up to 80%
// of the peak) until the periods cover at most about four months, so they
// still single out the critical weeks.
export const CRITICAL_LEVEL = 0.25;
export function criticalPeriods(med, level = CRITICAL_LEVEL, maxDays = 120) {
  let lv = level, runs = [];
  for (; lv <= 0.8 + 1e-9; lv += 0.05) {
    runs = periodsAt(med, lv);
    if (runs.reduce((n, r) => n + r.days, 0) <= maxDays) break;
  }
  // a blip of a few percent of the year is not a critical period
  const big = runs.filter((r) => r.share >= 0.05);
  return (big.length ? big : runs).map((r) => ({ ...r, level: Math.min(lv, 0.8) }));
}
function periodsAt(med, level) {
  const total = med.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  if (!(total > 0)) return [];
  const top = Math.max(...med.filter(Number.isFinite));
  const hot = new Uint8Array(N);
  for (let j = 0; j < N; j++) hot[j] = med[j] > 0 && med[j] >= level * top ? 1 : 0;
  // merge gaps of up to 10 days, going round the year
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < N; j++) {
      if (!hot[j] || hot[wrap(j + 1)]) continue;
      let k = 1;
      while (k <= 11 && !hot[wrap(j + k)]) k++;
      if (k <= 11) for (let t = 1; t < k; t++) hot[wrap(j + t)] = 1;
    }
  }
  if (hot.every(Boolean)) return [{ start: 0, end: N - 1, peak: med.indexOf(Math.max(...med)), share: 1, days: N }];
  let s0 = 0;
  while (hot[s0]) s0 = wrap(s0 + 1);           // start scanning from a quiet day
  const runs = [];
  for (let t = 1; t <= N; t++) {
    const j = wrap(s0 + t);
    if (hot[j] && !hot[wrap(j - 1)]) runs.push({ start: j, end: j });
    else if (hot[j]) runs.at(-1).end = j;
  }
  const out = runs.map((r) => {
    const days = wrap(r.end - r.start) + 1;
    let sum = 0, peak = r.start;
    for (let t = 0; t < days; t++) {
      const j = wrap(r.start + t);
      sum += med[j];
      if (med[j] > med[peak]) peak = j;
    }
    return { ...r, days, peak, share: sum / total };
  }).filter((r, _, all) => r.days >= 7 || all.length === 1);
  return out.sort((a, b) => b.share - a.share);
}

// Season windows for timing: each critical period widened by up to 30 days a
// side, without running into the next one.
export function seasonWindows(periods) {
  const ps = [...periods].sort((a, b) => a.start - b.start);
  return ps.map((p, i) => {
    if (ps.length === 1) {
      const pad = Math.min(30, Math.floor((N - p.days) / 2));
      return { ...p, wStart: wrap(p.start - pad), wDays: p.days + 2 * pad };
    }
    const prev = ps[(i - 1 + ps.length) % ps.length], next = ps[(i + 1) % ps.length];
    const before = Math.min(30, Math.floor((wrap(p.start - prev.end) - 1) / 2));
    const after = Math.min(30, Math.floor((wrap(next.start - p.end) - 1) / 2));
    return { ...p, wStart: wrap(p.start - before), wDays: p.days + before + after };
  });
}

// sum of daily values over n days from (year, doy), running into the next year
function sumDays(g, year, doy, n) {
  let s = 0;
  for (let t = 0; t < n; t++) {
    const j = doy + t, y = year + Math.floor(j / N), row = g.grid.get(y);
    const v = row ? row[wrap(j)] : NaN;
    if (Number.isNaN(v)) return NaN;
    s += v;
  }
  return s;
}

// ------------------------------------------------------------ outlook
// What the next `days` days usually bring, how the last `days` days compare
// with the same dates in earlier years, and how far the season usually is.
export function outlook(curve, days = 14) {
  const g = curve.grid, last = g.last, ref = curve.ref;
  const nextStart = last.doy + 1, prevStart = last.doy - days + 1;
  const nextVals = ref.map((y) => sumDays(g, y, nextStart, days)).filter(Number.isFinite).sort((a, b) => a - b);
  const prevVals = ref.map((y) => sumDays(g, y + Math.floor(prevStart / N), wrap(prevStart), days))
    .filter(Number.isFinite).sort((a, b) => a - b);
  const now = sumDays(g, last.year + Math.floor(prevStart / N), wrap(prevStart), days);
  const out = {
    asOf: last.date, days,
    next: { from: wrap(nextStart), to: wrap(nextStart + days - 1), median: quantile(nextVals, 0.5),
            low: quantile(nextVals, 0.1), high: quantile(nextVals, 0.9), years: nextVals.length },
    last: { from: wrap(prevStart), to: last.doy, value: now, median: quantile(prevVals, 0.5),
            below: prevVals.filter((v) => v < now).length, years: prevVals.length },
  };
  const a = out.next.median, b = out.last.median;
  out.direction = !(a > 0 || b > 0) ? "quiet" : a > 1.25 * b ? "rises" : a < 0.8 * b ? "falls" : "steady";
  // where the coming days sit in the typical year
  const inside = (p, j) => wrap(j - p.start) < p.days;
  const nowIn = curve.periods.find((p) => inside(p, wrap(nextStart)) || inside(p, last.doy));
  const upcoming = [...curve.periods].map((p) => ({ p, wait: wrap(p.start - wrap(nextStart)) }))
    .sort((x, y) => x.wait - y.wait)[0];
  out.period = nowIn ? { ...nowIn, now: true } : upcoming ? { ...upcoming.p, now: false, wait: upcoming.wait } : null;
  // season progress: share of the season's burning usually done by this date
  const win = seasonWindows(curve.periods).find((w) => wrap(last.doy - w.wStart) < w.wDays);
  if (win) {
    const into = wrap(last.doy - win.wStart) + 1;
    const startYear = (y) => (win.wStart > last.doy ? y - 1 : y);   // window began last year
    const done = [], cumRef = [];
    for (const y of ref) {
      const total = sumDays(g, startYear(y), win.wStart, win.wDays);
      const sofar = sumDays(g, startYear(y), win.wStart, into);
      if (total > 0 && Number.isFinite(sofar)) { done.push(sofar / total); cumRef.push(sofar); }
    }
    const cur = sumDays(g, startYear(last.year), win.wStart, into);
    out.season = {
      start: win.wStart, end: wrap(win.wStart + win.wDays - 1), done: median(done),
      sofar: cur, usual: median(cumRef), years: done.length,
    };
  }
  return out;
}

// ------------------------------------------------------- season timing
// For each season window and year: the dates by which 10%, 50% and 90% of
// that season's burning had happened, the peak week and the total.
export function seasonTiming(curve) {
  const g = curve.grid, wins = seasonWindows(curve.periods);
  return wins.map((w) => {
    const rows = [];
    for (const y of g.years) {
      const vals = [];
      for (let t = 0; t < w.wDays; t++) {
        const j = w.wStart + t, row = g.grid.get(y + Math.floor(j / N));
        vals.push(row ? row[wrap(j)] : NaN);
      }
      if (vals.some(Number.isNaN)) continue;               // incomplete season
      const total = vals.reduce((s, v) => s + v, 0);
      if (!(total > 0)) continue;
      let acc = 0, t10 = -1, t50 = -1, t90 = -1;
      vals.forEach((v, t) => {
        acc += v;
        if (t10 < 0 && acc >= 0.1 * total) t10 = t;
        if (t50 < 0 && acc >= 0.5 * total) t50 = t;
        if (t90 < 0 && acc >= 0.9 * total) t90 = t;
      });
      let best = -1, peak = 0;                              // busiest 7 days
      for (let t = 0; t + 7 <= vals.length; t++) {
        let s = 0; for (let k = 0; k < 7; k++) s += vals[t + k];
        if (s > best) { best = s; peak = t + 3; }
      }
      rows.push({ year: y, start: t10, mid: t50, end: t90, peak, total });
    }
    const trendMid = theilSen(rows.map((r) => [r.year, r.mid]));
    const trendTotal = theilSen(rows.map((r) => [r.year, r.total]));
    const medTotal = median(rows.map((r) => r.total));
    return {
      window: w, rows,
      name: `${doyLabel(w.start)} – ${doyLabel(w.end)}`,
      label: (t) => doyLabel(w.wStart + t),
      midShift: { perDecade: trendMid.slope * 10, p: mannKendall(rows.map((r) => [r.year, r.mid])) },
      totalTrend: { pctPerYear: medTotal > 0 ? (100 * trendTotal.slope) / medTotal : NaN,
                    p: mannKendall(rows.map((r) => [r.year, r.total])) },
    };
  });
}

// ------------------------------------------------------------- trends
// Theil-Sen slope (median of pairwise slopes) and the Mann-Kendall test,
// standard choices for short, noisy environmental series.
export function theilSen(points) {
  const s = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j][0] - points[i][0];
      if (dx) s.push((points[j][1] - points[i][1]) / dx);
    }
  }
  const slope = s.length ? median(s) : NaN;
  const icpt = median(points.map(([x, y]) => y - slope * x));
  return { slope, intercept: icpt };
}

export function mannKendall(points) {
  const n = points.length;
  if (n < 6) return NaN;
  const ys = [...points].sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  let S = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) S += Math.sign(ys[j] - ys[i]);
  const varS = (n * (n - 1) * (2 * n + 5)) / 18;
  const z = S === 0 ? 0 : (S - Math.sign(S)) / Math.sqrt(varS);
  return 2 * (1 - phi(Math.abs(z)));
}

function phi(z) {                     // standard normal CDF (Abramowitz-Stegun 7.1.26)
  const t = 1 / (1 + 0.3275911 * z / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + erf);
}

// trend of yearly totals as % of the median year, with its p-value
export function yearlyTrend(series) {
  const pts = series.filter(([, v]) => Number.isFinite(v));
  if (pts.length < 6) return { pct: NaN, p: NaN };
  const m = median(pts.map(([, v]) => v));
  return { pct: m > 0 ? (100 * theilSen(pts).slope) / m : NaN, p: mannKendall(pts) };
}
