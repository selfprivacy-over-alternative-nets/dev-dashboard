import glob, json, itertools, os, time
from playwright.sync_api import sync_playwright
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "diagrams")   # dev-dashboard/docs/diagrams
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))
views = []
for f in sorted(glob.glob(f"{D}/*.json")):
    name = f.rsplit("/", 1)[1][:-5]; d = json.load(open(f)); tg = d.get("meta", {}).get("toggles", [])
    if not tg: views.append(name); continue
    keys = [t.get("key") or t.get("id") for t in tg]
    opts = [[o.get("value") or o.get("key") or o.get("id") for o in t.get("options", [])] for t in tg]
    seen = set()
    for combo in itertools.product(*opts):
        st = dict(zip(keys, combo)); h = []
        for t, k in zip(tg, keys):
            ow = t.get("optionsWhen") or {}
            allowed = None
            for dep, m in ow.items():
                if st.get(dep) in m: allowed = m[st[dep]]
            if allowed is not None and not allowed: continue          # toggle not applicable in this view
            if allowed is not None and st[k] not in allowed: h = None; break
            h.append(f"{k}={st[k]}")
        if h is None: continue
        v = name + ";" + ";".join(h)
        if v not in seen: seen.add(v); views.append(v)
print(len(views), "views", flush=True)
errs = []; t0 = time.time()
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1400, "height": 800})
    cur = {"v": None}
    pg.on("pageerror", lambda e: errs.append((cur["v"], "pageerror", str(e))))
    pg.on("console", lambda m: m.type == "error" and errs.append((cur["v"], "console", m.text)))
    pg.route("**/save**", lambda r: (errs.append((cur["v"], "SAVE CALLED", r.request.url)), r.abort()))
    for v in views:
        cur["v"] = v
        pg.goto("about:blank"); pg.goto(f"http://localhost:8099/flow.html#{v}", wait_until="networkidle"); pg.wait_for_timeout(150)
        n = pg.evaluate("() => [document.querySelectorAll('#nodes > .node').length, document.querySelectorAll('.gatehouse').length, document.querySelectorAll('#edges .edge, .front-edges .edge').length]")
        print(f"{v}: nodes {n[0]} gatehouses {n[1]} edges {n[2]}", flush=True)
    b.close()
print(f"done in {time.time() - t0:.0f}s; errors: {len(errs)}")
for e in errs: print("  ", e)
