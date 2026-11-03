# frames.py <outdir> <hash> <tag> <t1,t2,…> → the whole fitted editor view, paused at each time; a 2-column strip
import glob, sys
from playwright.sync_api import sync_playwright
from PIL import Image
SP, view, tag = sys.argv[1], sys.argv[2], sys.argv[3]; times = [float(t) for t in sys.argv[4].split(",")]
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1600, "height": 1000}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.route("**/save**", lambda r: (errs.append("SAVE " + r.request.url), r.abort()))
    pg.goto(f"http://localhost:8099/flow.html#{view}", wait_until="networkidle"); pg.wait_for_timeout(500); pg.click("#fit"); pg.wait_for_timeout(300)
    clip = {"x": 0, "y": 120, "width": 1600, "height": 880}
    if len(sys.argv) > 5:   # zoom: <node-id> <wheel steps> → a 1100×700 window centred on that node
        r = pg.locator(f'.node[data-id="{sys.argv[5]}"]').first.bounding_box(); cx, cy = r["x"] + r["width"] / 2, r["y"] + r["height"] / 2
        for i in range(int(sys.argv[6])): pg.mouse.move(cx, cy); pg.mouse.wheel(0, -200); pg.wait_for_timeout(60)
        pg.wait_for_timeout(250); clip = {"x": max(0, cx - 550), "y": max(120, cy - 350), "width": 1100, "height": 700}
    t0 = pg.evaluate("() => { const a = document.querySelector('.actor [begin]'); return a ? parseFloat(a.getAttribute('begin')) : 0; }")   # FR128: times count from the step's start
    ims = []
    for t in times:
        pg.evaluate(f"() => {{ const s = document.getElementById('svg'); s.pauseAnimations(); s.setCurrentTime({t + t0}); }}"); pg.wait_for_timeout(120)
        f = f"{SP}/{tag}-{t}.png"; pg.screenshot(path=f, clip=clip); ims.append(Image.open(f))
    print("errors:", errs); b.close()
W, H = ims[0].size; cols = 2; rows = (len(ims) + 1) // 2; s = Image.new("RGB", (W * cols, H * rows), "white")
for i, im in enumerate(ims): s.paste(im, ((i % cols) * W, (i // cols) * H))
s.resize((W * cols // 2, H * rows // 2)).save(f"{SP}/{tag}-strip.png"); print(f"{SP}/{tag}-strip.png")
