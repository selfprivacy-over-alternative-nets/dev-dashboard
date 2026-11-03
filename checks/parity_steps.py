# parity_steps.py — FR124: per step of a view, the editor (localhost:8099) and the static renderer show the same boxes +
# lines, animate the runner alike (every animateMotion / animate / animateTransform in the .actor group: path, key
# points, key times, values, dur) and carry the same caption. Run from dev-dashboard. Never saves (aborts **/save**).
import glob, sys, json, re
sys.path.insert(0, "docs"); import gen_flow_svg as G
from playwright.sync_api import sync_playwright
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))
d = json.load(open("docs/diagrams/setup-map.json"))
VIEWS = [("cable", "0a", "tailscale", None, i) for i in range(6)] + [("cable", "0a", "tailscale", None, i, sc) for sc in ("reinstall", "restore") for i in range(3)] \
        + [("vm", None, "tailscale", None, i, "restore") for i in range(3)] + [("usb", "0c", "tailscale", None, 0, "restore"), ("wifi", "0d", "tailscale", None, 1, "reinstall")] + [("wifi", "0d", "tailscale", None, 0), ("wifi", "0d", "tailscale", None, 1), ("usb", "0c", "tailscale", None, 1),
         ("vm", None, "tailscale", None, 1), ("vm", None, "tailscale", None, 2), ("vm", None, "tailscale", None, 3),
         ("vm", None, "tailscale", None, 4), ("vm", None, "tailscale", None, 5), ("wifi", "0d", "tailscale", None, 5), ("usb", "0c", "tailscale", None, 5)]   # FR136: Jazz in every kind of view
VIEWS += [("cable", "0a", "ipv6", nm, i) for nm in ("duckdns", "buy") for i in range(7)] \
       + [("cable", "0a", "ipv6", nm, i, sc) for nm in ("duckdns", "buy") for sc, n in (("reinstall", 4), ("restore", 5)) for i in range(n)] \
       + [("wifi", "0d", "ipv6", "duckdns", 3), ("usb", "0c", "ipv6", "buy", 5), ("vm", None, "ipv6", "duckdns", 3), ("vm", None, "ipv6", "duckdns", 0, "restore")]   # FR141–FR144: the IPv6 stories
nums = lambda s: [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?(?:e-?\d+)?", s or "")]
def close(a, b, tol): return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))
ATTRS = ("attributeName", "path", "keyPoints", "keyTimes", "values", "dur", "type", "repeatCount", "fill", "begin")   # FR131: begin compared from the step's start
def py_anims(svg):
    m = re.search(r'<g class="actor".*', svg, re.S)
    if not m: return []
    blk = m.group(0).split("<g class=\"stepcap\">")[0]
    out = []
    for t in re.finditer(r"<(animateMotion|animateTransform|animate)\b([^>]*)/>", blk):
        at = dict(re.findall(r'(\w+)="([^"]*)"', t.group(2)))
        out.append([t.group(1)] + [at.get(k, "") for k in ATTRS])
    return out
def gate_blocks(svg):   # every <g class="gatehouse">…</g>, matched by counting nested <g> / </g>
    out, i = [], svg.find('<g class="gatehouse">')
    while i >= 0:
        depth, j = 0, i
        for m in re.finditer(r"<g\b[^>]*?(/?)>|</g>", svg[i:]):
            if m.group(0) == "</g>": depth -= 1
            elif not m.group(1): depth += 1
            if depth == 0: j = i + m.end(); break
        out.append(svg[i:j]); i = svg.find('<g class="gatehouse">', j)
    return out
bad = 0
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1400, "height": 800}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.route("**/save**", lambda r: (errs.append("SAVE " + r.request.url), r.abort()))
    for V in VIEWS:   # FR139: (method, net, reach, name, step[, scenario]) — a Tailscale view is in a scenario (first by default)
        m_, n, r, nm, step = V[:5]; scn = V[5] if len(V) > 5 else ("first" if r in ("tailscale", "ipv6") else None)   # (FR143: an IPv6 view is in a scenario too)
        st = {"method": m_, "net": n, "reach": r, "name": nm, **({"scenario": scn} if scn else {}), "step": step}
        h = f"setup-map;method={m_}" + (f";net={n}" if n else "") + f";reach={r}" + (f";name={nm}" if nm else "") + (f";scenario={scn}" if scn else "") + f";step={step}"
        pg.goto("about:blank"); pg.goto(f"http://localhost:8099/flow.html#{h}", wait_until="networkidle"); pg.wait_for_timeout(300)
        js = pg.evaluate("""() => { const A = document.querySelector('.actor'), cap = document.getElementById('stepcap');
          return { nodes: [...document.querySelectorAll('#nodes > .node[data-id]')].map(g => g.getAttribute('data-id')).sort(),
                   edges: [...document.querySelectorAll('.edge[data-edge]:not(.gatehouse)')].map(g => g.getAttribute('data-edge')).sort(),
                   anims: A ? [...A.querySelectorAll('animateMotion, animate, animateTransform')].map(a => [a.tagName, ...['attributeName','path','keyPoints','keyTimes','values','dur','type','repeatCount','fill','begin'].map(k => a.getAttribute(k) || '')]) : [],
                   cap: cap && !cap.hidden ? cap.querySelector('.sc-body').textContent : null, hash: location.hash,
                   gh: document.querySelectorAll('.gatehouse .gh-anim').length, ghm: document.querySelectorAll('.gatehouse animateTransform').length,
                   t0: (() => { const a = document.querySelector('.actor animateMotion, .actor animate'); return a ? parseFloat(a.getAttribute('begin')) : null; })(),
                   book: [...document.querySelectorAll('.node')].filter(g => g.querySelector('.pb-still')).flatMap(g => [...g.querySelectorAll('animate, animateTransform, animateMotion')])
                     .map(a => [a.tagName, ...['attributeName','values','keyTimes','dur','type','repeatCount','fill','begin'].map(k => a.getAttribute(k) || '')]) }; }""")   # (FR141: every book)
        G.default_state = lambda t, st=st: dict(st); svg = G.render(d)
        tog = {k: v for k, v in st.items() if k != "step"}
        pn = sorted(x["id"] for x in d["nodes"] if G.shown(x, tog)); pset = set(pn)
        pe = sorted(e["id"] for e in d["edges"] if G.shown(e, tog) and e["from"] in pset and e["to"] in pset)
        pa = py_anims(svg)
        s_ = [s for s in d["steps"] if G.when_ok(s.get("showWhen"), tog)][step]
        ok_vis = js["nodes"] == pn and js["edges"] == pe
        ok_cnt = len(js["anims"]) == len(pa)
        mism = []
        for i, (a, q) in enumerate(zip(js["anims"], pa)):
            if a[0] != q[0] or a[1] != q[1] or a[6] != q[6] or a[7] != q[7] or a[8] != q[8] or a[9] != q[9] or not close(nums(a[2]), nums(q[2]), 0.06) \
               or not close(nums(a[3]), nums(q[3]), 0.0011) or not close(nums(a[4]), nums(q[4]), 0.0011) or not close(nums(a[5]), nums(q[5]), 0.06) \
               or (a[10] != q[10] and abs((float(a[10].rstrip("s")) - (js["t0"] or 0) if a[10] else 0.0) - (float(q[10].rstrip("s")) if q[10] else 0.0)) > 0.002):   # (the same, or the editor's counted from the page's start)
                mism.append((i, a[:2], q[:2]))
        ok_cap = (js["cap"] or "") == (s_.get("caption") or "") and (" ".join(G.caption_lines(s_)) == (s_.get("caption") or ""))
        ok_hash = js["hash"].endswith(f";step={step}")
        py_gh = svg.count('class="gh-anim"'); py_ghm = sum(b_.count("<animateTransform") for b_ in gate_blocks(svg))
        want = bool(s_.get("visitors")) and 'class="gatehouse"' in svg   # FR126: lights at the gates only in a step with visitors (FR136: and gates — the VM view has none)
        # FR129: the phonebook's own animations (once, from when the runner writes it, in a step where one does)
        pbb = gate_blocks(svg.replace('<g class="gatehouse">', '<g class="gh">').replace('<g class="phonebook">', '<g class="gatehouse">'))   # every book (FR141)
        pa_b = [[t.group(1)] + [dict(re.findall(r'(\w+)="([^"]*)"', t.group(2))).get(k, "") for k in ("attributeName", "values", "keyTimes", "dur", "type", "repeatCount", "fill", "begin")]
                for blk in pbb for t in re.finditer(r"<(animateMotion|animateTransform|animate)\b([^>]*)/>", blk)]
        jb = js.get("book") or []
        def bnorm(a, editor):   # the editor's begin counts from the page's start, the SVG's from the step's (no begin = the step's start)
            b = float(a[8].rstrip("s")) if a[8] else 0.0
            if editor and a[8] and js.get("t0") is not None:
                b -= js["t0"]
            return a[:8] + [f"{b:.3f}s"]
        ok_book = len(jb) == len(pa_b) and all(bnorm(x, True)[0:2] == bnorm(y, False)[0:2] and close(nums(x[2]), nums(y[2]), 0.06) and close(nums(x[3]), nums(y[3]), 0.0011)
                                               and x[4:8] == y[4:8] and close(nums(bnorm(x, True)[8]), nums(bnorm(y, False)[8]), 0.002) for x, y in zip(jb, pa_b))
        bad += not ok_book
        ok_gh = js["gh"] == py_gh and (js["gh"] > 0) == want and js["ghm"] == py_ghm
        bad += not ok_gh
        bad += (not ok_vis) + (not ok_cnt) + len(mism) + (not ok_cap) + (not ok_hash)
        print(f"{h}: items {'match' if ok_vis else 'MISMATCH js=' + str((js['nodes'], js['edges'])) + ' py=' + str((pn, pe))} ({len(pn)} boxes, {len(pe)} lines)"
              f" | gate lights {js['gh']}/{py_gh} moves {js['ghm']}/{py_ghm} {'ok' if ok_gh else 'MISMATCH'}"
              f" | book anims {len(jb)}/{len(pa_b)} {'ok' if ok_book else 'MISMATCH'}"
              f" | runner anims {len(js['anims'])}/{len(pa)} {'match' if ok_cnt and not mism else 'MISMATCH ' + str(mism[:3])} | caption {'match' if ok_cap else 'MISMATCH'} | hash {'ok' if ok_hash else js['hash']}")
    print("page errors:", errs, "| total problems:", bad); b.close()
