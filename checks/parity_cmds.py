# parity_cmds.py — FR152: every command a setup-map step shows is the command its matrix twin shows for that cell
# (index.html#method=…;net=…;reach=…;name=… builds its cell commands from catalog.json in app.js cellCmd), with the view's
# fixes applied the way checks/fr152_portfwd_steps_apply.py applies them (TRANSPORT=https, the DuckDNS name, no address).
# The install step = the setup's install cell, the phonebook step = the make-reachable cell, the friend step = the L3 cells
# (one line with the seven flows, L3.addremove.desktop on its own). Run from dev-dashboard with ./dash serve 8099 up.
import glob, json, re, sys
sys.path.insert(0, "docs"); import gen_flow_svg as G
sys.path.insert(0, "checks"); from fr152_portfwd_steps_apply import view_cmd, FLOWS, VM_REACH
from playwright.sync_api import sync_playwright
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))
d = json.load(open("docs/diagrams/setup-map.json")); cat = json.load(open("catalog.json"))
install_of = {m["id"]: m["install"] for m in cat["setup_map"]["methods"]}
vm_ni = re.search(r'niCell\("(not wired for the VM[^"]*)"', open("app.js").read()).group(1)   # the matrix's own words for a reach on the VM
bad = 0
def check(cond, what):
    global bad
    print(("ok   " if cond else "FAIL ") + what); bad += not cond
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1400, "height": 800}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:8099/index.html#method=usb;net=0a;reach=portfwd;name=duckdns", wait_until="networkidle"); pg.wait_for_function("() => !!CATALOG"); pg.wait_for_timeout(300)
    cell = lambda eid, setup, row=None: pg.evaluate("([e, s, r]) => cellCmd([...CATALOG.installs, ...CATALOG.reaches, ...CATALOG.tests].find(x => x.id === e), s, r ? CATALOG.reach_rows.find(x => x.id === r) : undefined)", [eid, setup, row])
    for s in cat["setups"]:
        for nm in ("duckdns", "buy"):
            st = {"method": s["method"], "net": s.get("net"), "reach": "portfwd", "name": nm, "scenario": None}
            steps = [x for x in d["steps"] if G.when_ok(x.get("showWhen"), st)]
            view = f"method={s['method']}" + (f";net={s['net']}" if s.get("net") else "") + f";reach=portfwd;name={nm}"
            check(len(steps) == 6, f"{view}: a six-step story ({len(steps)})")
            by = {x["label"]: x for x in steps}
            got = {k: G.cmds_of(v, st) for k, v in by.items()}
            check(got.get("install") == [view_cmd(cell(install_of[s["method"]], s["id"]), nm)], f"{view} install: {got.get('install')}")
            want_reach = [VM_REACH] if s["method"] == "vm" else [view_cmd(cell(f"reach.portfwd-{nm}", s["id"]), nm)]
            check(got.get("phonebook") == want_reach and VM_REACH.endswith(vm_ni), f"{view} phonebook: {got.get('phonebook')}")
            l3 = {f: cell(f"L3.{f}.desktop", s["id"], f"portfwd-{nm}") for f in FLOWS + ["addremove"]}
            if s["method"] == "vm":
                want_l3 = [l3["connect"]]   # the matrix's "# not wired" line, once
            else:
                want_l3 = [l3["connect"].replace("L3.connect.desktop", " ".join(f"L3.{f}.desktop" for f in FLOWS), 1), l3["addremove"]]
            check(got.get("friend") == want_l3, f"{view} friend: {got.get('friend')}")
            check(all(not got.get(k) for k in by if k not in ("install", "phonebook", "friend")), f"{view}: the other steps (by hand) show no command")
            for lines in got.values():
                for ln in lines or []:
                    check(not re.search(r"\d+\.\d+\.\d+\.\d+|weer", ln), f"{view}: no address in {ln[:60]}")
    print("page errors:", errs, "| total problems:", bad + len(errs)); b.close()
