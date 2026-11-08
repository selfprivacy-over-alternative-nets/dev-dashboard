"""FR145–FR146 — the Cloudflare stories: a Cloudflare Tunnel with a bought domain (FR145) and the free quick tunnel (FR146), each told in
the three scenarios. Run from dev-dashboard AFTER fr124_steps_apply.py, fr139_scenarios_apply.py and fr141_ipv6_steps_apply.py:
    python3 checks/fr145_cloudflare_steps_apply.py docs/diagrams/setup-map.json
Re-runnable: it replaces what it wrote before (the steps whose id starts with "cf" or "tc", the Cloudflare views' share line)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from keep_layout import put   # an editor change to an item survives a re-run

p = sys.argv[1]
d = json.load(open(p))
SC = ["first", "reinstall", "restore"]
# the Scenario toggle is offered in the Cloudflare views too — a Cloudflare view's key ends in ;scenario=first (FR113 hideIn)
tg = next(t for t in d["meta"]["toggles"] if t["id"] == "scenario")
tg["optionsWhen"]["reach"]["cloudflare"] = SC
for o in d["nodes"] + d["edges"]:
    if o.get("hideIn"):
        o["hideIn"] = [k + ";scenario=first" if "reach=cloudflare" in k and "scenario=" not in k else k for k in o["hideIn"]]
E = {e["id"]: e for e in d["edges"]}
N = {n["id"]: n for n in d["nodes"]}
# the backup device and its pipe (FR140) serve the Cloudflare restore views too (right of the book, left of the lookup line, as at Tailscale)
for oid in ("backupdev", "e_backup"):
    (N if oid in N else E)[oid]["showWhen"]["reach"] = ["tailscale", "cloudflare"]
E["e_sharevm"]["showWhen"]["reach"] = ["tailscale", "ipv6"]
# the Cloudflare box views' share line runs ABOVE the "Buy a domain" box (the Tailscale / IPv6 one would thread between that box and the token
# box and hide under your line to the registrar), from your computer's top, over everything, down beside the phone and in from its right
SHARE_E = {"from": "you", "to": "friend", "kind": "plain", "role": "info", "dir": "to", "cost": "free", "label": "you send your friend the link", "_H": True, "eo": -640.5, "es": 100, "ef": 0}
put(d["edges"], {"id": "e_sharecf", **SHARE_E, "so": -405, "ss": -10, "showWhen": {"method": ["cable", "wifi", "usb"], "reach": ["cloudflare"]}})
put(d["edges"], {"id": "e_sharevmcf", **SHARE_E, "so": -452.5, "ss": -60, "showWhen": {"method": ["vm"], "reach": ["cloudflare"]}})   # (the VM views: your computer is a box around the server)
NAME1, NAME2 = "pink-owl-sky.trycloudflare.com", "quiet-river-fog.trycloudflare.com"
N["trybook"]["entryWhen"] = {"scenario": {s: f"https://{NAME2}\n→ Cloudflare's relay, like: 98.76.54.32" for s in ("reinstall", "restore")}}   # a restart = a new random name
INSTALL = ["server", "router", "e_cable", "e_usb", "e_wifi", "e_scable"]
TUN = ["relayCF", "e_cf_up", "inet", "e_cf_run"]   # Cloudflare, the tunnel to it, and its way on to the internet
HOME = [{"run": ["e_cable", "e_usb"], "back": True}]
SHARE = ["e_sharecf", "e_sharevmcf"]
READS = "Cloudflare ends the encryption here: it can read everything"
def jazz_call(book, lookup):   # FR136 / FR148: Jazz (who got the address from Mario in the share step) looks it up, goes to Cloudflare's relay (which reads the traffic) and down the tunnel to the server, and back with the call
    return [{"who": "jazz", "run": "e_friend"}, {"who": "jazz", "run": lookup, "back": True}, {"who": "jazz", "lookup": book},
            {"who": "jazz", "run": lookup}, {"who": "jazz", "run": "e_cf_run", "back": True}, {"who": "jazz", "pop": READS, "bad": True, "dur": 2},
            {"who": "jazz", "run": "e_cf_up", "back": True}, {"who": "jazz", "put": "answer", "in": "server"}, {"who": "jazz", "show": "jitsi", "at": "server"},
            {"who": "jazz", "get": "jitsi", "from": "server"}, {"who": "jazz", "run": "e_cf_up"}, {"who": "jazz", "run": "e_cf_run"},
            {"who": "jazz", "run": "e_friend", "back": True}, {"who": "jazz", "show": "jitsi", "at": "friend"}, {"wait": 1}]
def yoshi(book, line, handed):   # FR129: Cloudflare's helper comes out of the cloud, takes the name (from Mario, or its own) up the line and writes the book
    return [{"who": "yoshi", "appear": "relayCF"}] + ([{"give": "domain", "to": "yoshi"}] if handed else [{"who": "yoshi", "get": "domain"}]) + \
           [{"who": "yoshi", "run": line}, {"who": "yoshi", "write": book}, {"who": "yoshi", "run": line, "back": True}, {"who": "yoshi", "vanish": True}]
TOKEN_UP = [{"run": "e_cf_up"}, {"put": "token", "in": "relayCF"}]   # the connector dials out and shows the token: it identifies the tunnel
INSTALL_PLAY = lambda get, token: [{"get": "light"}] + get + [{"run": ["e_cable", "e_usb"]}, {"hammer": 3, "at": "server"}, {"put": "domain", "in": "server"}] + \
    ([{"put": "token", "in": "server", "copy": True}] if token else [])
steps = []
W = lambda nm, s: {"reach": ["cloudflare"], "name": [nm], "scenario": [s]}
def S(nm, s, i, **k):
    steps.append({"id": f"{'cf' if nm == 'buy' else 'tc'}{s}{i}", "showWhen": W(nm, {"": "first", "r": "reinstall", "s": "restore"}[s]), **k})
# ---------------- a bought domain + a Cloudflare Tunnel (FR145) ----------------
T_BUY = {"domain": "yourdomain.org", "token": "tunnel token"}
S("buy", "", 0, label="domain", title="Buy a domain, point it to Cloudflare", show=["you", "buy", "e8", "cfbook", "e_cf_move"], texts=T_BUY,
  caption="First you buy a domain at a registrar (€/yr). Then, once by hand, you point it to Cloudflare's phonebook: make a free Cloudflare "
          "account, add the domain, and at the registrar replace its nameservers with Cloudflare's two. From then on Cloudflare's phonebook "
          "answers for your domain (the switch can take up to a day).",
  play=[{"run": "e8"}, {"pop": "bought ✓ (€/yr)"}, {"run": "e_cf_move"}, {"pop": "nameservers → Cloudflare ✓"}, {"get": "domain"},
        {"put": "domain", "in": "cfbook", "copy": True}, {"run": "e_cf_move", "back": True}, {"run": "e8", "back": True}, {"wait": 0.6}])
S("buy", "", 1, label="token", title="Make a tunnel, keep its token", show=["cftoken", "e_cf_you"],
  caption="On Cloudflare's Tunnels page you make a tunnel and copy its token (eyJ…). Unlike a Tailscale key it is not used up, so you keep "
          "it in KeePass on your computer.",
  play=[{"run": "e_cf_you"}, {"pop": "tunnel made ✓"}, {"get": "vault"}, {"open": "vault"}, {"copy": "token", "from": "cftoken", "in": "vault"}, {"close": "vault"},
        {"run": "e_cf_you", "back": True}, {"put": "vault", "in": "you", "screen": True}, {"wait": 0.6}])
S("buy", "", 2, label="install", title="Install, then the tunnel dials out", show=INSTALL + TUN,
  caption="The installer bakes the domain into the install (the web server is built for api., cloud., … of exactly that name) and builds "
          "SelfPrivacy. At the end you paste the token: it goes to the server, which installs cloudflared and dials out to Cloudflare, four "
          "connections it keeps open. Nothing on your router opens.",
  play=INSTALL_PLAY([{"get": "token", "from": "you"}], True) + TOKEN_UP + [{"pop": "tunnel connected ✓ (4 connections out)"}, {"wait": 0.4}])
S("buy", "", 3, label="names", title="Add the five names; Cloudflare writes them", show=["e1"],
  caption="In the tunnel's settings you add the five names by hand (api, cloud, git, matrix and meet, each pointing to the server, with No TLS "
          "Verify). Cloudflare's helper then writes them in its phonebook by itself. The entries point to Cloudflare's relay, not to your "
          "server, so your home IP address never appears in public DNS.",
  play=[{"pop": "×5 names, by hand: api · cloud · git · matrix · meet", "dur": 1.6}, {"get": "domain"}] + yoshi("cfbook", "e1", True) + [{"run": "e_cf_up", "back": True}, {"wait": 0.4}])
SHARE_PLAY = HOME + [{"get": "domain"}, {"run": SHARE}, {"who": "jazz", "appear": "friend"}, {"give": "domain", "to": "jazz"}, {"run": SHARE, "back": True}, {"wait": 0.4}]   # FR148: the hand-over and the way home
S("buy", "", 4, label="share", title="Send your friend the link", show=["friend"] + SHARE,
  caption="You send your friend the link, for example in a chat message.", play=SHARE_PLAY)
S("buy", "", 5, label="friend", title="A friend opens the link", show=["e_friend", "e_cf_net"], visitors=True,
  caption="Your friend opens the link to call you on Jitsi Meet. The phone gets a Cloudflare address from Cloudflare's phonebook and connects "
          "to the nearest Cloudflare data center, which ends the encryption with Cloudflare's own certificate, so Cloudflare can read everything "
          "that passes. It sends the request through a connection your server keeps open; nothing on your router opens. Gaps today: after a "
          "reboot the tunnel is gone until you run the finish step again; requests over 100 MB are refused.",
  play=jazz_call("cfbook", "e_cf_net"))
S("buy", "r", 0, label="token", title="The token, the tunnel and the names are still yours", show=["you"], texts=T_BUY,
  stored=[{"id": "vault", "at": "you", "inside": ["token"]}],
  caption="You install again. The token is still valid, and the tunnel, its five names and the phonebook records all stay in your Cloudflare "
          "account: the token comes out of KeePass on your computer.",
  play=[{"appear": "you", "foot": True}, {"pop": "same token, same tunnel, same names"}, {"get": "token", "from": "you"}, {"get": "domain"}, {"wait": 0.4}])
S("buy", "r", 1, label="install again", title="Install again, the same addresses", show=INSTALL + TUN,
  caption="Paste the same token at the end: the server joins the same tunnel, the addresses stay the same and old links keep working. (A "
          "leaked token lets someone else run your tunnel: refresh it on the tunnel's page and run the finish step with the new one.)",
  play=INSTALL_PLAY([], True) + TOKEN_UP + [{"pop": "same tunnel ✓ — the same addresses"}, {"run": "e_cf_up", "back": True}, {"wait": 0.6}])
S("buy", "s", 0, label="backup", title="Back up to your backup device", texts=T_BUY, stored=[{"id": "vault", "at": "you", "inside": ["token"]}],
  show=["you"] + INSTALL + TUN + ["backupdev", "e_backup"],
  caption="Your server makes a backup. It goes through the tunnel and Cloudflare over the internet to your SelfPrivacy backup device, together "
          "with the KeePass vault that holds your tunnel token.",
  play=[{"appear": "you", "foot": True}, {"get": "vault", "from": "you"}, {"run": ["e_cable", "e_usb"]}, {"get": "backup", "from": "server"},
        {"run": "e_cf_up"}, {"run": "e_cf_run"}, {"run": "e_backup", "back": True},
        {"put": "backup", "in": "backupdev", "screen": "left"}, {"put": "vault", "in": "backupdev", "screen": "right"}, {"wait": 0.8}])
S("buy", "s", 1, label="fire", title="Your server is lost", show=[],
  caption="Then disaster: your server burns down (or it is stolen, or it breaks). What it held is now only on your backup device.",
  play=[{"burn": "server"}, {"wait": 0.6}])
S("buy", "s", 2, label="restore", title="Restore from the backup, the same tunnel", show=[],
  caption="You install again from the backup device: the install light, the backup and the token come back the same way. The server is built "
          "up again, gets its data back and joins the same tunnel with the same token: the same addresses, nothing to change.",
  play=[{"get": "light", "from": "backupdev"}, {"get": "backup", "from": "backupdev"}, {"get": "token", "from": "backupdev"},
        {"run": "e_backup"}, {"run": "e_cf_run", "back": True}, {"run": "e_cf_up", "back": True}, {"hammer": 3, "at": "server"}, {"put": "backup", "in": "server"},
        {"put": "token", "in": "server", "copy": True}] + TOKEN_UP + [{"pop": "same tunnel ✓ — the same addresses"}, {"run": "e_cf_up", "back": True}, {"wait": 0.6}])
# ---------------- the free quick tunnel (FR146) ----------------
T1, T2 = {"domain": NAME1}, {"domain": NAME2}
S("trycf", "", 0, label="install", title="Install, with a placeholder name", show=["you"] + INSTALL, texts=T1,
  caption="Nothing to make beforehand: no account, no domain, no key. In the installer you choose Cloudflare ▸ free *.trycloudflare.com, and it "
          "builds SelfPrivacy with a placeholder name (selfprivacy.box): the public name doesn't exist yet.",
  play=[{"get": "light"}, {"run": ["e_cable", "e_usb"]}, {"hammer": 3, "at": "server"}, {"pop": "placeholder name: selfprivacy.box", "dur": 1.4}, {"wait": 0.6}])
S("trycf", "", 1, label="tunnel", title="A quick tunnel, a random name", show=TUN,
  caption="At the end the installer installs cloudflared on the server and starts a quick tunnel, which dials out to Cloudflare. Cloudflare "
          "hands out a random name, pink-owl-sky.trycloudflare.com; the server writes it in its log, and the installer reads it from there "
          "and prints it. One name only: it points at the app's API.",
  play=[{"run": "e_cf_up"}, {"pop": "quick tunnel ✓"}, {"get": "domain"}, {"run": "e_cf_up", "back": True}, {"put": "domain", "in": "server", "copy": True}, {"wait": 0.6}])
S("trycf", "", 2, label="phonebook", title="Cloudflare writes the random name", show=["trybook", "e2"],
  caption="Cloudflare writes the random name in its own phonebook: trycloudflare.com is Cloudflare's domain, and the entry points to "
          "Cloudflare's relay.",
  play=yoshi("trybook", "e2", False) + [{"wait": 0.4}])
S("trycf", "", 3, label="share", title="Send your friend the link", show=["friend"] + SHARE,
  caption="You send your friend the link, for example in a chat message.", play=SHARE_PLAY)
S("trycf", "", 4, label="friend", title="A friend opens the link", show=["e_friend", "e_try_friend"], visitors=True,
  caption="Your friend opens the link to call you on Jitsi Meet. The phone gets a Cloudflare address from Cloudflare's phonebook. Cloudflare "
          "ends the encryption with its own *.trycloudflare.com certificate, so it can read the traffic, and passes the request through the "
          "connection your server keeps open. Limits: 200 requests at once, no live updates, no uptime guarantee. Gap today: every restart "
          "of the tunnel (a reboot, a crash) means a new random name, and after a reboot no tunnel until the finish step runs again.",
  play=jazz_call("trybook", "e_try_friend"))
S("trycf", "r", 0, label="install again", title="Install again", show=["you"] + INSTALL, texts=T2,
  caption="You install again, with the placeholder name as before. A new quick tunnel means a new name, as with any restart.",
  play=[{"get": "light"}, {"run": ["e_cable", "e_usb"]}, {"hammer": 3, "at": "server"}, {"pop": "placeholder name again", "dur": 1.2}, {"wait": 0.6}])
S("trycf", "r", 1, label="tunnel", title="A new quick tunnel, a new name", show=TUN,
  caption="Cloudflare hands out a new random name, quiet-river-fog.trycloudflare.com. Your friends' old links stop working, and the app has "
          "to be pointed at the new name.",
  play=[{"run": "e_cf_up"}, {"pop": "a NEW random name — old links stop working", "bad": True, "dur": 1.8}, {"get": "domain"}, {"run": "e_cf_up", "back": True},
        {"put": "domain", "in": "server", "copy": True}, {"wait": 0.6}])
S("trycf", "r", 2, label="phonebook", title="Cloudflare writes the new name", show=["trybook", "e2"],
  caption="Cloudflare writes the new name in its phonebook; the old one is simply gone.", play=yoshi("trybook", "e2", False) + [{"wait": 0.4}])
S("trycf", "s", 0, label="backup", title="Back up to your backup device", texts=T2, show=["you"] + INSTALL + TUN + ["backupdev", "e_backup"],
  caption="Your server makes a backup. It goes through the quick tunnel and Cloudflare over the internet to your SelfPrivacy backup device. "
          "(There is no token to keep: a quick tunnel has none.)",
  play=[{"appear": "you", "foot": True}, {"run": ["e_cable", "e_usb"]}, {"get": "backup", "from": "server"}, {"run": "e_cf_up"}, {"run": "e_cf_run"},
        {"run": "e_backup", "back": True}, {"put": "backup", "in": "backupdev", "screen": True}, {"wait": 0.8}])
S("trycf", "s", 1, label="fire", title="Your server is lost", show=[],
  caption="Then disaster: your server burns down (or it is stolen, or it breaks). What it held is now only on your backup device.",
  play=[{"burn": "server"}, {"wait": 0.6}])
S("trycf", "s", 2, label="restore", title="Restore from the backup, a new name", show=[],
  caption="You install again from the backup device: the install light and the backup come back the same way, the server is built up again "
          "and gets its data back. The new quick tunnel gets a new random name.",
  play=[{"get": "light", "from": "backupdev"}, {"get": "backup", "from": "backupdev"}, {"run": "e_backup"}, {"run": "e_cf_run", "back": True}, {"run": "e_cf_up", "back": True},
        {"hammer": 3, "at": "server"}, {"put": "backup", "in": "server"}, {"run": "e_cf_up"}, {"pop": "a NEW random name", "bad": True, "dur": 1.4}, {"get": "domain"},
        {"run": "e_cf_up", "back": True}, {"put": "domain", "in": "server", "copy": True}, {"wait": 0.6}])
S("trycf", "s", 3, label="phonebook", title="Cloudflare writes the new name", show=["trybook", "e2"],
  caption="Cloudflare writes the new name in its phonebook; your friends need the new link.", play=yoshi("trybook", "e2", False) + [{"wait": 0.4}])
d["steps"] = [s for s in d["steps"] if not s["id"].startswith(("cf", "tc"))] + steps
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False, sort_keys=True)
open(p, "a").write("\n")
print("Cloudflare steps written:", [s["id"] for s in steps])
