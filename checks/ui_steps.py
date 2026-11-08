# ui_steps.py — FR124–FR128, FR137: click through the step UI in the editor (localhost:8099): ▶ step by step, ⏮ ⏭ ✕, ⏸ / ▶ (stops the
# clock at once), ⏪ / ⏩ (click = 2 s, hold = 4×, across steps), ☐ in step on a selected box (then undone), the hash, the
# gate lights per step and the step clock. Never saves (aborts **/save**). Run from dev-dashboard.
import glob, importlib.util, json, re, sys
from playwright.sync_api import sync_playwright
c = sorted(glob.glob("/nix/store/*playwright-chromium/chrome-linux64/chrome"))
bad = 0
def plan5():   # FR136: step 5's length and when Jazz opens the book — from the static renderer (parity_steps.py: the editor plans alike)
    spec = importlib.util.spec_from_file_location("g", "docs/gen_flow_svg.py"); G = importlib.util.module_from_spec(spec); sys.path.insert(0, "docs"); spec.loader.exec_module(G)
    G.default_state = lambda t: {"method": "cable", "net": "0a", "reach": "tailscale", "scenario": "first", "step": 5}   # (FR139: a Tailscale view is in a scenario)
    got, orig = {}, G.step_plans
    G.step_plans = lambda *a, **k: got.setdefault("sp", orig(*a, **k))
    G.render(json.load(open("docs/diagrams/setup-map.json")))
    return got["sp"]["durs"][5], got["sp"]["P"]["reads"][0]["t"]
T5, READ5 = plan5()
def check(cond, what):
    global bad
    print(("ok   " if cond else "FAIL ") + what); bad += not cond
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": c[0]} if c else {})); pg = b.new_page(viewport={"width": 1500, "height": 900}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.route("**/save**", lambda r: (errs.append("SAVE " + r.request.url), r.abort()))
    pg.goto("http://localhost:8099/flow.html#setup-map;method=cable;net=0a;reach=tailscale", wait_until="networkidle"); pg.wait_for_timeout(400)
    cnt = lambda: pg.evaluate("() => [document.querySelectorAll('#nodes > .node[data-id]').length, document.querySelectorAll('.edge[data-edge]:not(.gatehouse)').length]")
    hsh = lambda: pg.evaluate("location.hash")
    # the step clock: the page's clock minus the step's start (= the begin of the step's own animations)
    clock = lambda: pg.evaluate("() => { const s = document.getElementById('svg'), a = document.querySelector('.actor animateMotion, .actor animate, .pb-anim animate');"
                                " return [s.animationsPaused(), s.getCurrentTime(), a ? parseFloat(a.getAttribute('begin')) : null]; }")
    local = lambda: (lambda r: r[1] - r[2])(clock())
    def hold(label, ms):   # press and hold a caption button
        bb = pg.locator("#stepcap button", has_text=label).bounding_box()
        pg.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2); pg.mouse.down(); pg.wait_for_timeout(ms); pg.mouse.up(); pg.wait_for_timeout(150)
    click = lambda label: (pg.locator("#stepcap button", has_text=label).click(), pg.wait_for_timeout(150))
    # FR137: the steps are run from the caption bottom-right only — no Steps group in the top bar any more
    check(pg.locator("#togglebar .tg", has_text="Steps").count() == 0, "no Steps group in the toggle bar")
    stepno = lambda: (lambda m: int(m.group(1)) if m else None)(re.search(r";step=(\d+)", hsh()))
    # FR148: a link without a step opens the story at its last step (playing); the friend's step starts with Jazz on his way, Mario home
    # already (the hand-over and Mario's way home are in the share step)
    t0 = pg.locator("#stepcap b").text_content() if pg.locator("#stepcap b").count() else None
    check(stepno() == 5 and t0 == "A friend opens the link" and not clock()[0], f"first sight = the last step, playing ({hsh()}, '{t0}')")
    mario_still = pg.evaluate("() => { const u = document.querySelector('.actor use[href=\"#ic-mario\"]'), R = u && u.closest('.actor > g'); return !!R && !R.querySelector(':scope > animateMotion'); }")
    jazz_in = pg.evaluate("() => !!document.querySelector('.actor use[href=\"#ic-jazz\"]')")
    check(mario_still and jazz_in, f"step 5: Mario stands at home from the start (no walk), Jazz is there from the start (Mario still {mario_still}, Jazz {jazz_in})")
    pg.goto("about:blank"); pg.goto("http://localhost:8099/flow.html#setup-map;method=cable;net=0a;reach=tailscale;step=4;play=0", wait_until="networkidle"); pg.wait_for_timeout(300)
    check(pg.evaluate("() => !!document.querySelector('.actor use[href=\"#ic-jazz\"]')"), "step 4 (share): Jazz comes out of the phone and takes the address there")
    pg.goto("about:blank"); pg.goto("http://localhost:8099/flow.html#setup-map;method=cable;net=0a;reach=tailscale;step=all", wait_until="networkidle"); pg.wait_for_timeout(400)
    check(pg.locator("#stepcap").is_hidden() and pg.locator("#stepenter").is_visible() and hsh().endswith(";step=all"), f"…;step=all: the whole view, no caption, a '▶ step by step' button ({hsh()})")
    playbtn = lambda: pg.locator("#stepcap .sc-head button").nth(2)   # ⏮ ⏪ ▶/⏸ ⏩ ⏭ ✕
    def go(i):   # to step i: into the steps from the whole view, then ⏭ / ⏮ (round and round)
        if pg.locator("#stepcap").is_hidden():
            pg.locator("#stepenter").click(); pg.wait_for_timeout(200)
        for _ in range(8):
            if stepno() == i: return
            click("⏭" if (i - stepno()) % 6 <= 3 else "⏮"); pg.wait_for_timeout(100)
    full = cnt()
    pg.locator("#stepenter").click(); pg.wait_for_timeout(200)
    check(hsh().endswith(";step=0"), f"▶ step by step: step 0 ({hsh()})")
    titles = []
    for _ in range(6):
        titles.append(pg.locator("#stepcap b").text_content()); click("⏭")
    check(len(set(titles)) == 6 and stepno() == 0, f"⏭ goes through the 6 steps and round to step 0 ({titles})")
    click("⏮")
    check(stepno() == 5, f"⏮ from step 0 goes round to step 5 ({hsh()})")
    go(1)
    check(hsh().endswith(";step=1"), "hash gets ;step=1")
    check(cnt() == [5, 5], f"step 1 shows 5 boxes + 5 lines (got {cnt()})")
    check(pg.locator("#stepcap b").text_content() == "Install, then register at Tailscale", "caption title")
    check([t for t in pg.locator("#stepcap button").all_text_contents()] == ["⏮", "⏪", "⏸", "⏩", "⏭", "✕"], f"caption controls {pg.locator('#stepcap button').all_text_contents()}")
    check(playbtn().text_content() == "⏸" and not clock()[0], "playing by default (⏸ offered, the clock runs)")
    # FR128: ⏸ stops everything at once — not at the end of the step
    pg.wait_for_timeout(1200)
    playbtn().click(); pg.wait_for_timeout(200)
    c1 = clock(); pg.wait_for_timeout(800); c2 = clock()
    check(c1[0] and c2[1] == c1[1] and 0.9 < c1[1] - c1[2] < 2.5, f"⏸ freezes at once: paused {c1[0]}, step clock {c1[1] - c1[2]:.2f} s and still {c2[1] - c2[2]:.2f} s 0.8 s later")
    check(playbtn().text_content() == "▶" and hsh().endswith(";step=1;play=0"), f"paused: ▶ offered, hash {hsh()}")
    check(pg.locator(".actor animateMotion").count() >= 1, "the runner is drawn")
    # FR128: ⏪ / ⏩ — a click = 2 s, held = 4× (paused), across steps
    l0 = local(); click("⏩")
    check(abs(local() - (l0 + 2)) < 0.05 and hsh().endswith(";step=1;play=0"), f"⏩ click: 2 s ahead ({l0:.2f} → {local():.2f} s), still step 1, still paused")
    click("⏪")
    check(abs(local() - l0) < 0.05, f"⏪ click: 2 s back ({local():.2f} s)")
    hold("⏩", 1250); l1 = local()
    check(2.5 < l1 - l0 < 5.0 and clock()[0], f"⏩ held 1.25 s: {l1 - l0:.2f} s further (4× after the first 0.25 s), still paused")
    hold("⏪", 1250); l2 = local()
    check(2.5 < l1 - l2 < 5.0, f"⏪ held 1.25 s: {l1 - l2:.2f} s back (backwards at 4×)")
    click("⏭"); click("⏮")
    check(stepno() == 1 and abs(local()) < 0.05 and clock()[0], f"a step chosen while paused (⏭ ⏮) starts at its start ({local():.2f} s) and stays paused")
    click("⏪")
    check(hsh().endswith(";step=0;play=0") and 10 < local() < 12, f"⏪ at the start of step 1 goes back into step 0, 2 s before its end ({hsh()}, {local():.2f} s)")
    click("⏩")
    check(hsh().endswith(";step=1;play=0") and abs(local()) < 0.05, f"⏩ from there is the start of step 1 again ({local():.2f} s)")
    go(0); click("⏪")
    check(hsh().endswith(";step=0;play=0") and abs(local()) < 0.05, "⏪ stops at the story's start")
    go(2)
    check(hsh().endswith(";step=2;play=0") and cnt() == [6, 6], f"step 2 (6 boxes + 6 lines, got {cnt()}; still paused)")
    who = pg.evaluate("() => [...document.querySelectorAll('.actor use')].map(u => u.getAttribute('href')).filter(h => /mario|yoshi/.test(h))")
    still = pg.evaluate("() => { const u = document.querySelector('.actor use[href=\"#ic-mario\"]'), R = u && u.closest('.actor > g'); return !!R && !R.querySelector(':scope > animateMotion'); }")
    check(still and "#ic-yoshi" in who, f"step 2: Mario stands where step 1 left him, Yoshi comes out of the Tailscale cloud ({who})")
    # FR129: in step 2 the book is written once — when Yoshi is there, 6.2 s into the step; no gate lights yet
    b2 = pg.evaluate("() => { const a = document.querySelector('.node[data-id=\"tsbook\"] animate'); return [a && a.getAttribute('begin'), a && a.getAttribute('repeatCount'), document.getElementById('svg').getCurrentTime()]; }")
    check(b2[0] is not None and abs(float(b2[0].rstrip("s")) - (b2[2] + 6.2)) < 0.4 and b2[1] == "1", f"step 2's book plays once, from when Yoshi writes it (begin {b2[0]}, step start {b2[2]:.2f} s + 6.2, repeatCount {b2[1]})")
    check(pg.locator(".gatehouse .gh-anim").count() == 0, "step 2: no lights at the router's gates (nobody comes in yet)")
    go(1)
    check(pg.locator(".gatehouse .gh-anim").count() == 0 and pg.locator(".gatehouse").count() == 1, "step 1: the gates are drawn but no light goes through e_ts_up, none bounces off the fire wall")
    # ☐ in step: select the server (in step 1), take it out, put it back
    pg.locator('.node[data-id="server"]').first.click(); pg.wait_for_timeout(150)
    m = pg.locator("#stepmember")
    check(m.text_content() == "☑ in step" and m.is_enabled(), f"selected server shows '{m.text_content()}' (in the caption, FR137)")
    m.click(); pg.wait_for_timeout(200)
    check(cnt()[0] == 4 and m.text_content() == "☐ in step", f"server taken out of step 1 (boxes {cnt()[0]}, button '{m.text_content()}')")
    check(pg.evaluate("document.body.classList.contains('dirty')"), "the diagram is marked dirty (not saved)")
    m.click(); pg.wait_for_timeout(200)
    check(cnt()[0] == 5 and m.text_content() == "☑ in step", "server put back")
    # FR137: a double-click on the caption edits it in place; Esc drops it, Enter keeps it; typing doesn't reach the editor's keys
    body = pg.locator("#stepcap .sc-body"); cap0 = body.text_content()
    body.dblclick(); pg.wait_for_timeout(150)
    check(body.get_attribute("contenteditable") == "true", "double-click: the caption is editable")
    pg.keyboard.press("Backspace"); pg.keyboard.type("x"); pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    check(pg.locator("#stepcap .sc-body").text_content() == cap0 and cnt()[0] == 5, "Esc drops the edit; Backspace while typing deleted nothing (the server is still there)")
    pg.locator("#stepcap .sc-body").dblclick(); pg.wait_for_timeout(150)
    pg.keyboard.type("A new caption"); pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
    check(pg.locator("#stepcap .sc-body").text_content() == "A new caption" and pg.locator("#stepcap .sc-body").get_attribute("contenteditable") != "true",
          f"Enter keeps it ({pg.locator('#stepcap .sc-body').text_content()!r})")
    pg.locator("#stepcap .sc-body").dblclick(); pg.wait_for_timeout(150)
    pg.keyboard.type(cap0); pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
    check(pg.locator("#stepcap .sc-body").text_content() == cap0, "…and the old caption back the same way")
    click("✕")
    check(hsh().endswith(";step=all") and cnt() == full and pg.locator("#stepcap").is_hidden() and pg.locator("#stepenter").is_visible(), f"✕ = the whole view again, ;step=all ({hsh()}, {cnt()} vs {full})")
    check(pg.locator(".gatehouse .gh-anim").count() == 2 and pg.locator(".pb-anim animate[begin]").count() == 0 and not clock()[0], "the whole view keeps its gate lights, its own clock, and runs")
    # FR136: the book opens only to be written (step 2) or read (step 5) — shut and still in steps 3 and 4
    for lbl in ("3 backup", "4 share"):
        go(int(lbl[0]))
        n = pg.evaluate("() => document.querySelectorAll('.node[data-id=\"tsbook\"] animate, .node[data-id=\"tsbook\"] animateTransform, .pb-lights animateMotion').length")
        check(n == 0, f"step {lbl}: the book stays shut ({n} animations)")
    # ⏩ goes round: from the end of step 5 into step 0
    go(5)
    check(hsh().endswith(";step=5;play=0") and clock()[0], "step 5 (friend), paused")
    n5 = int(T5 // 2) + 1   # FR136: step 5 lasts T5 s (Jazz's trip)
    for _ in range(n5):
        click("⏩")
    check(hsh().endswith(";step=0;play=0") and abs(local() - (2 * n5 - T5)) < 0.3, f"⏩ past the end of step 5 ({T5:.2f} s, {n5} clicks) goes round into step 0 ({hsh()}, {local():.2f} s)")
    # FR125: playing, the last step (its script + fade) hands over to step 0 by itself; ▶ runs the clock on
    go(5)
    playbtn().click(); pg.wait_for_timeout(200)
    check(hsh().endswith(";step=5") and playbtn().text_content() == "⏸" and not clock()[0], "▶: step 5 plays, the clock runs")
    check(pg.locator(".gatehouse .gh-anim").count() == 1, "step 5 (visitors): the stranger at the gates (Jazz takes your friend's way through the tunnel, FR136)")
    who5 = pg.evaluate("() => [...document.querySelectorAll('.actor use')].map(u => u.getAttribute('href')).filter(h => /mario|yoshi|jazz/.test(h))")
    check("#ic-jazz" in who5 and "#ic-mario" in who5, f"step 5: Mario and Jazz ({who5})")
    # FR136: the book plays once, from when Jazz looks the name up
    b5 = pg.evaluate("() => { const a = document.querySelector('.node[data-id=\"tsbook\"] animate'); return [a && a.getAttribute('begin'), a && a.getAttribute('repeatCount'), document.getElementById('svg').getCurrentTime()]; }")
    check(b5[0] is not None and abs(float(b5[0].rstrip("s")) - (b5[2] + READ5)) < 0.5 and b5[1] == "1", f"step 5's book plays once, from when Jazz looks it up (begin {b5[0]}, now {b5[2]:.2f} s + {READ5:.2f}, repeatCount {b5[1]})")
    pg.wait_for_timeout(int((T5 + 0.6) * 1000))
    check(hsh().endswith(";step=0"), f"…and {T5 + 0.6:.1f} s later it is step 0 ({hsh()})")
    playbtn().click(); pg.wait_for_timeout(200)
    pg.goto("about:blank"); pg.goto("http://localhost:8099/flow.html#setup-map;method=cable;net=0a;reach=portfwd;name=buy;step=1", wait_until="networkidle")   # a new load (a fragment change alone does not reload); FR145: port-forward is the route without a story now
    pg.wait_for_timeout(300)
    check(pg.locator("#stepenter").is_hidden() and pg.locator("#stepcap").is_hidden() and ";step=" not in hsh(), "a view without steps: no step-by-step button, no caption, step dropped from the hash")
    print("page errors:", errs, "| total problems:", bad + len(errs)); b.close()
