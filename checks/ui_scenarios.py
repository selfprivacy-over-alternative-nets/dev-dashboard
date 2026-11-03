# ui_scenarios.py — FR139 / FR140: the Scenario toggle in the editor (localhost:8099): only in Tailscale views; switching it changes
# the hash, the story (its first caption) and the boxes (the backup device only when restoring); the note the user hid in
# cable/0a stays hidden in all three. Never saves (aborts **/save**). Run from dev-dashboard.
import glob
from playwright.sync_api import sync_playwright
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome")); bad = 0
def check(cond, what):
    global bad
    print(("ok   " if cond else "FAIL ") + what); bad += not cond
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1500, "height": 900}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.route("**/save**", lambda r: (errs.append("SAVE " + r.request.url), r.abort()))
    go = lambda h: (pg.goto("about:blank"), pg.goto("http://localhost:8099/flow.html#" + h, wait_until="networkidle"), pg.wait_for_timeout(400))
    has = lambda nid: pg.locator(f'#nodes > .node[data-id="{nid}"]').count() > 0
    go("setup-map;method=cable;net=0a;reach=tailscale")
    grp = pg.locator("#togglebar .tg", has_text="Scenario")
    check(grp.count() == 1, "a Scenario group in a Tailscale view")
    opts = grp.locator("button").all_text_contents() if grp.count() else []
    check(opts == ["First install", "Reinstall", "Restore a backup"], f"its options {opts}")
    h = pg.evaluate("location.hash")
    check(h.endswith(";scenario=first") and not has("backupdev") and not has("tslife"), f"default: first install ({h}), no backup device, the hidden note stays hidden")
    for label, scn, cap in (("Reinstall", "reinstall", "Get a new auth key"), ("Restore a backup", "restore", "Back up to your backup device")):
        grp.locator("button", has_text=label).click(); pg.wait_for_timeout(300)
        h = pg.evaluate("location.hash")
        check(f";scenario={scn}" in h and has("backupdev") == (scn == "restore") and not has("tslife"), f"{label}: hash {h}, backup device {'shown' if has('backupdev') else 'not shown'}, note hidden")
        pg.locator("#stepenter").click(); pg.wait_for_timeout(300)
        t = pg.locator("#stepcap b").first.text_content() if pg.locator("#stepcap b").count() else None
        check(t == cap and ";step=0" in pg.evaluate("location.hash"), f"{label}: step by step starts with '{t}'")
        pg.locator("#stepcap button", has_text="✕").click(); pg.wait_for_timeout(200)
    go("setup-map;method=cable;net=0a;reach=cloudflare;name=buy")
    g2 = pg.locator("#togglebar .tg", has_text="Scenario")   # (like Name in a Tailscale view: the group says "— n/a")
    check(g2.count() == 1 and g2.locator("button").count() == 0 and "n/a" in g2.text_content() and "scenario=" not in pg.evaluate("location.hash"),
          f"outside Tailscale the Scenario group has no choices ('{g2.text_content() if g2.count() else None}') and the hash none")
    print("page errors:", errs, "| total problems:", bad + len(errs)); b.close()
