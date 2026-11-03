import glob, sys, json, re
sys.path.insert(0, "docs"); import gen_flow_svg as G
from playwright.sync_api import sync_playwright
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))
d = json.load(open("docs/diagrams/setup-map.json"))
VIEWS = [("cable", "0a", "tailscale", None, "restore"), ("vm", None, "tailscale", None, "restore"), ("cable", "0a", "portfwd", "buy"), ("cable", "0a", "ipv6", "buy"), ("cable", "0a", "ipv6", "duckdns"), ("cable", "0a", "tailscale", None),
         ("cable", "0a", "cloudflare", "buy"), ("cable", "0a", "onion", None), ("wifi", "0d", "portfwd", "duckdns"), ("usb", "0c", "cloudflare", "trycf"),
         ("vm", None, "tailscale", None), ("vm", None, "cloudflare", "buy"), ("vm", None, "ipv6", "duckdns")]   # FR122: + the VM views
P = lambda s: [(float(a), float(b)) for a, b in re.findall(r"(-?[\d.]+)[ ,](-?[\d.]+)", s.replace("M", " ").replace("L", " "))]
bad = 0
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1400, "height": 800}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    for V in VIEWS:   # FR139: (method, net, reach, name[, scenario]) — a Tailscale view is in a scenario (first by default)
        m, n, r, nm = V[:4]; scn = V[4] if len(V) > 4 else ("first" if r == "tailscale" else None)
        st = {"method": m, "net": n, "reach": r, "name": nm, **({"scenario": scn} if scn else {})}
        pg.goto("about:blank"); pg.goto(f"http://localhost:8099/flow.html#setup-map;method={m}" + (f";net={n}" if n else "") + f";reach={r}" + (f";name={nm}" if nm else "") + (f";scenario={scn}" if scn else ""), wait_until="networkidle"); pg.wait_for_timeout(300)
        js = pg.evaluate("() => Object.fromEntries([...document.querySelectorAll('#edges > .edge, .front-edges > .edge')].map(g => [g.getAttribute('data-edge'), g.querySelector('.hit') && g.querySelector('.hit').getAttribute('d')]).filter(x => x[1]))")
        jw = pg.evaluate("() => [...document.querySelectorAll('#under rect')].map(r => ['x','y','width','height'].map(k => +(+r.getAttribute(k)).toFixed(1)))")
        got = {}; op = G.pipe_poly
        def cap(a, b_, e, vb=None, _op=op):
            r_ = _op(a, b_, e, vb); got[e["id"]] = G._dedupe(r_); return r_
        G.pipe_poly = cap; G.default_state = lambda t, st=st: st; svg = G.render(d); G.pipe_poly = op
        pw = [[float(v) for v in t] for t in re.findall(r'<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)" rx="[-\d.]+" fill="#0b0e14" stroke="#6e7681"', svg)]
        jl = pg.evaluate("() => [...document.querySelectorAll('.edge[data-edge]:not(.gatehouse)')].map(g => [g.getAttribute('data-edge'), g.querySelector(':scope > text')]).filter(x => x[1] && ['e_ts_up','e_cf_up','e_tor_up','e_pf_b','e_v6'].includes(x[0])).map(([id, t]) => [t.textContent, +(+t.getAttribute('x')).toFixed(1), +(+t.getAttribute('y')).toFixed(1), t.getAttribute('text-anchor')])")
        pl = [[t, float(x), float(y), a] for x, y, a, t in re.findall(r'<text x="([-\d.]+)" y="([-\d.]+)" text-anchor="(\w+)" font-size="11"[^>]*>([^<]*)</text>', svg)]
        lab_bad = [l for l in jl if not any(l[0] == q[0] and abs(l[1] - q[1]) <= 0.06 and abs(l[2] - q[2]) <= 0.06 and l[3] == q[3] for q in pl)]
        bad += len(lab_bad)
        print("   labels:", jl, "MISMATCH" if lab_bad else "match")
        # FR127: a picture on an icon's screen sits on the same spot in the editor and the SVG
        ji = pg.evaluate("() => [...document.querySelectorAll('.node[data-id] image.nscreen')].map(i => [i.getAttribute('href').slice(0, 30), ...['x','y','width','height'].map(k => +(+i.getAttribute(k)).toFixed(1))])")
        pi = [[h[:30], float(x), float(y), float(w), float(hh)] for h, x, y, w, hh in re.findall(r'<image href="([^"]+)" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)" preserveAspectRatio', svg)]
        img_ok = len(ji) == len(pi) and all(a[0] == b[0] and all(abs(u - v) <= 0.11 for u, v in zip(a[1:], b[1:])) for a, b in zip(ji, pi))
        bad += not img_ok
        print("   screen pictures:", len(ji), "match" if img_ok else f"MISMATCH js={ji} py={pi}")
        mism = []
        for eid, dd in js.items():
            a_, b2 = G._dedupe(P(dd)), got.get(eid)
            if b2 is None or len(a_) != len(b2) or any(abs(x - u) > 0.06 or abs(y - v) > 0.06 for (x, y), (u, v) in zip(a_, b2)): mism.append(eid)
        wins_ok = len(jw) == len(pw) and all(abs(x - u) <= 0.06 for a_, b2 in zip(jw, pw) for x, u in zip(a_, b2))
        bad += len(mism) + (0 if wins_ok else 1)
        print(f"{m}/{n}/{r}/{nm}: lines compared {len(js)}, mismatches {mism or 'none'} | gate windows {len(jw)} {'match' if wins_ok else f'MISMATCH js={jw} py={pw}'}")
    print("page errors:", errs, "| total problems:", bad); b.close()
