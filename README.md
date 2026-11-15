# Burning Activity Calendar

NASA Space Apps Challenge 2026, "Harmonization of MODIS and VIIRS Hot Spots".

Team: Juwariyah Anam, Suhani Koul, Deepankar Anand, Riya Rajesh.
Live site: https://juwariyahanam.github.io/burning-activity-calendar/
Demo (7 slides, PDF): https://juwariyahanam.github.io/burning-activity-calendar/demo.pdf

A web app that turns MODIS and VIIRS active fire hotspots from NASA FIRMS
into one consistent burning calendar for a chosen area.

What it offers, for any study area, district or drawn rectangle:

- **The burning calendar**: harmonized fire-days for every month since 2001
  (2008 for the newer areas), as activity or against the usual level.
- **This month and the next two weeks**: the month so far against earlier
  years, what the coming 14 days usually bring, how the last 14 days compare
  and how far the current season usually is by this date.
- **A typical year and its critical periods**: the usual level and range for
  each day of the year, with this year (and any other) on top.
- **Season timing**: for each year, when 10%, 50% and 90% of each season's
  burning had happened, with trend tests (Theil-Sen slope, Mann-Kendall).
- **Districts**: this month against usual and the long-term trend per district,
  with close-up maps of fire locations and intensity.
- **Burning more than usual**: districts far above their usual level in the last
  7, 14 or 30 days, outlined on the map, with a daily RSS feed
  (`docs/data/alerts.xml`), a JSON file per area and a link to NASA FIRMS email
  alerts for the same area.
- **Compare two places**: any two areas or districts side by side, per 1,000 km².
- **Validation**: held-out-year error and a jump test at the 2012 switch.
- **Data out**: seven CSV downloads, a link that reopens the exact view, and a
  citation with the FIRMS product DOIs.

## Run it

```
pip install -r requirements.txt

# 1. get the data (free MAP_KEY: https://firms.modaps.eosdis.nasa.gov/api/map_key/)
#    PowerShell:  $env:FIRMS_MAP_KEY = "your key"
#    macOS/Linux: export FIRMS_MAP_KEY="your key"
python fetch_firms.py --region all     # every study area in regions.json -> raw/...
#    (or one: --region madhya-pradesh)

# 2. compact the data
python prepare.py --region all         # -> data/<area>/cell_days.csv.gz

# 3. build the website data and preview it
python build_site.py --region all      # -> docs/data/<area>/ and docs/data/regions.json
cd docs && python -m http.server 8000  # open http://localhost:8000

# (optional) the Streamlit version
streamlit run app.py
```

### Study areas

`regions.json` lists them: Punjab & Haryana (2001 onward), western Uttar
Pradesh, Madhya Pradesh, Mizoram & Manipur, Uttarakhand, Odisha &
Chhattisgarh, and Assam & neighbours (Assam, Meghalaya, Nagaland, Tripura)
(2008 onward). `--region` takes one slug, several separated by commas, or
`all`.
Each has a bounding box, the states it covers and a one-line story. Add an
area there and run the three commands with `--region <slug>`. The site shows
a pin and a chip for every built area; `?region=<slug>` opens one directly.

### Website (GitHub Pages)

The `docs/` folder is a static site: a WebGL Earth (NASA Blue Marble) with
the four satellites in orbit; click it to fly to the study area, where states
and districts are outlined and fires glow red, and click any place for a
close-up map. Then a scroll story of the MODIS-to-VIIRS join, and an explorer where you drag
an area on the map to get its burning calendar, this month against
history, validation figures and CSV downloads. Clicking a district opens a
close-up map with red dots where fires were detected, coloured by fire
intensity (mean fire radiative power) and sized by number of detections;
`build_site.py` builds it from the raw FIRMS files in `raw/`. All harmonization runs in
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

## Running it for real

The site is static, so any web host works; GitHub Pages is free.

**Keep it current.** `update.py` downloads the latest near-real-time fires for
every area, merges them into `data/<area>/cell_days.csv.gz` and rebuilds
`docs/data/`. A daily run costs about 50 FIRMS transactions per area.

```
python update.py                  # all areas, last 21 days (or since the data ends)
```

Run it daily on your own machine (Windows Task Scheduler or cron), or let
GitHub do it: `.github/workflows/update.yml` runs every morning, rebuilds the
data and publishes the site, without committing anything. It is off until you:

1. commit `data/<area>/cell_days.csv.gz` and `docs/data/` for every area;
2. add the secret `FIRMS_MAP_KEY` and the variable `AUTO_UPDATE` = `true`
   (Settings > Secrets and variables > Actions);
3. set Settings > Pages > Source to **GitHub Actions**.

If FIRMS is down, the workflow publishes the last good data. The page shows
how old its newest data is and warns when it is more than 3 days old.

**Every few months** NASA replaces near-real-time data with science-quality
data. Re-run `fetch_firms.py --region all` and `prepare.py --region all`,
then commit the new cell-day files.

**Add an area** in `regions.json` (bounding box, states, start year, a one-line
story), then run the three commands in "Run it" with `--region <slug>`.

**Be clear about what it is.** It is an activity index from satellite
detections, not burned area and not an official warning service; the page
says so, and lists what the record can't tell you.

The Streamlit version (`app.py`) can be deployed on Streamlit Community
Cloud from the same repository.

## Method

1. **Clean.** MODIS confidence 30 or above, VIIRS nominal or high, vegetation
   fires only (where the `type` column exists), UTC converted to local date.
2. **Fire-days per grid cell.** A 0.1° cell counts once per day if it has at
   least one detection. This removes duplicate detections and much of the
   pixel-size difference.
3. **One VIIRS satellite at a time.** S-NPP while it exists, NOAA-20 after,
   so adding satellites in 2018 and 2023 creates no jump. S-NPP stopped on
   2 November 2026. Over January to October 2026, when both flew, NOAA-20
   counted 7-12% more fire-days than S-NPP in every study area (same-month
   error 8-12%), so after the handover NOAA-20 fire-days are scaled by S-NPP /
   NOAA-20 over that overlap (`n20Scale` in each area's `meta.json`: 0.90 to
   0.94). Without it the record would step up by about 10% at the handover and
   flag districts that are not unusual.
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
| `boundaries.py` | State and district boundaries for the website (geoBoundaries) |
| `regions.json`, `regions.py` | The study areas and a helper to read them |
| `update.py` | Daily refresh: latest near-real-time fires, merged and rebuilt |
| `tools/stamp_version.py` | Run after changing the website's scripts: gives them a new version so browsers do not mix old and new files |
| `alerts.py` | Districts far above usual, written as `alerts.json` per area and an RSS feed |
| `.github/workflows/update.yml` | Optional daily update and publishing on GitHub |
| `docs/` | Website: `index.html`, `app.js`, `engine.js` (harmonization), `viz.js` (charts), `map.js` (explorer map), `globe3d.js` (WebGL hero globe), `minimap.js` (place close-ups), `hotspots.js` (fire dots), `season.js` (typical year, outlook, season timing, trends) |
| `app.py` | Streamlit app (alternative interface) |
| `tests/make_synthetic.py` | Synthetic data for code testing only |

## Data and credits

- NASA FIRMS active fire data: MODIS Collection 6.1 and VIIRS 375 m
  (S-NPP, NOAA-20). https://firms.modaps.eosdis.nasa.gov/
- State and district boundaries: geoBoundaries (Runfola, D. et al. 2020, PLOS ONE
  15(4): e0231866), India ADM1/ADM2 simplified, Open Database License. Downloaded by
  `build_site.py` (cached in `data/boundaries/`); shown for reference only.
- Libraries: Streamlit, pandas, NumPy, Plotly, Folium, streamlit-folium.
- Website: NASA Blue Marble Earth imagery (public domain, colour-graded, with generated clouds) via the three-globe package on jsDelivr; Natural Earth land outlines (public domain, fallback) via the world-atlas package; Instrument Sans font (Google Fonts, SIL Open Font License).
- Methods: Theil-Sen slope (Sen 1968, JASA 63: 1379-1389) and Mann-Kendall
  trend test (Mann 1945; Kendall 1975) for the season and district trends.
- Fire products: Giglio, Schroeder and Justice (2016), Remote Sensing of
  Environment 178: 31-41 (MODIS C6); Schroeder et al. (2014), Remote Sensing of
  Environment 143: 85-96 (VIIRS 375 m).
- Email alerts and the live fire map linked from the site are NASA FIRMS services.

## Use of AI

The challenge set the idea: a harmonized burning calendar from MODIS and
VIIRS hotspots. The team chose the study areas, the design direction, the
features and the calibration method (one scaling factor per calendar month,
picked from the validation results: 14.1% held-out monthly error against 21.1%
for a single factor in Punjab & Haryana), and ran and checked every step on the
real data.

Claude (Anthropic), an AI assistant, drafted most of the code (download,
cleaning, harmonization, validation, website), the documentation and the
on-page text, following the team's instructions; the team reviewed, tested
and adapted it. Files drafted this way say so in a comment at the top. No
AI-generated data is used in the results: every number comes from NASA FIRMS
detections. The synthetic generator in `tests/` exists only to test the code.

## Licence

The code is released under the MIT License (see `LICENSE`). The data keeps
its own terms: NASA FIRMS data under NASA's open data policy, and the
geoBoundaries outlines under the Open Database License.
