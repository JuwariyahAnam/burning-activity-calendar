// Check that docs/engine.js gives the same numbers as harmonize.py.
// Usage: python tests/engine_parity.py   (writes reference JSON, then runs this)
import { readFileSync } from "node:fs";
import * as E from "../docs/engine.js";

const [dataDir, refPath] = process.argv.slice(2);
const meta = JSON.parse(readFileSync(`${dataDir}/meta.json`, "utf8"));
const buf = readFileSync(`${dataDir}/cells.bin`);
const rows = E.decode(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const ref = JSON.parse(readFileSync(refPath, "utf8"));

let failures = 0;
const close = (a, b, tol = 1e-6) =>
  (Number.isNaN(a) && (b === null || Number.isNaN(b))) ||
  Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function check(name, a, b, tol) {
  if (!close(a, b, tol)) { failures++; if (failures < 25) console.log(`FAIL ${name}: js=${a} py=${b}`); }
}

for (const c of ref.cases) {
  const r = E.analyse(meta, rows, c.opts);
  const label = JSON.stringify(c.opts);
  // monthly counts
  const jsMonths = new Map(r.months.map((m) => [`${m.year}-${m.month}`, m]));
  for (const m of c.monthly) {
    const j = jsMonths.get(m.key);
    if (!j) { failures++; console.log(`FAIL missing month ${m.key}`); continue; }
    check(`${label} MODIS ${m.key}`, j.MODIS, m.MODIS);
    check(`${label} VIIRS ${m.key}`, j.VIIRS, m.VIIRS);
  }
  for (let i = 1; i <= 12; i++) check(`${label} k${i}`, r.k[i], c.k[i - 1]);
  // calendar
  const cal = E.calendar(r.hMonths);
  cal.years.forEach((y, yi) => cal.values[yi].forEach((v, mi) =>
    check(`${label} cal ${y}-${mi + 1}`, v, c.calendar[`${y}`]?.[mi] ?? NaN, 1e-9)));
  // month to date
  for (const { year, value } of r.mtd.years) check(`${label} mtd ${year}`, value, c.mtd[`${year}`]);
  check(`${label} mtd count`, r.mtd.years.length, Object.keys(c.mtd).length);
  // validation
  for (const [m, s] of Object.entries(c.summary)) {
    check(`${label} wape ${m}`, r.validation.summary[m].wape, s.wape);
    check(`${label} bias ${m}`, r.validation.summary[m].bias, s.bias);
  }
  for (const [name, v] of Object.entries(c.steps)) check(`${label} step ${name}`, r.steps[name], v);
}
console.log(failures ? `${failures} mismatches` : `OK: ${ref.cases.length} cases match`);
process.exit(failures ? 1 : 0);
