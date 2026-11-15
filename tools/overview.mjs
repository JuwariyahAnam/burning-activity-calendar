// Build docs/data/overview.json: the typical burning year of every built study
// area, for the "When India burns" calendar on the home page. It runs the
// website's own engine (docs/engine.js, docs/season.js), so the numbers match
// what each area's page shows. Run after build_site.py:  node tools/overview.mjs
//
// AI disclosure: drafted with Claude (Anthropic); review before use.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../docs/engine.js";
import * as S from "../docs/season.js";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "data");
const BIN = 5;                                     // days per column: 73 columns a year
const read = (f) => fs.readFileSync(path.join(DATA, f));
const json = (f) => JSON.parse(read(f).toString("utf8"));

const index = json("regions.json");
const out = [];
for (const r of index.regions) {
  const dir = r.slug;
  if (!fs.existsSync(path.join(DATA, dir, "cells.bin"))) continue;
  const meta = json(`${dir}/meta.json`);
  const buf = read(`${dir}/cells.bin`);
  const rows = E.decode(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const dist = fs.existsSync(path.join(DATA, dir, "districts.json")) ? json(`${dir}/districts.json`) : null;
  const opts = dist && dist.focusIds?.length
    ? { mask: E.districtMask(meta, dist.cellDistrict, dist.focusIds) } : { bbox: meta.bbox };
  const res = E.analyse(meta, rows, { ...opts, method: "monthly" });
  const curve = S.seasonCurve(meta, res.harm);
  if (!curve) continue;
  const med = Array.from(curve.med);
  const bins = [];
  for (let i = 0; i < 365; i += BIN) {
    const part = med.slice(i, i + BIN);
    bins.push(+(part.reduce((s, v) => s + v, 0) / part.length).toFixed(2));
  }
  const total = med.reduce((s, v) => s + v, 0);
  const peak = med.indexOf(Math.max(...med));
  const al = fs.existsSync(path.join(DATA, dir, "alerts.json")) ? json(`${dir}/alerts.json`) : null;
  out.push({
    slug: r.slug, name: r.name,
    perYear: Math.round(total),                  // usual fire-days a year (sum of the typical day)
    peakDoy: peak,
    periods: curve.periods.map((p) => ({ start: p.start, end: p.end, share: +p.share.toFixed(3) })),
    bins,
    flagged: al ? al.flagged.length : null,
    districts: dist?.focusIds?.length ?? null,
    alertsTo: al?.to ?? null,
    years: [curve.ref[0], curve.ref[curve.ref.length - 1]],
  });
  console.log(`${r.name}: peak day ${peak}, ${out.at(-1).perYear} fire-days in a usual year, ` +
              `${out.at(-1).periods.length} critical period(s)`);
}
fs.writeFileSync(path.join(DATA, "overview.json"),
  JSON.stringify({ generated: new Date().toISOString().slice(0, 10), binDays: BIN, regions: out }));
console.log(`wrote docs/data/overview.json (${out.length} areas)`);
