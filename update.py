"""
Keep the site current: download the latest near-real-time FIRMS data for
each study area, merge it into the area's cell-day file and rebuild the
website data.

AI disclosure: drafted with Claude (Anthropic); review before use.

    python update.py                       # every study area, last 21 days
    python update.py --region uttarakhand --days 45

Run it once a day: by hand, with Windows Task Scheduler or cron, or with the
GitHub workflow in .github/workflows/update.yml. It needs FIRMS_MAP_KEY like
fetch_firms.py. A daily run costs about 50 FIRMS transactions per area.

How it works
- Downloads from 3 days before the end of the area's cell-day file (or the
  last --days days, whichever is earlier) up to today.
- Replaces those days in data/<area>/cell_days.csv.gz, instrument by
  instrument. If FIRMS returns nothing for an instrument, its existing days
  are kept, so an outage never deletes data.
- Saves the new detections next to the area's raw files as
  FIRMS_<product>_recent.csv (when that folder exists), so the close-up maps
  include them. Without the raw archive (on a server) the existing close-up
  file is reused.
- Every few months, when NASA publishes science-quality data for more
  months, re-run fetch_firms.py and prepare.py for the full record.
"""
import argparse
import datetime as dt
import glob
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd

import fetch_firms as ff
import harmonize as hz
import regions

MAX_DAYS = 150                      # never refresh more than this in one run


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--region", default="all", help="a study area slug from regions.json, or 'all'")
    p.add_argument("--days", type=int, default=21, help="days to refresh at least (default 21)")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--tz", type=float, default=5.5)
    p.add_argument("--cell", type=float, default=0.1)
    p.add_argument("--no-build", action="store_true", help="only update the cell-day files")
    p.add_argument("--key", default=os.environ.get("FIRMS_MAP_KEY"))
    a = p.parse_args()
    if not a.key:
        sys.exit("Set FIRMS_MAP_KEY (see fetch_firms.py).")
    failed = []
    for r in regions.pick(a.region):
        print(f"===== {r['name']} =====")
        try:
            if update_region(r, a) and not a.no_build:
                build_region(r)
        except SystemExit as err:        # one area failing must not stop the others
            print(f"  skipped: {err}")
            failed.append(r["name"])
    if failed:
        print(f"Not updated: {', '.join(failed)}")
        sys.exit(1)
    print("Done.")


def update_region(r, a):
    data = Path(r["data"])
    if not data.exists():
        print(f"  no {data} yet; run fetch_firms.py and prepare.py for this area first")
        return False
    old = pd.read_csv(data, parse_dates=["local_date"])
    today = dt.date.today()
    last = old["local_date"].max().date()
    start = min(today - dt.timedelta(days=a.days), last - dt.timedelta(days=3))
    if (today - start).days > MAX_DAYS:
        print(f"  the data ends {last}; refreshing only the last {MAX_DAYS} days. "
              "Run fetch_firms.py and prepare.py for the full gap.")
        start = today - dt.timedelta(days=MAX_DAYS)
    print(f"  data ends {last}; refreshing {start} to {today}")

    with tempfile.TemporaryDirectory() as tmp:
        f = argparse.Namespace(bbox=r["bbox"], start=start.isoformat(), end=today.isoformat(),
                               families="MODIS,VIIRS_SNPP,VIIRS_NOAA20", noaa20_start=start.isoformat(),
                               step=5, workers=a.workers, raw=tmp, key=a.key.strip())
        ff.download(f)
        files = sorted(glob.glob(os.path.join(tmp, "FIRMS_*.csv")))
        parts = [hz.clean(hz.read_firms_csv(x), tz_hours=a.tz) for x in files]
        raw_dir = Path(regions.raw_dir(r))
        if raw_dir.is_dir():                     # for the close-up maps
            for x in files:
                shutil.copy(x, raw_dir / Path(x).name.replace(".csv", "_recent.csv"))

    det = pd.concat(parts) if parts else pd.DataFrame()
    if det.empty:
        print("  FIRMS returned no detections for these days; nothing changed")
        return True
    det = det.drop_duplicates(["satellite", "latitude", "longitude", "local_date", "frp"])
    new = hz.to_cell_days(det, a.cell)
    cut = pd.Timestamp(start + dt.timedelta(days=1))     # first full local day downloaded
    keep = []
    for inst in sorted(set(old["instrument"]) | set(new["instrument"])):
        o = old[old["instrument"] == inst]
        n = new[(new["instrument"] == inst) & (new["local_date"] >= cut)]
        if n.empty:
            print(f"  no new {inst} data; kept the existing days")
            keep.append(o)
            continue
        keep += [o[o["local_date"] < cut], n]
        print(f"  {inst}: {len(n):,} cell-days from {n['local_date'].min().date()} "
              f"to {n['local_date'].max().date()}")
    merged = (pd.concat(keep)[list(old.columns)]
                .sort_values(["local_date", "instrument", "satellite", "cell_lat", "cell_lon"]))
    merged.to_csv(data, index=False)
    print(f"  wrote {data} ({len(merged):,} cell-days, to {merged['local_date'].max().date()})")
    return True


def build_region(r):
    raw_dir = Path(regions.raw_dir(r))
    has_archive = any(raw_dir.glob("FIRMS_*_SP.csv")) if raw_dir.is_dir() else False
    cmd = [sys.executable, "build_site.py", "--region", r["slug"]]
    if not has_archive:
        cmd.append("--keep-hotspots")
    if subprocess.run(cmd).returncode:
        raise SystemExit("build_site.py failed")


if __name__ == "__main__":
    main()
