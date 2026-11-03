import glob, sys, json, re
sys.path.insert(0, "docs"); import gen_flow_svg as G
from playwright.sync_api import sync_playwright
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))
d = json.load(open("docs/diagrams/setup-map.json"))
VIEWS = [("cable", "0a", "portfwd", "buy"), ("cable", "0a", "ipv6", "duckdns"), ("wifi", "0d", "portfwd", "duckdns"), ("usb", "0c", "ipv6", "buy"), ("vm", None, "ipv6", "duckdns"), ("vm", None, "portfwd", "buy"),
         ("cable", "0a", "tailscale", None), ("cable", "0a", "cloudflare", "buy"), ("usb", "0c", "cloudflare", "trycf"), ("vm", None, "tailscale", None)]   # FR122
nums = lambda s: [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?(?:e-?\d+)?", s)]
close = lambda a, b, tol: len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))
bad = 0
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1400, "height": 800}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    for V in VIEWS:   # FR139: (method, net, reach, name[, scenario]) — a Tailscale view is in a scenario (first by default)
        m, n, r, nm = V[:4]; scn = V[4] if len(V) > 4 else ("first" if r in ("tailscale", "ipv6") else None)   # (FR143: an IPv6 view is in a scenario too)
        st = {"method": m, "net": n, "reach": r, "name": nm, **({"scenario": scn} if scn else {})}
        h = f"setup-map;method={m}" + (f";net={n}" if n else "") + f";reach={r}" + (f";name={nm}" if nm else "") + (f";scenario={scn}" if scn else "")
        pg.goto("about:blank"); pg.goto(f"http://localhost:8099/flow.html#{h}", wait_until="networkidle"); pg.wait_for_timeout(300)
        js = pg.evaluate("""() => { const g = [...document.querySelectorAll('.node')].find(x => x.querySelector('g[transform^="translate"] .pb-still'));
          const root = g && g.querySelector('g[transform^="translate"]');
          const mot = [...document.querySelectorAll('.pb-lights animateMotion')].map(a => [a.getAttribute('path'), a.getAttribute('keyTimes'), a.getAttribute('keyPoints'), a.getAttribute('dur')]);
          const glow = [...document.querySelectorAll('.pb-lights > circle')].map(c => [c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r')].join(' '));
          return { id: g && g.getAttribute('data-id'), root: root && root.getAttribute('transform'), mot, glow }; }""")
        G.default_state = lambda t, st=st: st
        svg = G.render(d)
        pr = re.search(r'<g class="phonebook">.*?<g transform="(translate\([^"]+)">', svg)
        pm = re.findall(r'<animateMotion dur="([\d.]+)s" repeatCount="indefinite" path="([^"]+)" keyPoints="([^"]+)" keyTimes="([^"]+)"', svg)
        pm = [(pa, kt, kp, du) for du, pa, kp, kt in pm if not pa.startswith("M ") or True]
        pg_glow = re.findall(r'<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)" fill="#fff3a0"', svg)
        # only the book's motions (the USB stick + gatehouse use animateMotion too): match by count of book lights
        book_m = [x for x in pm if x[3] in ("9", "10.6")]
        ok_root = js["root"] and pr and close(nums(js["root"]), nums(pr.group(1)), 0.06)
        jm = [x for x in js["mot"] if x[3] in ("9s", "10.6s")]
        ok_mot = len(jm) == len(book_m) and all(close(nums(a[0]), nums(b_[0]), 0.06) and close(nums(a[1]), nums(b_[1]), 0.0011) and close(nums(a[2]), nums(b_[2]), 0.0011) for a, b_ in zip(jm, book_m))
        ok_glow = close([v for x in js["glow"] for v in nums(x)], [float(v) for t in pg_glow for v in t], 0.06)
        bad += (not ok_root) + (not ok_mot) + (not ok_glow)
        print(f"{h}: book {js['id']} root {'match' if ok_root else 'MISMATCH ' + str(js['root']) + ' vs ' + str(pr and pr.group(1))} | lights {len(jm)} {'match' if ok_mot else 'MISMATCH'} | glow {'match' if ok_glow else 'MISMATCH ' + str(js['glow']) + str(pg_glow)}")
        if not ok_mot:
            for a, b_ in zip(jm, book_m): print("   js", a[0][:90], a[1], "\n   py", b_[0][:90], b_[1])
    print("page errors:", errs, "| total problems:", bad); b.close()
