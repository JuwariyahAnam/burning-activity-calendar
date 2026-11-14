"""
Turn raw FIRMS CSV downloads into one small file the app can load.

AI disclosure: drafted with Claude (Anthropic); review before use.

Usage
    python prepare.py raw/*.csv
    python prepare.py raw/*.csv --cell 0.1 --tz 5.5 --out data/cell_days.csv.gz

Put every MODIS and VIIRS CSV for your region in raw/ (archive downloads
and recent API pulls together). The output has one row per satellite,
grid cell and local day, and is small enough to commit to GitHub.
"""
import argparse
import glob
from pathlib import Path

import pandas as pd

import harmonize as hz


def main():
    p = argparse.ArgumentParser()
    p.add_argument("files", nargs="+", help="FIRMS CSV files (globs allowed)")
    p.add_argument("--out", default="data/cell_days.csv.gz")
    p.add_argument("--cell", type=float, default=0.1, help="grid size, degrees")
    p.add_argument("--tz", type=float, default=5.5, help="hours ahead of UTC")
    p.add_argument("--modis-min-conf", type=int, default=30)
    p.add_argument("--keep-low-viirs", action="store_true",
                   help="also keep VIIRS low-confidence detections")
    a = p.parse_args()

    paths = sorted({f for pat in a.files for f in glob.glob(pat)})
    if not paths:
        raise SystemExit("No input files found.")
    keep = ("l", "n", "h") if a.keep_low_viirs else ("n", "h")
    parts = []
    for path in paths:
        raw = hz.read_firms_csv(path)
        c = hz.clean(raw, a.modis_min_conf, keep, a.tz)
        parts.append(hz.to_cell_days(c, a.cell))
        print(f"{path}: {len(raw):,} detections -> {len(c):,} kept")
    cd = pd.concat(parts)
    keys = ["instrument", "satellite", "cell_lat", "cell_lon", "local_date"]
    cd = cd.groupby(keys, as_index=False).sum()

    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    cd.to_csv(a.out, index=False)
    for inst, (lo, hi) in hz.coverage(cd).items():
        print(f"{inst}: {lo.date()} to {hi.date()}")
    print(f"Wrote {len(cd):,} cell-days to {a.out}")


if __name__ == "__main__":
    main()
