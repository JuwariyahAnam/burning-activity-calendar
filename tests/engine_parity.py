"""
Parity test: harmonize.py (Python) vs docs/engine.js (browser).

Builds synthetic data, exports it the way the site does, computes reference
numbers in Python, then runs the JavaScript engine on the same data.
Run from the repository root:  python tests/engine_parity.py
Needs Node.js.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import harmonize as hz  # noqa: E402

CASES = [
    {"bbox": [27.6, 73.8, 32.6, 77.6], "method": "monthly"},
    {"bbox": [27.6, 73.8, 32.6, 77.6], "method": "simple"},
    {"bbox": [30.0, 75.0, 31.0, 76.2], "method": "monthly", "aquaOnly": True},
    {"bbox": [29.5, 74.5, 31.5, 76.5], "method": "monthly", "viirsAll": True},
]


def nan(x):
    return None if pd.isna(x) else float(x)


def main():
    tmp = Path(tempfile.mkdtemp())
    raw = tmp / "raw"
    run = lambda *a: subprocess.run([sys.executable, *a], cwd=ROOT, check=True,
                                    capture_output=True, text=True)
    run("tests/make_synthetic.py", str(raw))
    run("prepare.py", f"{raw}/*.csv", "--out", str(tmp / "cd.csv.gz"))
    run("build_site.py", "--data", str(tmp / "cd.csv.gz"), "--out", str(tmp / "site"),
        "--sample")
    cd = pd.read_csv(tmp / "cd.csv.gz", parse_dates=["local_date"])
    cov = hz.coverage(cd)

    ref = {"cases": []}
    for c in CASES:
        sel = hz.select(cd, tuple(c["bbox"]),
                        modis_sats=("Aqua",) if c.get("aquaOnly") else ("Terra", "Aqua"),
                        viirs_mode="all" if c.get("viirsAll") else "reference")
        daily = hz.daily_counts(sel, cov)
        monthly = hz.monthly_counts(daily)
        k = hz.fit_ratios(monthly, c["method"])
        harm = hz.harmonize_daily(daily, k)
        cal = hz.calendar(harm)
        mtd = hz.month_to_date(harm)
        summary, _ = hz.loyo_validation(monthly)
        steps = hz.step_check(monthly, k)
        ref["cases"].append({
            "opts": c,
            "monthly": [{"key": f"{i.year}-{i.month}", "MODIS": nan(r.MODIS),
                         "VIIRS": nan(r.VIIRS)} for i, r in monthly.iterrows()],
            "k": [float(k[m]) for m in range(1, 13)],
            "calendar": {str(y): [nan(v) for v in row] for y, row in cal.iterrows()},
            "mtd": {str(y): float(v) for y, v in mtd["fire_days"].items()},
            "summary": {m: {"wape": float(r["monthly WAPE %"]),
                            "bias": float(r["annual bias %"])}
                        for m, r in summary.iterrows()},
            "steps": {"modisOnly": float(steps.iloc[0]), "rawSplice": float(steps.iloc[1]),
                      "harmonized": float(steps.iloc[2])},
        })
    (tmp / "ref.json").write_text(json.dumps(ref))
    r = subprocess.run(["node", "tests/engine_parity.mjs", str(tmp / "site"),
                        str(tmp / "ref.json")], cwd=ROOT, text=True, capture_output=True)
    print(r.stdout, r.stderr)
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
