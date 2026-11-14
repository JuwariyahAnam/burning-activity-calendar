# Burning Activity Calendar

NASA Space Apps Challenge 2026, "Harmonization of MODIS and VIIRS Hot Spots".

A web app that turns MODIS and VIIRS active fire hotspots from NASA FIRMS
into one consistent burning calendar for a chosen area.

## Run it

```
pip install -r requirements.txt

# 1. put your FIRMS CSV downloads (MODIS and VIIRS) in raw/
python prepare.py "raw/*.csv"          # writes data/cell_days.csv.gz

# 2. start the app
streamlit run app.py
```

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
| `harmonize.py` | All data and harmonization logic |
| `prepare.py` | Raw FIRMS CSVs to a compact cell-day file |
| `app.py` | Streamlit app |
| `tests/make_synthetic.py` | Synthetic data for code testing only |

## Data and credits

- NASA FIRMS active fire data: MODIS Collection 6.1 and VIIRS 375 m
  (S-NPP, NOAA-20). https://firms.modaps.eosdis.nasa.gov/
- Libraries: Streamlit, pandas, NumPy, Plotly, Folium, streamlit-folium.
- TODO: list every other dataset, library and reference you use.

## Use of AI

Code in this repository was drafted with Claude (Anthropic) and reviewed,
tested and adapted by the team. TODO: describe where and how, to match your
submission form. No AI-generated data is used in the results; the synthetic
generator in `tests/` exists only to test the code.

## Licence

TODO: choose an open-source licence (Space Apps applies Apache 2.0 if you
choose none).
