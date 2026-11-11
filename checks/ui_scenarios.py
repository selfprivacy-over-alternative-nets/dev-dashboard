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
    has = lambda nid: pg.locator(f'#nodes > .node[data-id="{nid}"]').count() > 0 or pg.locator(f'.edge[data-edge="{nid}"]').count() > 0
    # FR148: a link without a step opens at the story's last step; from a last step, another scenario opens at its own last step
    go("setup-map;method=cable;net=0a;reach=tailscale")
    sc_ = pg.locator("#togglebar .tg", has_text="Scenario")
    check(pg.evaluate("location.hash").endswith(";scenario=first;step=5"), f"no step in the link: the last step ({pg.evaluate('location.hash')})")
    sc_.locator("button", has_text="Reinstall").click(); pg.wait_for_timeout(300)
    check(pg.evaluate("location.hash").endswith(";scenario=reinstall;step=2"), f"from the last step, Reinstall opens at its last step ({pg.evaluate('location.hash')})")
    for h_, last in (("setup-map;method=cable;net=0a;reach=ipv6;name=buy;scenario=first", 5), ("setup-map;method=cable;net=0a;reach=ipv6;name=duckdns;scenario=restore", 4),
                     ("setup-map;method=cable;net=0a;reach=cloudflare;name=buy;scenario=first", 5), ("setup-map;method=cable;net=0a;reach=cloudflare;name=trycf;scenario=first", 4)):
        go(h_)
        check(pg.evaluate("location.hash") == f"#{h_};step={last}", f"{h_}: first sight = step {last} ({pg.evaluate('location.hash')})")
    go("setup-map;method=cable;net=0a;reach=tailscale;step=all")
    grp = pg.locator("#togglebar .tg", has_text="Scenario")
    check(grp.count() == 1, "a Scenario group in a Tailscale view")
    opts = grp.locator("button").all_text_contents() if grp.count() else []
    check(opts == ["First install", "Reinstall", "Restore a backup"], f"its options {opts}")
    h = pg.evaluate("location.hash")
    check(h.endswith(";scenario=first;step=all") and not has("backupdev") and not has("tslife"), f"default: first install ({h}), no backup device, the hidden note stays hidden")
    for label, scn, cap in (("Reinstall", "reinstall", "Get a new auth key"), ("Restore a backup", "restore", "Back up to your backup device")):
        grp.locator("button", has_text=label).click(); pg.wait_for_timeout(300)
        h = pg.evaluate("location.hash")
        check(f";scenario={scn}" in h and has("backupdev") == (scn == "restore") and not has("tslife"), f"{label}: hash {h}, backup device {'shown' if has('backupdev') else 'not shown'}, note hidden")
        pg.locator("#stepenter").click(); pg.wait_for_timeout(300)
        t = pg.locator("#stepcap b").first.text_content() if pg.locator("#stepcap b").count() else None
        check(t == cap and ";step=0" in pg.evaluate("location.hash"), f"{label}: step by step starts with '{t}'")
        pg.locator("#stepcap button", has_text="✕").click(); pg.wait_for_timeout(200)
    # FR143: the IPv6 views (both names) have the three scenarios too; each one's story starts with its own step 0
    for nm, caps in (("duckdns", ("Claim a DuckDNS name, keep the token", "The name and the token are still yours", "Back up to your backup device")),
                     ("buy", ("Buy a domain", "The domain is still yours", "Back up to your backup device"))):
        go(f"setup-map;method=cable;net=0a;reach=ipv6;name={nm};step=all")
        g6 = pg.locator("#togglebar .tg", has_text="Scenario")
        check(g6.count() == 1 and g6.locator("button").all_text_contents() == ["First install", "Reinstall", "Restore a backup"] and pg.evaluate("location.hash").endswith(";scenario=first;step=all"),
              f"ipv6/{nm}: a Scenario group with the three choices, hash {pg.evaluate('location.hash')}")
        for label, scn, cap in zip(("First install", "Reinstall", "Restore a backup"), ("first", "reinstall", "restore"), caps):
            g6.locator("button", has_text=label).click(); pg.wait_for_timeout(300)
            h = pg.evaluate("location.hash")
            check(f";scenario={scn}" in h and has("backupdev6") == (scn == "restore") and has("e_v4"), f"ipv6/{nm} {label}: hash {h}, backup device {'shown' if has('backupdev6') else 'not shown'}, the IPv4 pipe drawn")
            pg.locator("#stepenter").click(); pg.wait_for_timeout(300)
            t = pg.locator("#stepcap b").first.text_content() if pg.locator("#stepcap b").count() else None
            check(t == cap and ";step=0" in pg.evaluate("location.hash"), f"ipv6/{nm} {label}: step by step starts with '{t}'")
            pg.locator("#stepcap button", has_text="✕").click(); pg.wait_for_timeout(200)
    # FR145 / FR146: the Cloudflare views (both names) have the three scenarios too
    for nm, caps in (("buy", ("Buy a domain, point it to Cloudflare", "The token, the tunnel and the names are still yours", "Back up to your backup device")),
                     ("trycf", ("Install, with a placeholder name", "Install again", "Back up to your backup device"))):
        go(f"setup-map;method=cable;net=0a;reach=cloudflare;name={nm};step=all")
        g7 = pg.locator("#togglebar .tg", has_text="Scenario")
        check(g7.count() == 1 and g7.locator("button").all_text_contents() == ["First install", "Reinstall", "Restore a backup"], f"cloudflare/{nm}: a Scenario group with the three choices")
        for label, scn, cap in zip(("First install", "Reinstall", "Restore a backup"), ("first", "reinstall", "restore"), caps):
            g7.locator("button", has_text=label).click(); pg.wait_for_timeout(300)
            h = pg.evaluate("location.hash")
            check(f";scenario={scn}" in h and has("backupdev") == (scn == "restore") and has("e_sharecf"), f"cloudflare/{nm} {label}: hash {h}, backup device {'shown' if has('backupdev') else 'not shown'}, the share line drawn")
            pg.locator("#stepenter").click(); pg.wait_for_timeout(300)
            t = pg.locator("#stepcap b").first.text_content() if pg.locator("#stepcap b").count() else None
            check(t == cap and ";step=0" in pg.evaluate("location.hash"), f"cloudflare/{nm} {label}: step by step starts with '{t}'")
            pg.locator("#stepcap button", has_text="✕").click(); pg.wait_for_timeout(200)
    go("setup-map;method=cable;net=0a;reach=onion")   # FR152: .onion is the route without a story now
    g2 = pg.locator("#togglebar .tg", has_text="Scenario")   # (like Name in a Tailscale view: the group says "— n/a")
    check(g2.count() == 1 and g2.locator("button").count() == 0 and "n/a" in g2.text_content() and "scenario=" not in pg.evaluate("location.hash"),
          f"on a route without a story the Scenario group has no choices ('{g2.text_content() if g2.count() else None}') and the hash none")
    print("page errors:", errs, "| total problems:", bad + len(errs)); b.close()
