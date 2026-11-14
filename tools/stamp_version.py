"""
Give every script of the website a version in its address, so browsers never
mix a new page with old cached scripts (GitHub Pages caches for 10 minutes).
Run before committing website changes:  python tools/stamp_version.py

AI disclosure: drafted with Claude (Anthropic); review before use.
"""
import datetime as dt
import json
import re
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"
version = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M")
modules = sorted(p.name for p in DOCS.glob("*.js"))
imap = {"imports": {f"./{m}": f"./{m}?v={version}" for m in modules}}
block = ('<script type="importmap">\n' + json.dumps(imap, indent=1) + "\n</script>")
html = (DOCS / "index.html").read_text(encoding="utf-8")
html, n1 = re.subn(r'<script type="importmap">.*?</script>', block, html, flags=re.S)
if not n1:
    html = html.replace('<script type="module" src="app.js', block + '\n<script type="module" src="app.js', 1)
html, n2 = re.subn(r'<script type="module" src="app\.js[^"]*"></script>',
                   f'<script type="module" src="./app.js?v={version}"></script>', html)
(DOCS / "index.html").write_text(html, encoding="utf-8")
print(f"version {version}: {len(modules)} scripts")
