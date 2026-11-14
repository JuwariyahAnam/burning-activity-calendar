"""
Export prepared fire data for the website in docs/.

AI disclosure: drafted with Claude (Anthropic); review before use.

Usage
    python build_site.py                       # data/cell_days.csv.gz -> docs/data/
    python build_site.py --region "Punjab & Haryana, India" --bbox 73.8,27.6,77.6,32.6

Writes
    docs/data/meta.json  region, grid cells, coverage dates, sizes
    docs/data/cells.bin  one record per (grid cell, local day) with fire:
                         uint16 day | uint16 cell | uint8 satellite flags
"""
import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

import boundaries
import harmonize as hz

DATE0 = pd.Timestamp("2000-01-01")
FLAGS = {"Terra": 1, "Aqua": 2, "SNPP": 4, "NOAA20": 8}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data", default="data/cell_days.csv.gz")
    p.add_argument("--out", default="docs/data")
    p.add_argument("--region", default="Punjab & Haryana, India")
    p.add_argument("--bbox", default="73.8,27.6,77.6,32.6",
                   help="default area shown first: west,south,east,north")
    p.add_argument("--cell", type=float, default=0.1,
                   help="grid size used by prepare.py, degrees")
    p.add_argument("--sample", action="store_true",
                   help="mark the export as synthetic test data")
    p.add_argument("--states", default="Punjab,Haryana",
                   help="states the site selects by default (comma list)")
    p.add_argument("--no-districts", action="store_true",
                   help="skip downloading state and district boundaries")
    p.add_argument("--adm1", help="local geoBoundaries IND ADM1 GeoJSON (optional)")
    p.add_argument("--adm2", help="local geoBoundaries IND ADM2 GeoJSON (optional)")
    a = p.parse_args()

    cd = pd.read_csv(a.data, parse_dates=["local_date"])
    cd = cd[cd["satellite"].isin(FLAGS)]
    cov = hz.coverage(cd)
    snpp = cd.loc[cd["satellite"] == "SNPP", "local_date"]

    cells = (cd[["cell_lat", "cell_lon"]].drop_duplicates()
             .sort_values(["cell_lat", "cell_lon"]).reset_index(drop=True))
    if len(cells) > 65535:
        raise SystemExit("Too many grid cells for the site; use a smaller area.")
    cell_id = {(la, lo): i for i, (la, lo) in enumerate(cells.itertuples(index=False))}

    cd["flag"] = cd["satellite"].map(FLAGS).astype(np.uint8)
    rows = (cd.groupby(["local_date", "cell_lat", "cell_lon"])["flag"]
              .agg(lambda f: np.bitwise_or.reduce(f.to_numpy())).reset_index())
    day = (rows["local_date"] - DATE0).dt.days.to_numpy()
    if day.min() < 0 or day.max() > 65535:
        raise SystemExit("Dates out of range for the site format.")
    cell = np.array([cell_id[(la, lo)] for la, lo in
                     zip(rows["cell_lat"], rows["cell_lon"])], dtype=np.uint16)
    order = np.lexsort((cell, day))
    day, cell = day[order].astype(np.uint16), cell[order]
    flags = rows["flag"].to_numpy(np.uint8)[order]

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "cells.bin", "wb") as f:
        f.write(day.astype("<u2").tobytes())
        f.write(cell.astype("<u2").tobytes())
        f.write(flags.tobytes())

    w, s, e, n = (float(x) for x in a.bbox.split(","))
    meta = {
        "region": a.region,
        "bbox": [s, w, n, e],
        "extent": [float(cells.cell_lat.min()), float(cells.cell_lon.min()),
                   float(cells.cell_lat.max()), float(cells.cell_lon.max())],
        "cellDeg": a.cell,
        "date0": DATE0.strftime("%Y-%m-%d"),
        "coverage": {k: [int((v[0] - DATE0).days), int((v[1] - DATE0).days)]
                     for k, v in cov.items()},
        "snppEnd": None if snpp.empty else int((snpp.max() - DATE0).days),
        "rows": int(len(day)),
        "cells": [[round(float(la), 4), round(float(lo), 4)]
                  for la, lo in cells.itertuples(index=False)],
        "generated": dt.date.today().isoformat(),
        "sample": bool(a.sample),
    }
    (out / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    dist_file = out / "districts.json"
    if not a.no_districts:
        bnd = boundaries.build(meta["cells"], meta["extent"],
                               [x.strip() for x in a.states.split(",")], a.adm1, a.adm2)
        if bnd:
            dist_file.write_text(json.dumps(bnd, separators=(",", ":")))
            print(f"  wrote {dist_file} ({dist_file.stat().st_size / 1e6:.1f} MB)")
    elif dist_file.exists():
        dist_file.unlink()
    size = (out / "cells.bin").stat().st_size / 1e6
    print(f"{len(day):,} cell-days, {len(cells):,} grid cells, "
          f"cells.bin {size:.1f} MB -> {out}")
    for k, (lo, hi) in cov.items():
        print(f"  {k}: {lo.date()} to {hi.date()}")


if __name__ == "__main__":
    main()
