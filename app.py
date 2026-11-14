"""
Burning Activity Calendar - Streamlit app.

AI disclosure: this file was drafted with Claude (Anthropic) and must be
reviewed and adapted by the team. Record this in the AI usage log.

Run:  streamlit run app.py
Data: data/cell_days.csv.gz, built by prepare.py from NASA FIRMS CSVs.
"""
import calendar as pycal
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

import harmonize as hz

try:
    import folium
    from folium.plugins import Draw, HeatMap
    from streamlit_folium import st_folium
    HAS_MAP = True
except ImportError:          # the app still works with typed coordinates
    HAS_MAP = False

APP_NAME = "Burning Activity Calendar"      # TODO: your project name
DATA_PATH = Path("data/cell_days.csv.gz")
PRESETS = {                                  # (south, west, north, east)
    "Punjab & Haryana, India": (27.6, 73.8, 32.6, 77.6),
    "Custom area": None,
}
MONTHS = [pycal.month_abbr[m] for m in range(1, 13)]
ACCENT = "#ff7a1a"

st.set_page_config(page_title=APP_NAME, page_icon="🔥", layout="wide")

# ------------------------------------------------------------------ style
st.markdown("""
<style>
.stApp {
  background-color: #000;
  background-image:
    radial-gradient(1px 1px at 12% 18%, #fff 50%, transparent 51%),
    radial-gradient(1px 1px at 37% 71%, #cfd8ff 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 63% 33%, #fff 50%, transparent 51%),
    radial-gradient(1px 1px at 84% 62%, #ffe9cf 50%, transparent 51%),
    radial-gradient(1px 1px at 52% 90%, #fff 50%, transparent 51%),
    radial-gradient(ellipse at 50% -20%, rgba(255,122,26,.20), transparent 60%);
  background-size: 420px 420px, 520px 520px, 640px 640px, 380px 380px,
                   560px 560px, 100% 900px;
  background-repeat: repeat, repeat, repeat, repeat, repeat, no-repeat;
  animation: drift 240s linear infinite;
}
@keyframes drift { to { background-position:
  420px 420px, -520px 520px, 640px -640px, -380px -380px, 560px 560px, 0 0; } }
@keyframes rise { from { opacity: 0; transform: translateY(24px); }
                  to   { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .stApp, .hero, [data-testid="stMetric"] { animation: none !important; }
}
header[data-testid="stHeader"] { background: transparent; }
.block-container { max-width: 1180px; padding-top: 2rem; padding-bottom: 6rem; }
html, body, [class*="css"] {
  font-family: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.hero { text-align: center; padding: 9vh 0 7vh; animation: rise 1s ease both; }
.hero .eyebrow { color: #ff7a1a; font-weight: 600; letter-spacing: .08em;
  text-transform: uppercase; font-size: .85rem; }
.hero h1 { font-size: clamp(2.6rem, 6.5vw, 5.2rem); font-weight: 700;
  letter-spacing: -.03em; line-height: 1.04; margin: .4rem 0 1rem;
  background: linear-gradient(180deg, #fff 30%, #9a9aa3);
  -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero p { color: #a1a1a8; font-size: 1.25rem; max-width: 720px; margin: 0 auto; }
.section { margin-top: 5.5rem; animation: rise .9s ease both; }
.section h2 { font-size: clamp(1.8rem, 3.4vw, 2.8rem); font-weight: 700;
  letter-spacing: -.02em; color: #f5f5f7; margin-bottom: .3rem; }
.section p { color: #a1a1a8; font-size: 1.08rem; max-width: 760px; }
[data-testid="stMetric"] {
  background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.10);
  border-radius: 22px; padding: 1.3rem 1.4rem; backdrop-filter: blur(14px);
  animation: rise .9s ease both; transition: transform .25s, border-color .25s; }
[data-testid="stMetric"]:hover { transform: translateY(-4px);
  border-color: rgba(255,122,26,.6); }
[data-testid="stMetricValue"] { font-size: 2.3rem; font-weight: 700; }
section[data-testid="stSidebar"] { background: rgba(14,14,16,.92);
  border-right: 1px solid rgba(255,255,255,.08); }
.stDownloadButton button, .stButton button { border-radius: 999px;
  padding: .5rem 1.3rem; border: 1px solid rgba(255,255,255,.25); }
.stDownloadButton button:hover, .stButton button:hover {
  border-color: #ff7a1a; color: #ff7a1a; }
.caveat { border-left: 3px solid #ff7a1a; padding: .2rem 0 .2rem 1rem;
  color: #c9c9cf; }
</style>
""", unsafe_allow_html=True)


def section(title, text=""):
    st.markdown(f'<div class="section"><h2>{title}</h2><p>{text}</p></div>',
                unsafe_allow_html=True)


def style(fig, height=440):
    fig.update_layout(
        template="plotly_dark", height=height,
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(255,255,255,.03)",
        font=dict(color="#e8e8ed", size=14),
        margin=dict(l=10, r=10, t=30, b=10),
        legend=dict(orientation="h", y=1.1, x=0),
        hoverlabel=dict(bgcolor="#111", font_size=14))
    return fig


# ------------------------------------------------------------------- data
@st.cache_data(show_spinner="Loading fire record...")
def load(source):
    return pd.read_csv(source, parse_dates=["local_date"])


if DATA_PATH.exists():
    cell_days = load(str(DATA_PATH))
else:
    st.markdown(f'<div class="hero"><h1>{APP_NAME}</h1></div>',
                unsafe_allow_html=True)
    st.info("No data yet. Download MODIS and VIIRS CSVs from NASA FIRMS, run "
            "`python prepare.py raw/*.csv`, then reload. "
            "Or upload a prepared cell_days file below.")
    up = st.file_uploader("cell_days.csv.gz", type=["gz", "csv"])
    if not up:
        st.stop()
    cell_days = load(up)

cov = hz.coverage(cell_days)
if not {"MODIS", "VIIRS"} <= set(cov):
    st.error("The data file needs both MODIS and VIIRS detections.")
    st.stop()

# ---------------------------------------------------------------- sidebar
first = next(iter(PRESETS.values()))
for key, val in zip("swne", first):
    st.session_state.setdefault(key, val)


def apply_preset():
    box = PRESETS[st.session_state.preset]
    if box:
        for key, val in zip("swne", box):
            st.session_state[key] = val


def apply_drawn(box):
    for key, val in zip("swne", box):
        st.session_state[key] = round(val, 3)
    st.session_state.preset = "Custom area"


with st.sidebar:
    st.header("Area of interest")
    st.selectbox("Preset", list(PRESETS), key="preset", on_change=apply_preset)
    c1, c2 = st.columns(2)
    c1.number_input("South", -90.0, 90.0, key="s", step=0.1)
    c2.number_input("North", -90.0, 90.0, key="n", step=0.1)
    c1.number_input("West", -180.0, 180.0, key="w", step=0.1)
    c2.number_input("East", -180.0, 180.0, key="e", step=0.1)

    st.header("Period")
    y_lo = int(min(v[0] for v in cov.values()).year)
    y_hi = int(max(v[1] for v in cov.values()).year)
    years = st.slider("Years shown", y_lo, y_hi, (y_lo, y_hi))

    st.header("Harmonization")
    method = st.radio(
        "Calibration method", hz.METHODS, index=1,
        format_func={"simple": "Simple ratio (one k)",
                     "monthly": "Ratio by month (12 k values)"}.get)
    aqua_only = st.checkbox(
        "MODIS: Aqua only", value=False,
        help="Aqua passes at a similar time of day to VIIRS. "
             "The record then starts in mid-2002.")
    viirs_all = st.checkbox(
        "VIIRS: use all satellites", value=False,
        help="Off = one reference satellite at a time (S-NPP, then NOAA-20), "
             "which avoids jumps when satellites were added in 2018 and 2023. "
             "On needs NOAA-20's full record: "
             "fetch_firms.py --noaa20-start 2018-04-01")

bbox = (st.session_state.s, st.session_state.w,
        st.session_state.n, st.session_state.e)
if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
    st.error("South must be below North, and West must be left of East.")
    st.stop()

# --------------------------------------------------------------- analysis
sel = hz.select(cell_days, bbox,
                modis_sats=("Aqua",) if aqua_only else ("Terra", "Aqua"),
                viirs_mode="all" if viirs_all else "reference")
daily = hz.daily_counts(sel, cov)
monthly = hz.monthly_counts(daily)
try:
    k = hz.fit_ratios(monthly, method)
except ValueError as err:
    st.error(f"{err} Choose a larger area or one with more fire activity.")
    st.stop()
harm = hz.harmonize_daily(daily, k)
cal = hz.calendar(harm).loc[years[0]:years[1]]
mtd = hz.month_to_date(harm)
last_day = harm["harmonized"].dropna().index.max()
summary, per_year = hz.loyo_validation(monthly)
steps = hz.step_check(monthly, k)

# ------------------------------------------------------------------- hero
st.markdown(f"""
<div class="hero">
  <div class="eyebrow">NASA FIRMS · MODIS + VIIRS · {y_lo}–{y_hi}</div>
  <h1>Two decades of fire.<br>One consistent record.</h1>
  <p>See when burning happens in your area, how this month compares with
  history, and which periods are critical, regardless of which satellite
  made the detection.</p>
</div>""", unsafe_allow_html=True)

cur_year, cur = int(mtd.index.max()), float(mtd["fire_days"].iloc[-1])
past = mtd["fire_days"].iloc[:-1]
median = float(past.median()) if len(past) else np.nan
anomaly = 100 * (cur / median - 1) if median and median > 0 else np.nan
rank = 100 * (past < cur).mean() if len(past) else np.nan
typical = cal.median()
peak_m = int(typical.idxmax()) if typical.notna().any() else None
label = f"{pycal.month_name[last_day.month]} 1–{last_day.day}"

m1, m2, m3, m4 = st.columns(4)
m1.metric(f"{label}, {cur_year}", f"{cur:,.0f}",
          None if np.isnan(anomaly) else f"{anomaly:+.0f}% vs median",
          delta_color="inverse", help="Harmonized fire-days so far this month")
m2.metric("Historical median", "–" if np.isnan(median) else f"{median:,.0f}",
          help=f"Same days ({label}) in every earlier year")
m3.metric("Higher than", "–" if np.isnan(rank) else f"{rank:.0f}%",
          help="Share of earlier years with less burning in the same days")
m4.metric("Typical peak month",
          pycal.month_name[peak_m] if peak_m else "–",
          help="Month with the highest median activity")

# -------------------------------------------------------------------- map
section("Choose your area",
        "Draw a rectangle on the map, or type coordinates in the sidebar. "
        "Bright patches show where burning concentrates.")
if HAS_MAP:
    s, w, n, e = bbox
    fmap = folium.Map(location=[(s + n) / 2, (w + e) / 2], zoom_start=6,
                      tiles="CartoDB dark_matter")
    folium.Rectangle([[s, w], [n, e]], color=ACCENT, weight=2,
                     fill=False).add_to(fmap)
    in_years = sel[sel["local_date"].dt.year.between(*years)]
    heat = (in_years.groupby(["cell_lat", "cell_lon"]).size()
            .nlargest(4000).reset_index(name="n"))
    if len(heat):
        heat["n"] = heat["n"] / heat["n"].max()
        HeatMap(heat.values.tolist(), radius=9, blur=12,
                min_opacity=.25).add_to(fmap)
    Draw(draw_options={"polyline": False, "polygon": False, "circle": False,
                       "marker": False, "circlemarker": False,
                       "rectangle": True},
         edit_options={"edit": False}).add_to(fmap)
    result = st_folium(fmap, height=440, use_container_width=True,
                       returned_objects=["last_active_drawing"])
    drawing = (result or {}).get("last_active_drawing")
    if drawing:
        ring = drawing["geometry"]["coordinates"][0]
        lons, lats = [p[0] for p in ring], [p[1] for p in ring]
        drawn = (min(lats), min(lons), max(lats), max(lons))
        st.button("Use the drawn area", on_click=apply_drawn, args=(drawn,))
else:
    st.caption("Install folium and streamlit-folium to draw the area on a map.")

# --------------------------------------------------------------- calendar
section("The burning calendar",
        "Each cell is one month. Brighter means more harmonized fire-days: "
        "grid cells with at least one detection, counted per day.")
view = st.radio("View", ["Activity", "Difference from that month's median"],
                horizontal=True, label_visibility="collapsed")
if view == "Activity":
    z, scale, zmid, unit = cal.values, "Inferno", None, "fire-days"
else:
    base = cal.median().replace(0, np.nan)
    z = (100 * (cal / base - 1)).values
    scale, zmid, unit = "PuOr_r", 0, "% vs median"
fig = go.Figure(go.Heatmap(
    z=z, x=MONTHS, y=cal.index.astype(str), colorscale=scale, zmid=zmid,
    xgap=3, ygap=3, hoverongaps=False, colorbar=dict(title=unit),
    hovertemplate="%{x} %{y}<br>%{z:,.0f} " + unit + "<extra></extra>"))
fig.update_yaxes(autorange="reversed", dtick=1)
st.plotly_chart(style(fig, height=max(420, 24 * len(cal) + 80)))
st.caption(f"Empty cells = no satellite observation, not zero fire. "
           f"The latest month is partial (data to {last_day:%d %b %Y}). "
           f"Before VIIRS began, MODIS counts are scaled to VIIRS-equivalent.")

# ---------------------------------------------------- this month vs history
section("This month against history",
        f"Fire-days for {label} in every year, so a partial month is "
        "compared like for like.")
colors = [ACCENT if y == cur_year else "#5b5b66" for y in mtd.index]
fig = go.Figure(go.Bar(x=mtd.index, y=mtd["fire_days"], marker_color=colors,
                       hovertemplate="%{x}: %{y:,.0f} fire-days<extra></extra>"))
if not np.isnan(median):
    fig.add_hline(y=median, line_dash="dash", line_color="#f5f5f7",
                  annotation_text="historical median")
st.plotly_chart(style(fig, 380))

# ------------------------------------------------------------ validation
section("Can you trust it?",
        "Raw counts jump when VIIRS begins, because its pixels are smaller "
        "and it sees more small fires. The harmonized line should not.")
annual = monthly.groupby(monthly.index.year).sum(min_count=12)
h_month = harm["harmonized"].resample("MS").sum(min_count=1)
h_annual = h_month.groupby(h_month.index.year).agg(
    lambda s: s.sum() if s.notna().sum() == 12 else np.nan)
fig = go.Figure()
fig.add_scatter(x=annual.index, y=annual["MODIS"], name="MODIS raw",
                line=dict(color="#6ea8fe", dash="dot"))
fig.add_scatter(x=annual.index, y=annual["VIIRS"], name="VIIRS raw",
                line=dict(color="#c9c9cf", dash="dot"))
fig.add_scatter(x=h_annual.index, y=h_annual, name="Harmonized",
                line=dict(color=ACCENT, width=4))
fig.update_yaxes(title="fire-days per year")
st.plotly_chart(style(fig, 420))

v1, v2 = st.columns(2)
with v1:
    st.markdown("**Held-out year test** (fit on other years, predict this one)")
    if len(summary):
        st.dataframe(summary.rename(index={
            "simple": "Simple ratio", "monthly": "Ratio by month"}).round(1))
        st.caption("WAPE = total absolute monthly error ÷ total observed. "
                   "Lower is better.")
with v2:
    st.markdown("**Jump test** (3 years after VIIRS began ÷ 3 years before)")
    if steps is not None:
        st.dataframe(steps.round(2).to_frame("ratio"))
        st.caption("MODIS watched both periods with one instrument, so its "
                   "ratio is the real change. Harmonized should match it.")
with st.expander("Scaling factors k used (VIIRS ≈ k × MODIS)"):
    st.dataframe(k.rename(index=dict(enumerate(MONTHS, 1)))
                  .round(2).to_frame("k").T)

# -------------------------------------------------------- caveats + export
section("Know the limits")
st.markdown("""
<div class="caveat">
<b>Fewer detections does not prove less burning.</b> These satellites pass
in the early afternoon and at night. Fires lit after the afternoon pass can
be missed, so a fall in counts may reflect a change in burning time.<br><br>
<b>Recent months use near-real-time data</b>, which NASA later replaces with
science-quality data. Recent values can change slightly.<br><br>
<b>Fire-days are an activity index</b>, not burned area or a count of
individual fires.
</div>""", unsafe_allow_html=True)

section("Take the data with you")
d1, d2, d3 = st.columns(3)
export = pd.DataFrame({
    "harmonized_fire_days": h_month, "modis_raw": monthly["MODIS"],
    "viirs_raw": monthly["VIIRS"]}).rename_axis("month")
d1.download_button("Monthly calendar (CSV)", export.to_csv().encode(),
                   "burning_calendar_monthly.csv", "text/csv")
d2.download_button("Daily series (CSV)",
                   harm.rename_axis("date").to_csv().encode(),
                   "burning_calendar_daily.csv", "text/csv")
d3.download_button("Hotspot cell-days in area (CSV)",
                   sel.to_csv(index=False).encode(),
                   "hotspot_cell_days.csv", "text/csv")
st.caption("Charts: hover a chart and use the camera icon to save a PNG.")

st.markdown("""<div class="section"><p style="font-size:.9rem">
Data: NASA FIRMS active fire products, MODIS Collection 6.1 and VIIRS 375 m.
We acknowledge the use of data from NASA's Fire Information for Resource
Management System (FIRMS), part of NASA's Earth Science Data and Information
System (ESDIS). Parts of this app's code were drafted with an AI assistant
(Claude) and reviewed by the team.</p></div>""", unsafe_allow_html=True)
