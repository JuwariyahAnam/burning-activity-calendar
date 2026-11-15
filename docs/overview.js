// "When India burns": the typical burning year of every study area on one
// calendar, with today marked, which areas are in season now and which start
// next. Data: data/overview.json, made by tools/overview.mjs with this site's
// own engine.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import { ember, ZERO } from "./viz.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
const monthOf = (doy) => CUM.findIndex((c, i) => doy >= c && doy < CUM[i + 1]);
const dayLabel = (doy) => { const m = monthOf(doy); return `${doy - CUM[m] + 1} ${MONTHS[m].slice(0, 3)}`; };
const part = (doy) => { const m = monthOf(doy), d = doy - CUM[m] + 1;
  return `${d <= 10 ? "early" : d <= 20 ? "mid" : "late"} ${MONTHS[m]}`; };
const doyOfDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Math.min(364, CUM[m - 1] + d - 1); };
const fmtN = (v) => v.toLocaleString("en-IN");
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const inPeriod = (p, d) => (p.start <= p.end ? d >= p.start && d <= p.end : d >= p.start || d <= p.end);
const daysUntil = (from, to) => (to - from + 365) % 365;

async function render() {
  const section = document.getElementById("india");
  if (!section) return;
  let data;
  try {
    const r = await fetch("data/overview.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch {
    section.hidden = true;                       // no overview built yet: leave the section out
    return;
  }
  const regions = data.regions.filter((r) => r.bins?.length);
  if (!regions.length) { section.hidden = true; return; }
  const nb = regions[0].bins.length, bd = data.binDays || 5;
  const today = doyOfDate(regions.map((r) => r.alertsTo).filter(Boolean).sort().at(-1) || new Date().toISOString().slice(0, 10));

  // the grid: a label column, one column per few days, and this week's alerts
  const grid = document.getElementById("india-grid");
  grid.replaceChildren();
  grid.style.setProperty("--bins", nb);
  grid.appendChild(el("div", "ig-corner", ""));
  for (let m = 0; m < 12; m++) {
    const h = el("div", "ig-month", MONTHS[m].slice(0, 3));
    h.dataset.s = MONTHS[m][0];
    h.style.gridColumn = `${2 + Math.floor(CUM[m] / bd)} / ${2 + Math.floor(CUM[m + 1] / bd)}`;
    grid.appendChild(h);
  }
  grid.appendChild(el("div", "ig-status-h", "This week"));
  const ordered = [...regions].sort((a, b) => a.peakDoy - b.peakDoy);
  ordered.forEach((r, ri) => {
    const row = 2 + ri;
    const label = el("div", "ig-label");
    label.style.gridRow = row;
    const a = el("a", "ig-name", r.name);
    a.href = `?region=${encodeURIComponent(r.slug)}#explore`;
    label.append(a, el("span", "ig-sub", `Peak in ${part(r.peakDoy)}, ${fmtN(r.perYear)} fire-days in a usual year`));
    grid.appendChild(label);
    const max = Math.max(...r.bins) || 1;
    r.bins.forEach((v, i) => {
      const c = el("div", "ig-cell");
      c.style.gridRow = row;
      c.style.gridColumn = 2 + i;
      const t = v / max;
      c.style.background = v > 0 ? ember(0.03 + 0.97 * Math.pow(t, 1.35)) : ZERO;
      c.title = `${r.name}, ${dayLabel(i * bd)} to ${dayLabel(Math.min(364, i * bd + bd - 1))}: ` +
        `${fmtN(Math.round(v))} fire-days a day in a usual year (${Math.round(100 * t)}% of its peak)`;
      grid.appendChild(c);
    });
    const st = el("div", "ig-status");
    st.style.gridRow = row;
    if (r.flagged == null) st.textContent = "–";
    else if (r.flagged > 0) {
      st.classList.add("hot");
      st.textContent = `${r.flagged} of ${r.districts} districts far above usual`;
    } else st.textContent = "No district far above usual";
    grid.appendChild(st);
  });
  const mark = el("div", "ig-today");
  mark.style.gridColumn = 2 + Math.floor(today / bd);
  mark.style.gridRow = `2 / ${2 + ordered.length}`;
  mark.setAttribute("aria-hidden", "true");
  mark.appendChild(el("span", "", "Today"));
  grid.appendChild(mark);
  grid.setAttribute("aria-label", `Typical burning through the year in ${ordered.length} study areas, ` +
    `ordered by peak date. ${ordered.map((r) => `${r.name}: peak in ${part(r.peakDoy)}`).join("; ")}.`);

  // in season now, and the seasons that start next
  const main = (r) => r.periods[0];
  const now = ordered.filter((r) => r.periods.some((p) => inPeriod(p, today)));
  const next = ordered.filter((r) => !now.includes(r) && main(r))
    .map((r) => ({ r, p: main(r), d: daysUntil(today, main(r).start) }))
    .sort((a, b) => a.d - b.d).slice(0, 3);
  const box = document.getElementById("india-next");
  box.replaceChildren();
  const col = (title, items) => { const c = el("div", "in-col"); c.appendChild(el("h3", "", title));
    const ul = el("ul"); items.forEach((t) => ul.appendChild(el("li", "", t))); c.appendChild(ul); return c; };
  box.append(
    col("In season now", now.length ? now.map((r) => {
      const p = r.periods.find((q) => inPeriod(q, today));
      return `${r.name}: ${dayLabel(p.start)} to ${dayLabel(p.end)}`;
    }) : ["No study area is in its main burning season."]),
    col("Starting next", next.map(({ r, p, d }) => `${r.name}: usually from ${dayLabel(p.start)}, in about ${d} days`)),
  );
  document.getElementById("india-takeaway").textContent =
    `The burning season moves across India through the year: ${ordered[0].name} peaks first, in ${part(ordered[0].peakDoy)}, ` +
    `and ${ordered.at(-1).name} last, in ${part(ordered.at(-1).peakDoy)}. Responders can plan where to be, and when, a season ahead.`;
  const note = document.getElementById("india-note");
  const lastRef = Math.max(...regions.map((r) => r.years[1]));
  if (note) note.textContent = `Typical year: the median of each area's complete years up to ${lastRef}, in harmonized ` +
    `fire-days; brightness is relative to each area's own peak. Alerts: the week to ${dayLabel(today)}.`;
}

render();
