import glob
from playwright.sync_api import sync_playwright
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1400, "height": 800}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:8099/flow.html#setup-map;method=cable;net=0a;reach=tailscale", wait_until="networkidle"); pg.wait_for_timeout(400)
    pg.keyboard.down("Shift"); pg.wait_for_timeout(500)
    print(pg.evaluate("() => document.getElementById('status').textContent")); pg.keyboard.up("Shift")
    print("page errors:", errs); b.close()
