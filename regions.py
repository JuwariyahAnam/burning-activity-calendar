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


def site():
    """Public address of the website (for links in the alerts feed), or ''."""
    return json.loads(CONFIG.read_text(encoding="utf-8")).get("site", "")


def pick(slug):
    """Regions by slug: one, several separated by commas (in that order), or 'all'."""
    regions = load()
    if slug == "all":
        return regions
    by_slug = {r["slug"]: r for r in regions}
    wanted = [s.strip() for s in slug.split(",") if s.strip()]
    unknown = [s for s in wanted if s not in by_slug]
    if unknown or not wanted:
        names = ", ".join(r["slug"] for r in regions)
        raise SystemExit(f"Unknown region {', '.join(unknown) or slug!r}. Choose from: {names}, or all.")
    return [by_slug[s] for s in wanted]


def raw_dir(region):
    """Folder that holds a region's raw FIRMS CSVs (the raw glob without *.csv)."""
    return str(Path(region["raw"]).parent)
