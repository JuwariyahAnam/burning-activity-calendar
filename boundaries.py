"""
State and district boundaries for the website, from geoBoundaries.

AI disclosure: drafted with Claude (Anthropic); review before use.

Source: geoBoundaries (Runfola et al. 2020, PLOS ONE 15(4): e0231866),
India ADM1 (states) and ADM2 (districts), simplified versions. Check the
licence reported in the metadata (HDX lists India under ODbL) and keep the
attribution in the site footer. Boundaries are for reference only and are
not an authoritative depiction of any border.

Used by build_site.py. Works without shapely: plain NumPy point-in-polygon.
"""
import json
import unicodedata
import urllib.request
from pathlib import Path

import numpy as np


def plain(name):
    """'Haryāna' -> 'Haryana'. geoBoundaries spells many Indian names with
    diacritics; the site and the state matching use the plain spelling."""
    return "".join(c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c))

API = "https://www.geoboundaries.org/api/current/gbOpen/IND/{level}/"
RAW = ("https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/gbOpen/"
       "IND/{level}/geoBoundaries-IND-{level}_simplified.geojson")
UA = {"User-Agent": "burning-activity-calendar/1.0 (Space Apps 2026)"}


def _get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def load_level(level, cache_dir="data/boundaries", local=None):
    """GeoJSON dict for ADM1 or ADM2: a local file, the cache, or a download."""
    if local:
        return json.loads(Path(local).read_text(encoding="utf-8"))
    cache = Path(cache_dir) / f"IND_{level}_simplified.geojson"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    urls = []
    try:
        meta = json.loads(_get(API.format(level=level)))
        if meta.get("simplifiedGeometryGeoJSON"):
            urls.append(meta["simplifiedGeometryGeoJSON"])
        print(f"  geoBoundaries IND {level}: licence {meta.get('boundaryLicense', '?')}, "
              f"source {meta.get('boundarySource', '?')}")
    except Exception as err:  # API down: try the repository directly
        print(f"  geoBoundaries API unavailable ({err}); trying the repository")
    urls.append(RAW.format(level=level))
    for url in urls:
        try:
            data = _get(url)
            gj = json.loads(data)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(data)
            return gj
        except Exception as err:
            print(f"  could not download {url} ({err})")
    return None


# ------------------------------------------------------------ geometry
def polygons(geom):
    """List of polygons, each a list of rings, each an (n, 2) array of lon, lat."""
    if geom["type"] == "Polygon":
        return [[np.asarray(r, float)[:, :2] for r in geom["coordinates"]]]
    if geom["type"] == "MultiPolygon":
        return [[np.asarray(r, float)[:, :2] for r in p] for p in geom["coordinates"]]
    return []


def bbox_of(polys):
    pts = np.concatenate([r for p in polys for r in p])
    return pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max()


def contains(polys, lon, lat):
    """Even-odd point-in-polygon for arrays of points."""
    lon, lat = np.asarray(lon, float), np.asarray(lat, float)
    inside = np.zeros(lon.shape, bool)
    for p in polys:
        for ring in p:
            x, y = ring[:, 0], ring[:, 1]
            x2, y2 = np.roll(x, -1), np.roll(y, -1)
            for i in range(len(x)):
                cond = (y[i] > lat) != (y2[i] > lat)
                if not cond.any():
                    continue
                xc = x[i] + (lat - y[i]) * (x2[i] - x[i]) / ((y2[i] - y[i]) or 1e-12)
                inside ^= cond & (lon < xc)
    return inside


def simplify(ring, tol):
    """Ramer-Douglas-Peucker on a closed ring."""
    if len(ring) < 5:
        return ring
    keep = np.zeros(len(ring), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(ring) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        p, q = ring[a], ring[b]
        seg = q - p
        L = np.hypot(*seg) or 1e-12
        mid = ring[a + 1:b]
        d = np.abs(seg[0] * (mid[:, 1] - p[1]) - seg[1] * (mid[:, 0] - p[0])) / L
        i = int(d.argmax())
        if d[i] > tol:
            keep[a + 1 + i] = True
            stack += [(a, a + 1 + i), (a + 1 + i, b)]
    out = ring[keep]
    return out if len(out) >= 4 else ring


def rings_out(polys, tol):
    return [[[round(float(x), 4), round(float(y), 4)] for x, y in simplify(r, tol)]
            for p in polys for r in p]


def centroid(polys):
    """Area-weighted centroid of the largest outer ring."""
    best = max((p[0] for p in polys), key=lambda r: abs(_area(r)))
    x, y = best[:, 0], best[:, 1]
    x2, y2 = np.roll(x, -1), np.roll(y, -1)
    cross = x * y2 - x2 * y
    a = cross.sum() / 2 or 1e-12
    return float(((x + x2) * cross).sum() / (6 * a)), float(((y + y2) * cross).sum() / (6 * a))


def _area(r):
    x, y = r[:, 0], r[:, 1]
    return 0.5 * float((x * np.roll(y, -1) - np.roll(x, -1) * y).sum())


# ------------------------------------------------------------ build
def build(cells, extent, focus_states, adm1=None, adm2=None, tol=0.006, clip=None):
    """Boundaries for the site.

    cells: list of [lat, lon] grid-cell centres (same order as meta.json)
    extent: [south, west, north, east] of the data
    focus_states: list of alias lists, e.g. [["Uttarakhand", "Uttaranchal"]]
    clip: [south, west, north, east] to keep only districts centred inside it
          (for part of a state), or None for whole states
    Returns a dict for districts.json, or None if boundaries are unavailable.
    """
    print("District boundaries:")
    g1 = load_level("ADM1", local=adm1)
    g2 = load_level("ADM2", local=adm2)
    if not g1 or not g2:
        print("  not available; the site will work without districts.")
        return None
    s, w, n, e = extent
    pad = 0.3

    def near(polys):
        x0, y0, x1, y1 = bbox_of(polys)
        return x1 >= w - pad and x0 <= e + pad and y1 >= s - pad and y0 <= n + pad

    states = []
    for f in g1["features"]:
        polys = polygons(f["geometry"])
        if polys and near(polys):
            states.append({"name": plain(f["properties"].get("shapeName", "?")), "polys": polys})
    lat = np.array([c[0] for c in cells]); lon = np.array([c[1] for c in cells])
    cell_district = np.full(len(cells), -1, int)
    districts = []
    for f in g2["features"]:
        polys = polygons(f["geometry"])
        if not polys or not near(polys):
            continue
        name = plain(f["properties"].get("shapeName", "?"))
        inside = contains(polys, lon, lat) & (cell_district < 0)
        cx, cy = centroid(polys)
        if not contains(polys, [cx], [cy])[0] and inside.any():
            k = np.flatnonzero(inside)                 # concave shape: use a cell inside
            j = k[np.argmin((lon[k] - cx) ** 2 + (lat[k] - cy) ** 2)]
            cx, cy = float(lon[j]), float(lat[j])
        did = len(districts)
        cell_district[inside] = did
        districts.append({"id": did, "name": name, "state": "",
                          "label": [round(cy, 4), round(cx, 4)],
                          "rings": rings_out(polys, tol), "cells": int(inside.sum())})
    # state of each district: the state polygon containing its label point
    if districts:
        lx = np.array([d["label"][1] for d in districts])
        ly = np.array([d["label"][0] for d in districts])
        for st in states:
            hit = contains(st["polys"], lx, ly)
            for i in np.flatnonzero(hit):
                if not districts[i]["state"]:
                    districts[i]["state"] = st["name"]
    norm = lambda x: " ".join(plain(x).lower().replace("&", "and").split())
    wanted = [{norm(n) for n in group} for group in focus_states]
    focus = [st["name"] for st in states if any(norm(st["name"]) in g for g in wanted)]
    unmatched = [g for g in focus_states if not any(norm(st["name"]) in {norm(n) for n in g} for st in states)]
    if unmatched:
        print(f"  warning: no state named {unmatched} near this area; states found: "
              f"{', '.join(st['name'] for st in states)}")
    inside = lambda d: clip is None or (clip[0] <= d["label"][0] <= clip[2] and clip[1] <= d["label"][1] <= clip[3])
    focus_ids = [d["id"] for d in districts if d["state"] in focus and inside(d)]
    out = {
        "source": "geoBoundaries (Runfola et al. 2020), India ADM1 and ADM2, simplified",
        "note": "Boundaries are for reference only.",
        "focus": focus,
        "focusIds": focus_ids,
        "focusMode": "districts" if clip else "states",
        "states": [{"name": st["name"], "rings": rings_out(st["polys"], tol)} for st in states],
        "districts": districts,
        "cellDistrict": cell_district.tolist(),
    }
    n_in = int((cell_district >= 0).sum())
    print(f"  {len(districts)} districts in {len(states)} states/territories; "
          f"{n_in:,} of {len(cells):,} fire grid cells fall inside a district. "
          f"Focus: {', '.join(focus) or 'none'} ({len(focus_ids)} districts{', clipped to the area' if clip else ''})")
    return out
