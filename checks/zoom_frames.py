import glob, sys
from playwright.sync_api import sync_playwright
from PIL import Image
SP, view, tag, nid = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]; times = [float(t) for t in sys.argv[5].split(",")]
wheel = int(sys.argv[6]) if len(sys.argv) > 6 else 4
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1600, "height": 900}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.route("**/save**", lambda r: (errs.append("SAVE " + r.request.url), r.abort()))
    pg.goto(f"http://localhost:8099/flow.html#{view}", wait_until="networkidle"); pg.wait_for_timeout(500); pg.click("#fit"); pg.wait_for_timeout(300)
    r = pg.locator(f'.node[data-id="{nid}"] rect').first.bounding_box()
    cx, cy = r["x"] + r["width"] / 2, r["y"] + r["height"] / 2
    for i in range(wheel): pg.mouse.move(cx, cy); pg.mouse.wheel(0, -200); pg.wait_for_timeout(60)
    pg.wait_for_timeout(250)
    ims = []
    for t in times:
        pg.evaluate(f"() => {{ const s = document.getElementById('svg'); s.pauseAnimations(); s.setCurrentTime({t}); }}"); pg.wait_for_timeout(120)
        f = f"{SP}/{tag}-{t}.png"; bb = pg.locator(f'.node[data-id="{nid}"] rect').first.bounding_box(); pg.screenshot(path=f, clip={"x": max(0, bb["x"] - bb["width"] * 1.6), "y": max(125, bb["y"] - bb["height"] * 0.9), "width": min(1600, bb["width"] * 4.2), "height": min(770, bb["height"] * 2.6)}); ims.append(Image.open(f))
    print("errors:", errs); b.close()
W, H = ims[0].size; cols = 2; rows = (len(ims) + 1) // 2; s = Image.new("RGB", (W * cols, H * rows), "white")
for i, im in enumerate(ims): s.paste(im, ((i % cols) * W, (i // cols) * H))
s.resize((W * cols // 2, H * rows // 2)).save(f"{SP}/{tag}-strip.png")
