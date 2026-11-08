"""FR124 — the Tailscale view told in steps (docs/diagrams/network_explanations.md "Steps and components").
Writes d["steps"] into the diagram. Run from dev-dashboard: python3 checks/fr124_steps_apply.py docs/diagrams/setup-map.json"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from keep_layout import put   # an editor change to an item survives a re-run

p = sys.argv[1]
d = json.load(open(p))
TS = {"reach": ["tailscale"], "scenario": ["first"]}   # FR139: the first install is one of three scenarios (then run fr139_scenarios_apply.py)
# e4 (the user's you <-> Tailscale line) ran off the drawing: route it down from the laptop, along the bottom under the
# router, and up into Tailscale (FR79 offsets, so the line still follows the boxes if they move)
E = {e["id"]: e for e in d["edges"]}
# FR130: the line your friend gets the link over — from the top of your computer, over everything, down beside the phone and in from
# its right (box views; the VM views, where your computer is a box around the server, have their own copy)
SHARE = {"kind": "plain", "role": "info", "dir": "to", "cost": "free", "label": "you send your friend the link", "from": "you", "to": "friend",
         "_H": True, "eo": -510.5, "es": 100, "ef": 0}
for eid, extra in (("e_share", {"so": -275, "ss": -41, "showWhen": {"method": ["cable", "wifi", "usb"], "reach": ["tailscale"]}}),
                   ("e_sharevm", {"so": -322.5, "ss": -60, "showWhen": {"method": ["vm"], "reach": ["tailscale"]}})):
    put(d["edges"], {"id": eid, **SHARE, **extra})
if "e4" in E and E["e4"].get("so") != 648 and "bp" in E["e4"]:   # (the one-time re-route of FR124; a later editor change to e4 is kept)
    for k in ("bp", "ss", "es", "sf", "ef", "ah", "path"):
        E["e4"].pop(k, None)
    E["e4"].update(so=648, mo=382, eo=21)
if "e4" in E:
    E["e4"]["showWhen"] = {"method": ["cable", "wifi", "usb"], "reach": ["tailscale"]}   # every box view (in the VM view it would cut through the tslife note)
d["steps"] = [
    {"id": "ts0", "showWhen": TS, "label": "account", "title": "Make a Tailscale account",
     "show": ["you", "inet", "relayTS", "e_ts_run", "e4"],
     "caption": "First you make a Tailscale account and get a one-time auth key from Tailscale.",
     "play": [{"run": "e4"}, {"pop": "account ✓"}, {"get": "key"}, {"run": "e4", "back": True}, {"wait": 0.8}]},
    {"id": "ts1", "showWhen": TS, "label": "install", "title": "Install, then register at Tailscale",
     "show": ["server", "router", "e_cable", "e_usb", "e_wifi", "e_scable", "e_ts_up"],
     "caption": "You give the one-time auth key you got from Tailscale to your SelfPrivacy server. "
                "That machine registers itself at Tailscale, which keeps a copy of its IP address, and gets a domain name.",
     "play": [{"get": ["key", "light"]}, {"run": ["e_cable", "e_usb"]}, {"hammer": 3, "at": "server"}, {"get": "ip"}, {"run": "e_ts_up"},
              # FR128 / FR129 / FR132: at Tailscale — a ledge with the fire bowl, two safes and a shelf with two boards; first a
              # copy of the IP goes on the shelf's bottom board (Mario keeps the IP); the auth key opens safe A and is thrown into
              # the fire; the own key from A opens safe B (two copies of the domain): one copy goes on the shelf's top board, the
              # other comes along; back at the server the IP goes back in
              {"scene": {"A": "idkey", "B": ["domain", "domain"]}},
              {"walk": "S"}, {"put": "ip", "in": "S.bottom", "copy": True},
              {"walk": "A"}, {"put": "key", "in": "A.lock"}, {"open": "A"}, {"fire": True},
              {"take": "key", "from": "A.lock"}, {"throw": "key", "in": "F"}, {"take": "idkey", "from": "A"}, {"close": "A"},
              {"walk": "B"}, {"put": "idkey", "in": "B.lock"}, {"open": "B"}, {"take": "domain", "from": "B"},
              {"walk": "S"}, {"put": "domain", "in": "S.top"},
              {"walk": "B"}, {"take": "domain", "from": "B"}, {"take": "idkey", "from": "B.lock"}, {"close": "B"},
              {"walk": "O"}, {"run": "e_ts_up", "back": True}, {"put": "ip", "in": "server"}, {"wait": 1}]},
    {"id": "ts2", "showWhen": TS, "label": "phonebook", "title": "Tailscale writes the name in its phonebook",
     "show": ["tsbook", "e3"],
     "caption": "Tailscale keeps its own DNS phonebook. Its helper takes your domain name and your server's IP address "
                "from the shelf and writes them in. The name points to Tailscale's relay, which passes visitors on to your server.",
     # FR129 / FR132: Yoshi comes out of the Tailscale cloud, takes the domain and the IP off the shelf, climbs to the
     # phonebook and writes the entry; the scene from step 1 fades once Yoshi is down again
     "play": [{"who": "yoshi", "appear": "relayTS"}, {"who": "yoshi", "walk": "S"},
              {"who": "yoshi", "take": "domain", "from": "S.top"}, {"who": "yoshi", "take": "ip", "from": "S.bottom"},
              {"who": "yoshi", "walk": "O"}, {"scene": False}, {"who": "yoshi", "run": "e3"}, {"who": "yoshi", "write": "tsbook"},
              {"who": "yoshi", "run": "e3", "back": True}, {"who": "yoshi", "vanish": True}]},
    {"id": "tskeep", "showWhen": TS, "label": "backup", "title": "Keep a copy of the server's own key",
     "show": [],
     "caption": "The server keeps its own key (its ID file). You keep a copy, locked in KeePass on your computer, so a "
                "reinstall can come back as the same machine (planned: round0 R2). The Tailscale address comes along too.",
     # FR130 / FR135: the own key goes into the server; a copy comes out into a KeePass vault (opened, then shut), carried home above its head
     "play": [{"put": "idkey", "in": "server"}, {"get": "vault"}, {"open": "vault"}, {"copy": "idkey", "from": "server", "in": "vault"},
              {"close": "vault"}, {"run": ["e_cable", "e_usb"], "back": True}, {"put": "vault", "in": "you", "screen": True}, {"wait": 0.6}]},   # FR138: it stays on the screen
    {"id": "tsshare", "showWhen": TS, "label": "share", "title": "Send your friend the link",
     "show": ["friend", "e_share", "e_sharevm"],
     "caption": "You send your Tailscale address to a friend, for example in a chat message.",
     # FR130: the line from your computer to the friend's phone; Mario carries the address over, Jazz (your friend) comes out of the
     # phone and takes it, and Mario goes home (FR148: all in this step, so the friend's step starts with your friend on the way)
     "play": [{"run": ["e_share", "e_sharevm"]}, {"who": "jazz", "appear": "friend"}, {"give": "domain", "to": "jazz"}, {"run": ["e_share", "e_sharevm"], "back": True}, {"wait": 0.4}]},
    {"id": "ts3", "showWhen": TS, "label": "friend", "title": "A friend opens the link",
     "show": ["friend", "e_friend", "e_ts_friend"], "visitors": True,   # FR126: someone comes in at the router's gates
     "caption": "Your friend opens the Tailscale address to call you on Jitsi Meet. The phone looks the name up in the DNS "
                "phonebook and gets the address it points to, then goes through the internet, Tailscale's relay and the tunnel "
                "to your SelfPrivacy server, and the call comes back the same way.",
     # FR136: Jazz (who got the address from Mario in the share step, FR148) goes over the internet to the book, which opens: the name
     # goes in, the ip on Yoshi's line comes out; back over the internet, via Tailscale down the tunnel to your server, where the
     # call (Jitsi Meet) shows up; Jazz takes a copy back through the tunnels to the phone, where it shows up too
     "play": [{"who": "jazz", "run": "e_friend"}, {"who": "jazz", "run": "e_ts_friend", "back": True}, {"who": "jazz", "lookup": "tsbook"},
              {"who": "jazz", "run": "e_ts_friend"}, {"who": "jazz", "run": "e_ts_run", "back": True}, {"who": "jazz", "run": "e_ts_up", "back": True},
              {"who": "jazz", "put": "answer", "in": "server"}, {"who": "jazz", "show": "jitsi", "at": "server"},
              {"who": "jazz", "get": "jitsi", "from": "server"},
              {"who": "jazz", "run": "e_ts_up"}, {"who": "jazz", "run": "e_ts_run"}, {"who": "jazz", "run": "e_friend", "back": True},
              {"who": "jazz", "show": "jitsi", "at": "friend"}, {"wait": 1.5}]},
]
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False, sort_keys=True)
open(p, "a").write("\n")
print("steps:", len(d["steps"]))
