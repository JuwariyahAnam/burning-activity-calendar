"""
Export prepared fire data for the website in docs/.

AI disclosure: drafted with Claude (Anthropic); review before use.

Usage
    python build_site.py --region all            # every study area in regions.json
    python build_site.py --region madhya-pradesh # one study area
    python build_site.py                         # legacy: one area -> docs/data/

Writes, per study area, to docs/data/<slug>/
    meta.json       area, grid cells, coverage dates, sizes
    cells.bin       one record per (grid cell, local day) with fire:
                    uint16 day | uint16 cell | uint8 satellite flags
    districts.json  state and district boundaries (geoBoundaries)
    hotspots.bin    fire spots with intensity for the close-up maps
and docs/data/regions.json, the list of areas the site offers.
"""
import argparse
import copy
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

import alerts
import boundaries
import harmonize as hz

DATE0 = pd.Timestamp("2000-01-01")
FLAGS = {"Terra": 1, "Aqua": 2, "SNPP": 4, "NOAA20": 8}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--region", help="a study area from regions.json (slug), or 'all'")
    p.add_argument("--data", default="data/cell_days.csv.gz")
    p.add_argument("--out", default="docs/data")
    p.add_argument("--name", default="Punjab & Haryana, India", help="area name (legacy mode)")
    p.add_argument("--bbox", default="73.8,27.6,77.6,32.6",
                   help="default area shown first: west,south,east,north")
    p.add_argument("--cell", type=float, default=0.1,
                   help="grid size used by prepare.py, degrees")
    p.add_argument("--sample", action="store_true",
                   help="mark the export as synthetic test data")
    p.add_argument("--states", default="Punjab,Haryana",
                   help="states the site selects by default (comma list, legacy mode)")
    p.add_argument("--no-districts", action="store_true",
                   help="skip downloading state and district boundaries")
    p.add_argument("--adm1", help="local geoBoundaries IND ADM1 GeoJSON (optional)")
    p.add_argument("--adm2", help="local geoBoundaries IND ADM2 GeoJSON (optional)")
    p.add_argument("--raw", default="raw/*.csv",
                   help="raw FIRMS CSVs for the close-up maps (fire locations "
                        "and intensity); skipped if none are found")
    p.add_argument("--fine", type=float, default=0.02,
                   help="close-up map spot size in degrees (must divide --cell)")
    p.add_argument("--tz", type=float, default=5.5, help="hours ahead of UTC, as prepare.py")
    p.add_argument("--keep-hotspots", action="store_true",
                   help="reuse the existing close-up file when the raw downloads are not "
                        "available (used by update.py on a server)")
    a = p.parse_args()
    a.state_aliases = [[x.strip()] for x in a.states.split(",")]
    a.clip = None

    if not a.region:
        build(a)
        return
    import regions
    root = Path(a.out)
    for r in regions.pick(a.region):
        print(f"===== {r['name']} =====")
        if not Path(r["data"]).exists():
            print(f"  no {r['data']} yet; skipped (run prepare.py --region {r['slug']})")
            continue
        b = copy.copy(a)
        b.data, b.raw, b.out = r["data"], r["raw"], str(root / r["slug"])
        b.name, b.bbox, b.state_aliases = r["name"], r["bbox"], r["states"]
        w, s, e, n = (float(x) for x in r["bbox"].split(","))
        b.clip = [s, w, n, e] if r.get("clip") else None
        try:
            build(b)
        except SystemExit as err:            # one bad area shouldn't stop the others
            print(f"  skipped: {err}")
    write_index(root, regions.load())


def write_index(root, all_regions):
    """docs/data/regions.json: the areas that have been built, for the site's place list."""
    items = []
    for r in all_regions:
        m = root / r["slug"] / "meta.json"
        if not m.exists():
            continue
        meta = json.loads(m.read_text())
        w, s, e, n = (float(x) for x in r["bbox"].split(","))
        first = (DATE0 + pd.Timedelta(days=min(v[0] for v in meta["coverage"].values()))).year
        items.append({"slug": r["slug"], "name": r["name"], "story": r.get("story", ""),
                      "bbox": [s, w, n, e], "center": [(s + n) / 2, (w + e) / 2],
                      "from": int(first), "sample": meta.get("sample", False)})
    (root / "regions.json").write_text(json.dumps({"regions": items}, indent=1))
    import regions as regions_mod
    built = []
    for r in all_regions:
        f = root / r["slug"] / "alerts.json"
        if f.exists():
            built.append((r, json.loads(f.read_text(encoding="utf-8"))))
    alerts.write_feed(root, built, regions_mod.site())
    for old in ["meta.json", "cells.bin", "districts.json", "hotspots.bin"]:   # single-area layout
        if (root / old).exists():
            (root / old).unlink()
    print(f"\nSite places: {', '.join(i['name'] for i in items) or 'none'} -> {root / 'regions.json'}")


def build(a):
    cd = pd.read_csv(a.data, parse_dates=["local_date"])
    cd = cd[cd["satellite"].isin(FLAGS)]
    cov = hz.coverage(cd)
    missing = {"MODIS", "VIIRS"} - set(cov)
    if missing:
        raise SystemExit(
            f"No {' or '.join(sorted(missing))} data in {a.data}. The site needs both instruments.\n"
            "Finish the download (python fetch_firms.py), then run prepare.py and build_site.py again.")
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

    n20_scale = alerts.noaa20_scale(rows, None if snpp.empty else snpp.max())
    print(f"NOAA-20 to S-NPP scale after the handover: {n20_scale}")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    old = None
    if getattr(a, "keep_hotspots", False) and (out / "meta.json").exists() and (out / "hotspots.bin").exists():
        old = (json.loads((out / "meta.json").read_text()), (out / "hotspots.bin").read_bytes())
    with open(out / "cells.bin", "wb") as f:
        f.write(day.astype("<u2").tobytes())
        f.write(cell.astype("<u2").tobytes())
        f.write(flags.tobytes())

    w, s, e, n = (float(x) for x in a.bbox.split(","))
    meta = {
        "region": a.name,
        "bbox": [s, w, n, e],
        "extent": [float(cells.cell_lat.min()), float(cells.cell_lon.min()),
                   float(cells.cell_lat.max()), float(cells.cell_lon.max())],
        "cellDeg": a.cell,
        "date0": DATE0.strftime("%Y-%m-%d"),
        "coverage": {k: [int((v[0] - DATE0).days), int((v[1] - DATE0).days)]
                     for k, v in cov.items()},
        "snppEnd": None if snpp.empty else int((snpp.max() - DATE0).days),
        "n20Scale": n20_scale,
        "rows": int(len(day)),
        "cells": [[round(float(la), 4), round(float(lo), 4)]
                  for la, lo in cells.itertuples(index=False)],
        "generated": dt.date.today().isoformat(),
        "sample": bool(a.sample),
    }
    dist_file, hot_file = out / "districts.json", out / "hotspots.bin"
    bnd = None
    if not a.no_districts:
        bnd = boundaries.build(meta["cells"], meta["extent"], a.state_aliases,
                               a.adm1, a.adm2, clip=a.clip)
        if bnd:
            dist_file.write_text(json.dumps(bnd, separators=(",", ":")))
            print(f"  wrote {dist_file} ({dist_file.stat().st_size / 1e6:.1f} MB)")
    elif dist_file.exists():
        dist_file.unlink()
    if bnd:                                  # districts burning far more than usual
        try:
            al = alerts.compute(rows, cell_id, bnd, cov, None if snpp.empty else snpp.max(),
                                n20_scale=n20_scale)
            alerts.save(out / "alerts.json", a.name, al)
            print(f"  alerts: {len(al['flagged'])} district(s) far above usual, {al['from']} to {al['to']}")
        except Exception as err:             # never block the build
            print(f"  alerts skipped: {err}")
    meta["hotspots"] = None
    if bnd and old:
        meta["hotspots"] = reuse_hotspots(old, cell_id, hot_file)
    elif bnd:
        meta["hotspots"] = export_hotspots(a, meta, cell_id, bnd["cellDistrict"], cd, hot_file)
    if meta["hotspots"] is None and hot_file.exists():
        hot_file.unlink()
    (out / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    size = (out / "cells.bin").stat().st_size / 1e6
    print(f"{len(day):,} cell-days, {len(cells):,} grid cells, "
          f"cells.bin {size:.1f} MB -> {out}")
    for k, (lo, hi) in cov.items():
        print(f"  {k}: {lo.date()} to {hi.date()}")


def reuse_hotspots(old, cell_id, path):
    """Keep the existing close-up spots, renumbered to the new grid cells."""
    old_meta, buf = old
    info = old_meta.get("hotspots")
    if not info:
        return None
    n = info["rows"]
    cols = [np.frombuffer(buf, "<u2", n, 0), np.frombuffer(buf, "<u2", n, 2 * n),
            np.frombuffer(buf, "<u2", n, 4 * n), np.frombuffer(buf, "u1", n, 6 * n),
            np.frombuffer(buf, "u1", n, 7 * n)]
    remap = np.array([cell_id.get((la, lo), -1) for la, lo in old_meta["cells"]], dtype=np.int64)
    new_cell = remap[cols[0]]
    keep = new_cell >= 0
    with open(path, "wb") as f:
        f.write(new_cell[keep].astype("<u2").tobytes())
        for c in cols[1:]:
            f.write(c[keep].tobytes())
    print(f"Close-up maps: kept {int(keep.sum()):,} existing spots (no raw downloads here).")
    return {**info, "rows": int(keep.sum())}


def export_hotspots(a, meta, cell_id, cell_district, cd, path):
    """Fire locations and intensity for the district close-up maps.

    Detections are grouped into small spots (a.fine degrees) per year, keeping
    one sensor per year so dot density is comparable within a year: MODIS before
    VIIRS began, then VIIRS S-NPP, then NOAA-20 after S-NPP ended. Each record:
    parent grid cell, spot within it, year, number of detections and mean fire
    radiative power (FRP, megawatts), the satellite measure of fire intensity.
    """
    import glob
    files = sorted(glob.glob(a.raw))
    if not files:
        print(f"Close-up maps: no raw files at {a.raw}; skipped (run fetch_firms.py first).")
        return None
    k = int(round(a.cell / a.fine))
    if abs(k * a.fine - a.cell) > 1e-9 or k > 15:
        raise SystemExit("--fine must divide --cell into at most 15 parts")
    parts = []
    for path_ in files:
        c = hz.clean(hz.read_firms_csv(path_), tz_hours=a.tz)
        parts.append(c[["instrument", "satellite", "latitude", "longitude", "local_date", "frp"]])
    det = pd.concat(parts).drop_duplicates(["satellite", "latitude", "longitude", "local_date", "frp"])
    viirs_start = cd.loc[cd["instrument"] == "VIIRS", "local_date"].min()
    snpp_end = cd.loc[cd["satellite"] == "SNPP", "local_date"].max()
    switch = viirs_start.year if pd.notna(viirs_start) else 9999
    year = det["local_date"].dt.year
    keep = ((det["instrument"] == "MODIS") & (year < switch)) | (
        (det["instrument"] == "VIIRS") & (year >= switch) & (
            (det["satellite"] == "SNPP") |
            ((det["satellite"] == "NOAA20") & (pd.isna(snpp_end) | (det["local_date"] > snpp_end)))))
    det = det[keep].copy()
    # parent grid cell (same rule as prepare.py) and the spot inside it
    clat = (np.floor(det["latitude"] / a.cell) * a.cell + a.cell / 2).round(4)
    clon = (np.floor(det["longitude"] / a.cell) * a.cell + a.cell / 2).round(4)
    ix = np.clip(((det["longitude"] - (clon - a.cell / 2)) / a.fine).astype(int), 0, k - 1)
    iy = np.clip(((det["latitude"] - (clat - a.cell / 2)) / a.fine).astype(int), 0, k - 1)
    det["cell"] = [cell_id.get((la, lo), -1) for la, lo in zip(clat, clon)]
    det["sub"] = (iy * k + ix).astype(int)
    det["year"] = det["local_date"].dt.year
    det = det[det["cell"] >= 0]
    det = det[np.asarray(cell_district)[det["cell"].to_numpy()] >= 0]   # inside a district
    if det.empty:
        print("Close-up maps: no detections inside districts; skipped.")
        return None
    g = (det.groupby(["cell", "sub", "year"])
           .agg(n=("frp", "size"), frp=("frp", "mean")).reset_index())
    year0 = int(g["year"].min())
    with open(path, "wb") as f:
        f.write(g["cell"].to_numpy("<u2").tobytes())
        f.write(np.minimum(g["n"], 65535).to_numpy("<u2").tobytes())
        frp10 = np.minimum(np.nan_to_num(g["frp"].to_numpy(float)) * 10, 65535).round()
        f.write(frp10.astype("<u2").tobytes())
        f.write(g["sub"].to_numpy("u1").tobytes())
        f.write((g["year"] - year0).to_numpy("u1").tobytes())
    info = {"rows": int(len(g)), "fine": a.fine, "per": k, "year0": year0, "switchYear": int(switch)}
    print(f"Close-up maps: {len(det):,} detections -> {len(g):,} spots "
          f"({path.stat().st_size / 1e6:.1f} MB); MODIS before {switch}, VIIRS from {switch}.")
    return info


if __name__ == "__main__":
    main()
