"""
Download MODIS and VIIRS hotspots for one area from the NASA FIRMS API.

AI disclosure: drafted with Claude (Anthropic); review before use.

You need a free FIRMS MAP_KEY: https://firms.modaps.eosdis.nasa.gov/api/map_key/
Keep it out of the repository. Set it as an environment variable:

    Windows (PowerShell):  $env:FIRMS_MAP_KEY = "your key"
    macOS / Linux:         export FIRMS_MAP_KEY="your key"

Then:

    python fetch_firms.py                         # Punjab & Haryana, 2001 to today
    python fetch_firms.py --bbox 73.8,27.6,77.6,32.6 --start 2003-01-01
    python prepare.py "raw/*.csv"

How it works
- Uses standard-processing (SP) data where it exists and near-real-time
  (NRT) data after that, based on FIRMS's own data-availability list.
- Each day counts as one API transaction, with a limit of 5,000 per
  10 minutes, so a 20-year download takes roughly 30-45 minutes.
  The script waits automatically when the limit is close.
- Every chunk is cached in raw/api_cache/. If the script stops, run it
  again and it continues where it left off.
- Order: MODIS, then VIIRS S-NPP, then VIIRS NOAA-20. You can run
  prepare.py and start the app as soon as the first two finish.
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://firms.modaps.eosdis.nasa.gov"
# (family, SP product, NRT product, first date the family has data)
FAMILIES = [
    ("MODIS", "MODIS_SP", "MODIS_NRT", "2000-11-01"),
    ("VIIRS_SNPP", "VIIRS_SNPP_SP", "VIIRS_SNPP_NRT", "2012-01-20"),
    ("VIIRS_NOAA20", "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT", "2018-04-01"),
]
PUNJAB_HARYANA = "73.8,27.6,77.6,32.6"          # west,south,east,north
LIMIT, SAFETY = 5000, 300                        # transactions per 10 minutes


def get(url, retries=4):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt == retries - 1:
                raise
            wait = 10 * (attempt + 1)
            print(f"  network error ({err}); retrying in {wait}s")
            time.sleep(wait)


class Budget:
    """Keep under the MAP_KEY transaction limit."""

    def __init__(self, key):
        self.key, self.used, self.window_start = key, 0, time.time()

    def server_count(self):
        try:
            s = json.loads(get(f"{BASE}/mapserver/mapkey_status/?MAP_KEY={self.key}"))
            return int(s.get("current_transactions", 0))
        except Exception:
            return None

    def spend(self, n):
        if time.time() - self.window_start > 600:
            self.used, self.window_start = 0, time.time()
        if self.used + n > LIMIT - SAFETY:
            server = self.server_count()
            if server is None or server + n > LIMIT - SAFETY:
                wait = max(30, 600 - (time.time() - self.window_start) + 5)
                print(f"  near the 10-minute limit; pausing {wait / 60:.1f} min")
                time.sleep(wait)
            self.used, self.window_start = 0, time.time()
        self.used += n


def availability(key):
    """{product: (min_date, max_date)} from FIRMS, or {} if unavailable."""
    try:
        text = get(f"{BASE}/api/data_availability/csv/{key}/ALL")
        rows = csv.DictReader(io.StringIO(text))
        return {r["data_id"]: (dt.date.fromisoformat(r["min_date"]),
                               dt.date.fromisoformat(r["max_date"]))
                for r in rows if r.get("data_id")}
    except Exception as err:
        print(f"Could not read data availability ({err}); using defaults.")
        return {}


def plan(start, end, avail):
    """List of (family, product, first_day, last_day) to download."""
    jobs = []
    for fam, sp, nrt, first in FAMILIES:
        lo = max(start, dt.date.fromisoformat(first))
        sp_range = avail.get(sp)
        if sp_range:
            lo = max(lo, sp_range[0])
            sp_hi = min(end, sp_range[1])
        else:                       # unknown: assume SP lags ~5 months
            sp_hi = min(end, dt.date.today() - dt.timedelta(days=150))
        if lo <= sp_hi:
            jobs.append((fam, sp, lo, sp_hi))
        nrt_lo = max(lo, sp_hi + dt.timedelta(days=1))
        nrt_range = avail.get(nrt)
        nrt_hi = min(end, nrt_range[1]) if nrt_range else end
        if nrt_lo <= nrt_hi:
            jobs.append((fam, nrt, nrt_lo, nrt_hi))
    return jobs


def fetch(job, key, bbox, step, cache, budget):
    fam, product, lo, hi = job
    folder = cache / product
    folder.mkdir(parents=True, exist_ok=True)
    days = (hi - lo).days + 1
    print(f"{product}: {lo} to {hi} ({days:,} days)")
    day, done = lo, 0
    while day <= hi:
        n = min(step, (hi - day).days + 1)
        out = folder / f"{day}_{n}.csv"
        if not out.exists():
            budget.spend(n)
            url = f"{BASE}/api/area/csv/{key}/{product}/{bbox}/{n}/{day}"
            text = get(url)
            first_line = text.lstrip().split("\n", 1)[0].lower()
            if text.strip() and not first_line.startswith("latitude"):
                msg = text.strip()[:200]
                if "transaction" in msg.lower() or "limit" in msg.lower():
                    print("  FIRMS says the limit was reached; pausing 10 min")
                    time.sleep(605)
                    budget.used, budget.window_start = 0, time.time()
                    continue
                sys.exit(f"FIRMS returned an error for {product} {day}: {msg}")
            out.write_text(text, encoding="utf-8")
        done += n
        day += dt.timedelta(days=n)
        if done % (step * 60) < step or day > hi:
            print(f"  {done:,}/{days:,} days")


def combine(product, cache, raw):
    files = sorted((cache / product).glob("*.csv"))
    if not files:
        return 0
    header, rows = None, 0
    with open(raw / f"FIRMS_{product}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        for path in files:
            r = csv.reader(io.StringIO(path.read_text(encoding="utf-8")))
            h = next(r, None)
            if not h:
                continue
            if header is None:
                header = h
                w.writerow(header)
            elif h != header:
                sys.exit(f"Column mismatch in {path}")
            for row in r:
                if row:
                    w.writerow(row)
                    rows += 1
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bbox", default=PUNJAB_HARYANA,
                   help="west,south,east,north (default: Punjab & Haryana)")
    p.add_argument("--start", default="2001-01-01")
    p.add_argument("--end", default=dt.date.today().isoformat())
    p.add_argument("--families", default="MODIS,VIIRS_SNPP,VIIRS_NOAA20",
                   help="comma list; drop VIIRS_NOAA20 to save ~3,000 transactions")
    p.add_argument("--step", type=int, default=5, help="days per request (max 5-10)")
    p.add_argument("--raw", default="raw")
    p.add_argument("--key", default=os.environ.get("FIRMS_MAP_KEY"))
    a = p.parse_args()
    if not a.key:
        sys.exit("Set FIRMS_MAP_KEY (see the top of this file).")
    w, s, e, n = (float(x) for x in a.bbox.split(","))
    if not (w < e and s < n):
        sys.exit("bbox must be west,south,east,north with west<east, south<north")

    raw = Path(a.raw)
    cache = raw / "api_cache"
    start, end = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    wanted = {f.strip() for f in a.families.split(",")}
    jobs = [j for j in plan(start, end, availability(a.key)) if j[0] in wanted]
    total = sum((hi - lo).days + 1 for _, _, lo, hi in jobs)
    print(f"About {total:,} transactions, roughly {total / (LIMIT - SAFETY) * 10:.0f}+ "
          "minutes. Safe to stop and re-run; finished chunks are kept.\n")

    budget = Budget(a.key)
    for job in jobs:
        fetch(job, a.key, a.bbox, a.step, cache, budget)
        rows = combine(job[1], cache, raw)
        print(f"  wrote {raw / f'FIRMS_{job[1]}.csv'} ({rows:,} detections)\n")
    print('Done. Next: python prepare.py "raw/*.csv"')


if __name__ == "__main__":
    main()
