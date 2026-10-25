#!/usr/bin/env python3
"""shot_flow.py — screenshot the LIVE flow.html editor at a specific toggle state (flow_requirements.md
FR67). The committed docs/diagrams/*.svg snapshots only render the DEFAULT toggle state, so they are NOT
the right artefact for reviewing toggle-dependent behaviour. This drives the real page via Playwright.

Prereq: `./dash serve 8099` running; Playwright chromium available.
Usage:
    python3 tools/shot_flow.py 'setup-map;method=cable;net=0a;reach=portfwd' /tmp/pf.png
    python3 tools/shot_flow.py 'tunnels;show=direct' /tmp/direct.png [PORT]
The hash is everything after the '#': "<diagram-id>[;<toggleId>=<value>]...".
"""
import glob
import sys

from playwright.sync_api import sync_playwright

if len(sys.argv) < 3:
    sys.exit(__doc__)
HASH, OUT = sys.argv[1], sys.argv[2]
PORT = sys.argv[3] if len(sys.argv) > 3 else "8099"
URL = f"http://localhost:{PORT}/flow.html#{HASH}"

# prefer a nix-store playwright chromium if the default download isn't present
cands = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))

with sync_playwright() as p:
    kw = {"args": ["--no-sandbox", "--force-color-profile=srgb"]}
    if cands:
        kw["executable_path"] = cands[0]
    b = p.chromium.launch(**kw)
    pg = b.new_page(viewport={"width": 1600, "height": 900}, device_scale_factor=2)
    pg.goto(URL, wait_until="networkidle")
    pg.wait_for_timeout(900)
    try:
        pg.click("#fit", timeout=2000)      # frame the whole diagram
        pg.wait_for_timeout(400)
    except Exception as e:
        print("fit skipped:", e)
    pg.screenshot(path=OUT)
    b.close()
print("wrote", OUT)
