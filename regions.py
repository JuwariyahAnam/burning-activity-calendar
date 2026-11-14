"""
Read the study areas in regions.json.

AI disclosure: drafted with Claude (Anthropic); review before use.
"""
import json
import os
from pathlib import Path

# REGIONS_CONFIG lets tests use their own list
CONFIG = Path(os.environ.get("REGIONS_CONFIG", Path(__file__).with_name("regions.json")))


def load():
    return json.loads(CONFIG.read_text(encoding="utf-8"))["regions"]


def pick(slug):
    """One region by slug, or all of them for 'all'."""
    regions = load()
    if slug == "all":
        return regions
    found = [r for r in regions if r["slug"] == slug]
    if not found:
        names = ", ".join(r["slug"] for r in regions)
        raise SystemExit(f"Unknown region {slug!r}. Choose one of: {names}, or all.")
    return found


def raw_dir(region):
    """Folder that holds a region's raw FIRMS CSVs (the raw glob without *.csv)."""
    return str(Path(region["raw"]).parent)
