# Burning Activity Calendar

NASA Space Apps Challenge 2026, "Harmonization of MODIS and VIIRS Hot Spots".

A web app that turns MODIS and VIIRS active fire hotspots from NASA FIRMS
into one consistent burning calendar for a chosen area.

## Run it

```
pip install -r requirements.txt

# 1. get the data (free MAP_KEY: https://firms.modaps.eosdis.nasa.gov/api/map_key/)
#    PowerShell:  $env:FIRMS_MAP_KEY = "your key"
#    macOS/Linux: export FIRMS_MAP_KEY="your key"
python fetch_firms.py                  # Punjab & Haryana, 2001 to today -> raw/
#    (or put FIRMS Archive Download CSVs in raw/ instead)

# 2. compact the data for the app
python prepare.py "raw/*.csv"          # writes data/cell_days.csv.gz

# 3. build the website data and preview it
python build_site.py                   # writes docs/data/
cd docs && python -m http.server 8000  # open http://localhost:8000

# (optional) the Streamlit version
streamlit run app.py
```

### Website (GitHub Pages)

The `docs/` folder is a static site: an animated hero of a year of fire,
a scroll story of the MODIS-to-VIIRS join, and an explorer where you drag
an area on the map to get its burning calendar, this month against
history, validation figures and CSV downloads. All harmonization runs in
the browser (`docs/engine.js`, a port of `harmonize.py`; run
`python tests/engine_parity.py` to check both give identical numbers).

To publish: commit `docs/data/` after running `build_site.py`, then on
GitHub go to Settings > Pages and serve from the `main` branch, `/docs`
folder.

`fetch_firms.py` runs six requests at once and stays under the API limit
of 5,000 transactions per 10 minutes (one per day of data), so a 20-year
download takes about 30-40 minutes. NOAA-20 is fetched from 2026 only,
because the app needs it only after S-NPP ended; add
`--noaa20-start 2018-04-01` for its full record. If the script stops, run
it again; finished chunks are cached in `raw/api_cache/`. Never commit
your MAP_KEY.

To deploy, push this folder (including `data/cell_days.csv.gz`) to a public
GitHub repository and point Streamlit Community Cloud at `app.py`.

## Method

1. **Clean.** MODIS confidence 30 or above, VIIRS nominal or high, vegetation
   fires only (where the `type` column exists), UTC converted to local date.
2. **Fire-days per grid cell.** A 0.1° cell counts once per day if it has at
   least one detection. This removes duplicate detections and much of the
   pixel-size difference.
3. **One VIIRS satellite at a time.** S-NPP while it exists, NOAA-20 after,
   so adding satellites in 2018 and 2023 creates no jump.
4. **Calibrate on the overlap.** VIIRS ≈ k × MODIS, with either one k or one
   k per calendar month, fitted on months both instruments observed.
5. **Convert the history.** MODIS-only years are scaled to VIIRS-equivalent.
6. **Validate.** Leave-one-year-out error for each method, and a jump test
   comparing the years either side of the VIIRS start.

## Files

| File | Purpose |
|---|---|
| `fetch_firms.py` | Downloads MODIS and VIIRS hotspots for an area from the FIRMS API |
| `harmonize.py` | All data and harmonization logic |
| `prepare.py` | Raw FIRMS CSVs to a compact cell-day file |
| `build_site.py` | Exports data for the website to `docs/data/` |
| `docs/` | Website: `index.html`, `app.js`, `engine.js` (harmonization), `viz.js` (charts), `map.js` (explorer map), `globe.js` (hero globe) |
| `app.py` | Streamlit app (alternative interface) |
| `tests/make_synthetic.py` | Synthetic data for code testing only |

## Data and credits

- NASA FIRMS active fire data: MODIS Collection 6.1 and VIIRS 375 m
  (S-NPP, NOAA-20). https://firms.modaps.eosdis.nasa.gov/
- Libraries: Streamlit, pandas, NumPy, Plotly, Folium, streamlit-folium.
- Website: Natural Earth land outlines (public domain) via the world-atlas package on jsDelivr; base map tiles © OpenStreetMap contributors © CARTO; Instrument Sans font (Google Fonts, SIL Open Font License).
- TODO: list every other dataset, library and reference you use.

## Use of AI

Code in this repository was drafted with Claude (Anthropic) and reviewed,
tested and adapted by the team. TODO: describe where and how, to match your
submission form. No AI-generated data is used in the results; the synthetic
generator in `tests/` exists only to test the code.

## Licence

TODO: choose an open-source licence (Space Apps applies Apache 2.0 if you
choose none).
