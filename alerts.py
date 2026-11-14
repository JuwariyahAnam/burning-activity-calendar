"""
Districts burning far more than usual, for the site's daily feed.

AI disclosure: drafted with Claude (Anthropic); review before use.

Same rule as the website (docs/engine.js, districtRecent): for the last
`days` days, each district's harmonized fire-days are compared with the same
dates in every earlier year. A district is flagged when it is above the 90th
percentile of those years, at least 1.5 times their median and has at least
5 fire-days. build_site.py writes the result to docs/data/<area>/alerts.json
and an RSS feed for all areas to docs/data/alerts.xml.
"""
import datetime as dt
import json
from email.utils import format_datetime
from pathlib import Path
from xml.sax.saxutils import escape

import numpy as np
import pandas as pd

import harmonize as hz

METHOD = "monthly"        # keep the same as DEFAULT_METHOD in docs/app.js
TERRA, AQUA, SNPP, NOAA20 = 1, 2, 4, 8


def compute(rows, cell_id, bnd, cov, snpp_end, days=7, method=METHOD):
    """rows: local_date, cell_lat, cell_lon, flag (one row per cell and day)."""
    cell_district = np.asarray(bnd["cellDistrict"])
    cell = np.array([cell_id[(la, lo)] for la, lo in zip(rows["cell_lat"], rows["cell_lon"])])
    df = pd.DataFrame({"date": rows["local_date"].to_numpy(), "dist": cell_district[cell],
                       "flag": rows["flag"].to_numpy()})
    df = df[df["dist"] >= 0]
    df["modis"] = (df["flag"] & (TERRA | AQUA)) > 0
    snpp = (df["flag"] & SNPP) > 0
    n20 = (df["flag"] & NOAA20) > 0
    df["viirs"] = (n20 if snpp_end is None else snpp | (n20 & (df["date"] > snpp_end)))
    per = df.groupby(["dist", "date"])[["modis", "viirs"]].sum()

    # scaling factors from the whole study area, as on the website
    focus = set(bnd.get("focusIds") or [])
    area = per[per.index.get_level_values(0).isin(focus)] if focus else per
    days_idx = pd.date_range(min(v[0] for v in cov.values()), max(v[1] for v in cov.values()), freq="D")
    daily = area.groupby(level=1).sum().reindex(days_idx, fill_value=0).astype(float)
    daily.columns = ["MODIS", "VIIRS"]
    for inst in ("MODIS", "VIIRS"):
        lo, hi = cov[inst]
        daily.loc[(daily.index < lo) | (daily.index > hi), inst] = np.nan
    k = hz.fit_ratios(hz.monthly_counts(daily), method)

    last = days_idx[-1]
    windows = []
    for y in range(last.year, days_idx[0].year - 1, -1):
        try:
            end = pd.Timestamp(y, last.month, last.day)
        except ValueError:                       # 29 February
            end = pd.Timestamp(y, last.month, 28)
        start = end - pd.Timedelta(days=days - 1)
        span = pd.date_range(start, end, freq="D")
        observed = lambda d: any(cov[i][0] <= d <= cov[i][1] for i in cov)
        if start < days_idx[0] or not all(observed(d) for d in span):
            continue
        windows.append((y, span))

    def harmonized(m, v, span):
        out = 0.0
        for d in span:
            if cov["VIIRS"][0] <= d <= cov["VIIRS"][1]:
                out += v.get(d, 0)
            else:
                out += m.get(d, 0) * k[d.month]
        return out

    cur = next((w for w in windows if w[0] == last.year), None)
    past = [w for w in windows if w[0] != last.year]
    names = {d["id"]: (d["name"], d["state"]) for d in bnd["districts"]}
    results = []
    for dist in sorted(focus or set(per.index.get_level_values(0))):
        if dist not in per.index.get_level_values(0):
            m, v = {}, {}
        else:
            sub = per.loc[dist]
            m, v = sub["modis"].to_dict(), sub["viirs"].to_dict()
        now = harmonized(m, v, cur[1]) if cur else float("nan")
        hist = sorted(harmonized(m, v, w[1]) for w in past)
        if not hist:
            continue
        med, p90 = float(np.quantile(hist, 0.5)), float(np.quantile(hist, 0.9))
        flagged = len(hist) >= 5 and now >= 5 and now > p90 and now >= 1.5 * med
        below = sum(h < now for h in hist)
        record = len(hist) >= 5 and now > hist[-1] and now >= 5
        name, state = names.get(dist, (str(dist), ""))
        results.append({"id": int(dist), "district": name, "state": state, "now": round(now, 1),
                        "usual": round(med, 1), "ratio": round(now / med, 2) if med > 0 else None,
                        "flagged": bool(flagged), "record": bool(record),
                        "rank": f"highest in {len(hist)} years" if record else f"more than {below} of {len(hist)} years"})
    flagged = sorted((r for r in results if r["flagged"]), key=lambda r: -(r["ratio"] or 1e9))
    closest = sorted((r for r in results if not r["flagged"] and r["now"] > 0),
                     key=lambda r: -(r["ratio"] or 0))[:5]
    return {"days": days, "from": cur[1][0].date().isoformat() if cur else None,
            "to": last.date().isoformat(), "years": len(past), "method": method,
            "flagged": flagged, "closest": closest}


def write_feed(root, built, site):
    """docs/data/alerts.xml: one item per study area, rebuilt with the data."""
    now = dt.datetime.now(dt.timezone.utc)
    items = []
    for r, al in built:
        if not al or not al.get("from"):
            continue
        span = f"{pretty(al['from'])} to {pretty(al['to'])}"
        n = len(al["flagged"])
        title = (f"{r['name']}: {n} district{'s' if n != 1 else ''} burning far more than usual, {span}"
                 if n else f"{r['name']}: no district burning far more than usual, {span}")
        lines = [f"{x['district']}, {x['state']}: {x['now']:g} fire-days in {al['days']} days, "
                 f"usual {x['usual']:g} ({x['rank']})" for x in al["flagged"]]
        desc = ("\n".join(lines) if lines else "Every district is within its usual range for these dates.") + \
            "\nFrom NASA FIRMS MODIS and VIIRS detections, harmonized. Not an official warning service."
        link = f"{site}?region={r['slug']}" if site else f"?region={r['slug']}"
        items.append(f"""  <item>
    <title>{escape(title)}</title>
    <link>{escape(link)}</link>
    <guid isPermaLink="false">{escape(r['slug'])}-{al['to']}</guid>
    <pubDate>{format_datetime(now)}</pubDate>
    <description>{escape(desc)}</description>
  </item>""")
    feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Burning Activity Calendar: burning more than usual</title>
  <link>{escape(site or "")}</link>
  <description>Districts with far more satellite fire detections than usual in the last 7 days, from harmonized NASA MODIS and VIIRS records.</description>
  <lastBuildDate>{format_datetime(now)}</lastBuildDate>
{chr(10).join(items)}
</channel>
</rss>
"""
    (Path(root) / "alerts.xml").write_text(feed, encoding="utf-8")


def pretty(iso):
    d = dt.date.fromisoformat(iso)
    return f"{d.day} {d.strftime('%b')} {d.year}"


def save(path, region_name, al):
    Path(path).write_text(json.dumps({"region": region_name, **al}, indent=1), encoding="utf-8")
