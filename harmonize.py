"""
Harmonization of MODIS and VIIRS active fire hotspots (NASA FIRMS).

AI disclosure: this file was drafted with Claude (Anthropic) and must be
reviewed, tested and adapted by the team. Record this in the AI usage log.

Pipeline
    1. read_firms_csv   read FIRMS archive / API CSV files
    2. clean            one confidence rule, vegetation fires, UTC -> local date
    3. to_cell_days     detections -> "fire-days per grid cell"
    4. select           area of interest + which satellites count
    5. daily_counts     active cells per day, per instrument
    6. fit_ratios       VIIRS ~ k x MODIS on the overlap period
    7. harmonize_daily  one VIIRS-equivalent series for the whole record
    8. loyo_validation  leave-one-year-out error for each method
       step_check       is there an artificial jump where VIIRS starts?
"""
from __future__ import annotations

import numpy as np
import pandas as pd

MODIS_SATS = {"TERRA": "Terra", "T": "Terra", "AQUA": "Aqua", "A": "Aqua"}
VIIRS_SATS = {
    "N": "SNPP", "SNPP": "SNPP", "SUOMI NPP": "SNPP",
    "N20": "NOAA20", "1": "NOAA20", "NOAA-20": "NOAA20", "NOAA20": "NOAA20",
    "N21": "NOAA21", "2": "NOAA21", "NOAA-21": "NOAA21", "NOAA21": "NOAA21",
}
METHODS = ("simple", "monthly")


# ---------------------------------------------------------------- 1. read
def read_firms_csv(path) -> pd.DataFrame:
    """Read one FIRMS CSV (MODIS or VIIRS, archive or near-real-time)."""
    df = pd.read_csv(
        path, dtype={"satellite": str, "confidence": str, "acq_time": str},
        low_memory=False,
    )
    df.columns = [c.strip().lower() for c in df.columns]
    needed = {"latitude", "longitude", "acq_date", "acq_time", "confidence"}
    missing = needed - set(df.columns)
    if missing:
        raise ValueError(f"{path}: missing columns {sorted(missing)}")
    if "instrument" in df.columns:
        df["instrument"] = df["instrument"].astype(str).str.upper().str.strip()
    else:
        df["instrument"] = "VIIRS" if "bright_ti4" in df.columns else "MODIS"
    if "satellite" not in df.columns:
        df["satellite"] = np.where(df["instrument"] == "MODIS", "Terra", "N")
    return df


# --------------------------------------------------------------- 2. clean
def clean(df: pd.DataFrame, modis_min_conf: int = 30,
          viirs_keep: tuple = ("n", "h"), tz_hours: float = 5.5,
          vegetation_only: bool = True) -> pd.DataFrame:
    """Apply the shared confidence rule and convert UTC time to local date.

    tz_hours=5.5 is India Standard Time. Change it for other regions.
    """
    df = df.copy()
    is_modis = df["instrument"] == "MODIS"
    conf = df["confidence"].astype(str).str.strip().str.lower()
    modis_ok = pd.to_numeric(conf, errors="coerce") >= modis_min_conf
    viirs_ok = conf.str[:1].isin(list(viirs_keep))
    keep = np.where(is_modis, modis_ok, viirs_ok)

    # 'type' exists only in standard-quality data: 0 = vegetation fire.
    if vegetation_only and "type" in df.columns:
        t = pd.to_numeric(df["type"], errors="coerce")
        keep &= (t.isna() | (t == 0)).to_numpy()
    df = df[keep].copy()

    sat = df["satellite"].astype(str).str.strip().str.upper()
    df["satellite"] = np.where(
        df["instrument"] == "MODIS", sat.map(MODIS_SATS), sat.map(VIIRS_SATS))
    df = df.dropna(subset=["satellite"])

    hhmm = df["acq_time"].astype(str).str.replace(":", "").str.zfill(4)
    utc = (pd.to_datetime(df["acq_date"])
           + pd.to_timedelta(hhmm.str[:2].astype(int), unit="h")
           + pd.to_timedelta(hhmm.str[2:4].astype(int), unit="m"))
    df["local_date"] = (utc + pd.Timedelta(hours=tz_hours)).dt.normalize()
    if "frp" not in df.columns:
        df["frp"] = np.nan
    return df[["instrument", "satellite", "latitude", "longitude",
               "local_date", "frp"]]


# ----------------------------------------------------------- 3. cell-days
def to_cell_days(df: pd.DataFrame, cell_deg: float = 0.1) -> pd.DataFrame:
    """One row per (satellite, grid cell, local day) with >= 1 detection.

    Counting cell-days instead of pixels removes duplicate detections of
    the same fire and much of the pixel-size difference between sensors.
    """
    df = df.copy()
    df["cell_lat"] = (np.floor(df["latitude"] / cell_deg) * cell_deg
                      + cell_deg / 2).round(4)
    df["cell_lon"] = (np.floor(df["longitude"] / cell_deg) * cell_deg
                      + cell_deg / 2).round(4)
    keys = ["instrument", "satellite", "cell_lat", "cell_lon", "local_date"]
    return (df.groupby(keys, as_index=False)
              .agg(detections=("frp", "size"), frp_sum=("frp", "sum")))


def coverage(cell_days: pd.DataFrame) -> dict:
    """First and last date each instrument appears in the whole dataset."""
    g = cell_days.groupby("instrument")["local_date"].agg(["min", "max"])
    return {k: (v["min"], v["max"]) for k, v in g.iterrows()}


# -------------------------------------------------------------- 4. select
def select(cell_days: pd.DataFrame, bbox: tuple,
           modis_sats: tuple = ("Terra", "Aqua"),
           viirs_mode: str = "reference") -> pd.DataFrame:
    """Filter to the area of interest and choose which satellites count.

    bbox = (south, west, north, east) in degrees.
    viirs_mode
        "reference": one VIIRS satellite at a time (S-NPP while it exists,
                     NOAA-20 afterwards), so adding satellites in 2018 and
                     2023 does not create artificial jumps.
        "all":       every VIIRS satellite (shows the jumps).
    """
    s, w, n, e = bbox
    d = cell_days[cell_days["cell_lat"].between(s, n)
                  & cell_days["cell_lon"].between(w, e)]
    modis = d[(d["instrument"] == "MODIS") & d["satellite"].isin(modis_sats)]
    viirs = d[d["instrument"] == "VIIRS"]
    if viirs_mode == "reference":
        all_v = cell_days[cell_days["instrument"] == "VIIRS"]
        snpp_end = all_v.loc[all_v["satellite"] == "SNPP", "local_date"].max()
        if pd.isna(snpp_end):
            viirs = viirs[viirs["satellite"] == "NOAA20"]
        else:
            viirs = viirs[
                ((viirs["satellite"] == "SNPP"))
                | ((viirs["satellite"] == "NOAA20")
                   & (viirs["local_date"] > snpp_end))]
    out = pd.concat([modis, viirs])
    # a cell-day seen by two satellites of one instrument counts once
    return out.drop_duplicates(
        ["instrument", "cell_lat", "cell_lon", "local_date"])


# -------------------------------------------------------- 5. daily counts
def daily_counts(sel: pd.DataFrame, cov: dict) -> pd.DataFrame:
    """Active cells per day. NaN = instrument not observing, 0 = no fire."""
    start = min(v[0] for v in cov.values())
    end = max(v[1] for v in cov.values())
    idx = pd.date_range(start, end, freq="D")
    out = pd.DataFrame(index=idx, columns=["MODIS", "VIIRS"], dtype=float)
    for inst in ("MODIS", "VIIRS"):
        if inst not in cov:
            continue
        c = (sel[sel["instrument"] == inst].groupby("local_date").size()
             .reindex(idx, fill_value=0).astype(float))
        c[(idx < cov[inst][0]) | (idx > cov[inst][1])] = np.nan
        out[inst] = c
    return out


def monthly_counts(daily: pd.DataFrame) -> pd.DataFrame:
    """Monthly sums. A month is kept only if every day was observed."""
    sums = daily.resample("MS").sum(min_count=1)
    seen = daily.notna().resample("MS").sum()
    return sums.where(seen.eq(sums.index.days_in_month, axis=0))


# ------------------------------------------------------------ 6. calibrate
def fit_ratios(monthly: pd.DataFrame, method: str = "monthly",
               min_modis: float = 20) -> pd.Series:
    """Scaling factor k for each calendar month (1..12): VIIRS ~ k x MODIS.

    simple : one k for all months.
    monthly: one k per calendar month; months with too little MODIS
             activity (< min_modis fire-days in total) fall back to simple.
    """
    ov = monthly.dropna(subset=["MODIS", "VIIRS"])
    if ov.empty or ov["MODIS"].sum() <= 0:
        raise ValueError("No overlap between MODIS and VIIRS in this area.")
    k_all = ov["VIIRS"].sum() / ov["MODIS"].sum()
    k = pd.Series(k_all, index=range(1, 13), name="k")
    if method == "monthly":
        by = ov.groupby(ov.index.month)[["MODIS", "VIIRS"]].sum()
        good = by["MODIS"] >= min_modis
        k.update((by["VIIRS"] / by["MODIS"])[good])
    elif method != "simple":
        raise ValueError(f"unknown method {method!r}")
    return k


# ----------------------------------------------------------- 7. harmonize
def harmonize_daily(daily: pd.DataFrame, k: pd.Series) -> pd.DataFrame:
    """VIIRS where it exists, otherwise MODIS scaled to VIIRS-equivalent."""
    scaled = daily["MODIS"] * daily.index.month.map(k).to_numpy()
    out = pd.DataFrame(index=daily.index)
    out["harmonized"] = daily["VIIRS"].fillna(scaled)
    out["source"] = np.where(daily["VIIRS"].notna(), "VIIRS observed",
                             np.where(daily["MODIS"].notna(),
                                      "MODIS scaled", "no observation"))
    return out


def calendar(harm_daily: pd.DataFrame) -> pd.DataFrame:
    """Years x months table of harmonized fire-days."""
    m = harm_daily["harmonized"].resample("MS").sum(min_count=1)
    return (m.groupby([m.index.year, m.index.month]).sum(min_count=1)
             .unstack().reindex(columns=range(1, 13)))


def month_to_date(harm_daily: pd.DataFrame) -> pd.DataFrame:
    """Latest month so far vs the same days of that month in earlier years."""
    h = harm_daily["harmonized"].dropna()
    last = h.index.max()
    part = h[(h.index.month == last.month) & (h.index.day <= last.day)]
    days = part.groupby(part.index.year).count()
    tot = part.groupby(part.index.year).sum()[days == last.day]
    return tot.rename("fire_days").to_frame()


# ------------------------------------------------------------- 8. validate
def loyo_validation(monthly: pd.DataFrame, min_modis: float = 20):
    """Leave-one-year-out test on the overlap years, for each method.

    For every overlap year: fit k on the other years, predict VIIRS from
    MODIS for the held-out year, compare with the VIIRS actually observed.
    Returns (summary, per_year). WAPE = sum|error| / sum observed.
    """
    ov = monthly.dropna(subset=["MODIS", "VIIRS"])
    rows = []
    for year in sorted(set(ov.index.year)):
        test = ov[ov.index.year == year]
        train = monthly.copy()
        train.loc[train.index.year == year, "VIIRS"] = np.nan
        for method in METHODS:
            try:
                k = fit_ratios(train, method, min_modis)
            except ValueError:
                continue
            pred = test["MODIS"] * test.index.month.map(k).to_numpy()
            rows.append({"year": year, "method": method,
                         "observed": test["VIIRS"].sum(),
                         "predicted": pred.sum(),
                         "abs_error": (pred - test["VIIRS"]).abs().sum()})
    per_year = pd.DataFrame(rows)
    if per_year.empty:
        return pd.DataFrame(), per_year
    g = per_year.groupby("method")
    summary = pd.DataFrame({
        "monthly WAPE %": 100 * g["abs_error"].sum() / g["observed"].sum(),
        "annual bias %": 100 * (g["predicted"].sum() / g["observed"].sum() - 1),
        "years tested": g["year"].nunique(),
    }).reindex(list(METHODS)).dropna(how="all")
    return summary, per_year


def step_check(monthly: pd.DataFrame, k: pd.Series, n_years: int = 3):
    """Is there an artificial jump where the record switches to VIIRS?

    Compares the n_years after VIIRS begins with the n_years before, as a
    ratio of mean annual fire-days, three ways. MODIS observed both periods
    with one instrument, so 'MODIS only' is the real change. A good
    harmonization gives a 'harmonized' ratio close to it.
    """
    first_v = monthly["VIIRS"].first_valid_index()
    if first_v is None:
        return None
    y0 = first_v.year
    scaled = monthly["MODIS"] * monthly.index.month.map(k).to_numpy()
    series = {
        "MODIS only (real change)": monthly["MODIS"],
        "raw splice (MODIS then VIIRS)": monthly["VIIRS"].fillna(monthly["MODIS"]),
        "harmonized": monthly["VIIRS"].fillna(scaled),
    }
    out = {}
    for name, s in series.items():
        a = s.groupby(s.index.year).sum(min_count=12)
        before = a.reindex(range(y0 - n_years, y0)).mean()
        after = a.reindex(range(y0, y0 + n_years)).mean()
        out[name] = after / before if before else np.nan
    return pd.Series(out, name=f"after/before ratio around {y0}")
