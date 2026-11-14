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
  10 minutes, so a 20-year download takes at least about 30 minutes.
  Six requests run at once so the limit, not server latency, sets the
  pace. The script pauses automatically when the limit is close. The
  limit belongs to the MAP_KEY, so run one download at a time.
- Every chunk is cached in raw/api_cache/. If the script stops, run it
  again and it continues where it left off.
- Order: MODIS, then VIIRS S-NPP, then VIIRS NOAA-20 (from 2026 only by
  default, since the app uses it only after S-NPP ended in November 2026).
"""
import argparse
import csv
import datetime as dt
import http.client
import io
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE = "https://firms.modaps.eosdis.nasa.gov"
# (family, SP product, NRT product, first date the family has data)
FAMILIES = [
    ("MODIS", "MODIS_SP", "MODIS_NRT", "2000-11-01"),
    ("VIIRS_SNPP", "VIIRS_SNPP_SP", "VIIRS_SNPP_NRT", "2012-01-20"),
    ("VIIRS_NOAA20", "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT", "2018-04-01"),
]
PUNJAB_HARYANA = "73.8,27.6,77.6,32.6"          # west,south,east,north
LIMIT, SAFETY = 5000, 600                        # transactions per 10 minutes


WAITS = (15, 30, 60, 120, 180, 300, 300)              # about 17 minutes in all
_said, _said_lock = {}, threading.Lock()


def say_once(text, every=60):
    """Print a message once per minute, not once per worker."""
    with _said_lock:
        if time.time() - _said.get(text, 0) > every:
            _said[text] = time.time()
            print(text)


def get(url, retries=len(WAITS) + 1):
    """GET with retries. Connection resets, timeouts and busy-server replies
    are common on long runs; they are retried with a growing pause. A reply
    saying the MAP_KEY limit was reached raises LimitReached instead."""
    req = urllib.request.Request(
        url, headers={"User-Agent": "burning-activity-calendar/1.0 (Space Apps 2026)"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            try:
                body = err.read().decode("utf-8", "replace")[:300].lower()
            except Exception:
                body = ""
            if err.code == 429 or "transaction" in body or "limit" in body:
                raise LimitReached(f"HTTP {err.code}") from None
            if err.code in (400, 401, 403) and "key" in body:
                raise KeyRejected(err.code, body) from None
            what = f"HTTP {err.code}"
        except (OSError, http.client.HTTPException) as err:
            # OSError covers URLError, timeouts and connection resets;
            # HTTPException covers incomplete or malformed replies.
            what = type(err).__name__
        if attempt == retries - 1:
            raise NetworkError(f"FIRMS kept failing ({what})")
        wait = WAITS[min(attempt, len(WAITS) - 1)]
        say_once(f"  FIRMS busy or unreachable ({what}); retrying in {wait}s "
                 f"(try {attempt + 1}/{retries - 1}, normal, leave it running)")
        time.sleep(wait)


class NetworkError(Exception):
    pass


class LimitReached(Exception):
    pass


class KeyRejected(Exception):
    """FIRMS refused the MAP_KEY. Right after heavy use this can be a
    temporary block, so a key that already worked is retried."""
    def __init__(self, code, body):
        super().__init__(f"HTTP {code}")
        self.code, self.body = code, body


class Budget:
    """Keep under the MAP_KEY transaction limit. Safe to share between threads:
    while one thread pauses for the limit, the others wait too."""

    def __init__(self, key):
        self.key, self.window_start, self.gen = key, time.time(), 0
        self.worked, self.rejected = False, 0      # for KeyRejected
        self.lock = threading.Lock()
        # Count what this MAP_KEY has already used in the last 10 minutes:
        # an earlier run, or another window downloading with the same key.
        server = self.server_count()
        self.used = self.synced = server or 0
        if server:
            print(f"This MAP_KEY already used {server:,} of its {LIMIT:,} transactions "
                  "in the last 10 minutes (an earlier or parallel run); counting those.")

    def server_count(self):
        try:
            s = json.loads(get(f"{BASE}/mapserver/mapkey_status/?MAP_KEY={self.key}",
                               retries=2))
            return int(s.get("current_transactions", 0))
        except Exception:
            return None

    def spend(self, n):
        with self.lock:
            if time.time() - self.window_start > 600:
                self.used = self.synced = 0
                self.window_start = time.time()
            # FIRMS can count more than one transaction per day of data, and other
            # runs may share the key: check its own count every 200
            if self.used - self.synced >= 200:
                server = self.server_count()
                if server is not None:
                    self.used = max(self.used, server)
                self.synced = self.used
            if self.used + n > LIMIT - SAFETY:
                server = self.server_count()
                if server is None or server + n > LIMIT - SAFETY:
                    wait = max(30, 600 - (time.time() - self.window_start) + 5)
                    print(f"  10-minute limit reached; pausing {wait / 60:.1f} min "
                          "(normal, leave it running)")
                    time.sleep(wait)
                    self.gen += 1
                self.used = self.synced = 0
                self.window_start = time.time()
            self.used += n

    def pause_full_window(self, seen_gen, say=True):
        """Wait out the 10-minute window once, however many workers hit it."""
        with self.lock:
            if self.gen != seen_gen:            # another worker already waited
                return
            if say:
                print("  FIRMS says the 10-minute limit was reached; pausing 10 min "
                      "(normal, leave it running)")
            time.sleep(605)
            self.used = self.synced = 0
            self.window_start, self.gen = time.time(), self.gen + 1


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


def plan(start, end, avail, family_start=None):
    """List of (family, product, first_day, last_day) to download."""
    jobs = []
    family_start = family_start or {}
    for fam, sp, nrt, first in FAMILIES:
        lo = max(start, dt.date.fromisoformat(first),
                 family_start.get(fam, dt.date.min))
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


class FirmsError(Exception):
    pass


def chunks(lo, hi, step):
    """(first_day, n_days) pieces; boundaries stay the same between runs so
    cached files are reused."""
    day = lo
    while day <= hi:
        n = min(step, (hi - day).days + 1)
        yield day, n
        day += dt.timedelta(days=n)


def fetch_one(product, day, n, key, bbox, out, budget):
    while True:
        gen = budget.gen
        budget.spend(n)
        try:
            text = get(f"{BASE}/api/area/csv/{key}/{product}/{bbox}/{n}/{day}")
        except LimitReached:
            budget.pause_full_window(gen)
            continue
        except KeyRejected as err:
            said = " ".join(err.body.replace(key.lower(), "<key>").split())[:160]
            with budget.lock:
                budget.rejected += 1
                tries = budget.rejected
            if not budget.worked or tries > 4:
                raise FirmsError(f"FIRMS rejected the MAP_KEY ({err}): \"{said}\". "
                                 "Check FIRMS_MAP_KEY; if it worked before, wait 15 minutes "
                                 "and run the same command again.") from None
            say_once(f"  FIRMS refused the key for now ({err}: \"{said}\"); "
                     "this can happen after heavy use. Pausing 10 min, then trying again.", every=300)
            budget.pause_full_window(gen, say=False)
            continue
        budget.worked, budget.rejected = True, 0
        first_line = text.lstrip().split("\n", 1)[0].lower()
        if not text.strip() or first_line.startswith("latitude"):
            tmp = out.with_suffix(".part")
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(out)                 # never leave half-written files
            return n
        msg = text.strip()[:200]
        if "transaction" in msg.lower() or "limit" in msg.lower():
            budget.pause_full_window(gen)
            continue
        raise FirmsError(f"FIRMS returned an error for {product} {day}: {msg}")


def fetch(job, key, bbox, step, cache, budget, workers):
    fam, product, lo, hi = job
    folder = cache / product
    folder.mkdir(parents=True, exist_ok=True)
    todo = [(d, n, folder / f"{d}_{n}.csv") for d, n in chunks(lo, hi, step)]
    days = (hi - lo).days + 1
    # a chunk ending in the last 3 days may have been saved before all its data
    # arrived, so it is fetched again
    fresh = dt.date.today() - dt.timedelta(days=3)
    left = [t for t in todo if not t[2].exists() or t[0] + dt.timedelta(days=t[1] - 1) >= fresh]
    left_days = sum(n for _, n, _ in left)
    print(f"{product}: {lo} to {hi} ({days:,} days, "
          f"{days - left_days:,} already saved)")
    if not left:
        return
    done, t0, next_report = 0, time.time(), 250
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(fetch_one, product, d, n, key, bbox, out, budget)
                   for d, n, out in left]
        try:
            for f in as_completed(futures):
                done += f.result()
                if done >= next_report or done == left_days:
                    rate = done / max(time.time() - t0, 1)
                    eta = (left_days - done) / rate / 60
                    print(f"  {done:,}/{left_days:,} days  "
                          f"(~{eta:.0f} min left for {product})")
                    next_report += 250
        except KeyboardInterrupt:
            # workers may be sleeping through a 10-minute pause; do not wait for them
            print("\nStopped by you. Everything downloaded so far is saved; "
                  "run the same command again to continue.", flush=True)
            os._exit(130)
        except BaseException:
            for f in futures:
                f.cancel()
            raise


def combine(product, cache, raw):
    files = sorted((cache / product).glob("*.csv"))
    if not files:
        return 0
    header, rows = None, 0
    # write next to it and swap in at the end, so prepare.py or build_site.py
    # running at the same time never reads a half-written file
    final, part = raw / f"FIRMS_{product}.csv", raw / f"FIRMS_{product}.csv.part"
    with open(part, "w", newline="", encoding="utf-8") as f:
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
    part.replace(final)
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bbox", default=PUNJAB_HARYANA,
                   help="west,south,east,north (default: Punjab & Haryana)")
    p.add_argument("--start", default="2001-01-01")
    p.add_argument("--end", default=dt.date.today().isoformat())
    p.add_argument("--families", default="MODIS,VIIRS_SNPP,VIIRS_NOAA20",
                   help="comma list of MODIS, VIIRS_SNPP, VIIRS_NOAA20")
    p.add_argument("--noaa20-start", default="2026-01-01",
                   help="NOAA-20 is only needed after S-NPP ended (Nov 2026); "
                        "the default keeps a 10-month overlap. Use 2018-04-01 "
                        "for its full record (about 3,000 more transactions).")
    p.add_argument("--step", type=int, default=5, help="days per request (max 5-10)")
    p.add_argument("--workers", type=int, default=6,
                   help="requests at the same time (default 6)")
    p.add_argument("--raw", default="raw")
    p.add_argument("--region", help="a study area from regions.json (slug), or 'all'; "
                                    "sets --bbox, --start and --raw for you")
    p.add_argument("--key", default=os.environ.get("FIRMS_MAP_KEY"))
    a = p.parse_args()
    if not a.key:
        sys.exit("Set FIRMS_MAP_KEY (see the top of this file).")
    a.key = a.key.strip()
    if a.region:
        import copy
        import regions
        for r in regions.pick(a.region):
            print(f"===== {r['name']} =====")
            b = copy.copy(a)
            b.bbox, b.start, b.raw = r["bbox"], r["start"], regions.raw_dir(r)
            download(b)
        print("Done. Next: python prepare.py --region all")
        return
    download(a)
    print('Done. Next: python prepare.py "raw/*.csv"')


def download(a):
    w, s, e, n = (float(x) for x in a.bbox.split(","))
    if not (w < e and s < n):
        sys.exit("bbox must be west,south,east,north with west<east, south<north")

    raw = Path(a.raw)
    cache = raw / "api_cache"
    start, end = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    wanted = {f.strip() for f in a.families.split(",")}
    fam_start = {"VIIRS_NOAA20": dt.date.fromisoformat(a.noaa20_start)}
    jobs = [j for j in plan(start, end, availability(a.key), fam_start)
            if j[0] in wanted]
    fresh = dt.date.today() - dt.timedelta(days=3)
    left = sum(n for _, product, lo, hi in jobs for d, n in chunks(lo, hi, a.step)
               if not (cache / product / f"{d}_{n}.csv").exists() or d + dt.timedelta(days=n - 1) >= fresh)
    print(f"{left:,} days of data left to download, at least "
          f"{left / (LIMIT - SAFETY) * 10:.0f} minutes because of the FIRMS limit. "
          "Safe to stop and re-run; finished chunks are kept.\n")

    budget = Budget(a.key)
    for job in jobs:
        try:
            fetch(job, a.key, a.bbox, a.step, cache, budget, a.workers)
        except (NetworkError, FirmsError) as err:
            combine(job[1], cache, raw)
            sys.exit(f"\nStopped: {err}\nEverything downloaded so far is saved. "
                     "Wait a minute, then run the same command again to continue.")
        rows = combine(job[1], cache, raw)
        print(f"  wrote {raw / f'FIRMS_{job[1]}.csv'} ({rows:,} detections)\n")


if __name__ == "__main__":
    main()
