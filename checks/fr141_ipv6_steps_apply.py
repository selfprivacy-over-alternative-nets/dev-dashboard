"""FR141–FR144 — the Direct IPv6 stories: DuckDNS (FR141) and a bought domain (FR144), each told in the three scenarios (FR143),
with the IPv4 way blocked at the router (FR142). Run from dev-dashboard AFTER fr124_steps_apply.py and fr139_scenarios_apply.py:
    python3 checks/fr141_ipv6_steps_apply.py docs/diagrams/setup-map.json
Re-runnable: it replaces what it wrote before (the steps whose id starts with "v6", the IPv4 pipe e_v4, the IPv6 views' backup device)."""
import json, sys

p = sys.argv[1]
d = json.load(open(p))
SC = ["first", "reinstall", "restore"]
# FR143: the Scenario toggle is offered in the IPv6 views too — all three share one layout, so an IPv6 view's key ends in ;scenario=first
tg = next(t for t in d["meta"]["toggles"] if t["id"] == "scenario")
tg["optionsWhen"] = {"reach": {"tailscale": SC, "ipv6": SC}}
for o in d["nodes"] + d["edges"]:
    if o.get("hideIn"):
        o["hideIn"] = [k + ";scenario=first" if "reach=ipv6" in k and "scenario=" not in k else k for k in o["hideIn"]]
E = {e["id"]: e for e in d["edges"]}
N = {n["id"]: n for n in d["nodes"]}
for eid in ("e_share", "e_sharevm"):   # the line your friend gets the link over is drawn in the IPv6 views too
    E[eid]["showWhen"]["reach"] = ["tailscale", "ipv6"]
E["e9"]["ss"] = -10   # your line to DuckDNS leaves your computer's top 20 px further right, clear of the share line's stub
d["edges"] = [e for e in d["edges"] if e["id"] not in ("e_v4", "e_backup6")]
d["nodes"] = [n for n in d["nodes"] if n["id"] != "backupdev6"]
# FR142: the IPv4 way — a yellow pipe out of the internet's bottom (right of the blue IPv6 one) that ends at the router's wall below the
# IPv6 exit: nobody gets through (no port-forward); its label on its long level stretch
d["edges"].append({"id": "e_v4", "from": "inet", "to": "router", "kind": "pipe", "role": "tunnel", "color": "#eab308", "label": "IPv4 · blocked: no port-forward",
                   "_H": True, "so": 265, "ss": 50, "eo": 100, "blocked": True, "labelMid": True, "showWhen": {"method": ["cable", "wifi", "usb"], "reach": ["ipv6"]}})
# FR143: the IPv6 views' backup device — right of the DuckDNS note, left of your friend's lookup line; its pipe drops into the internet's top
d["nodes"].append({"id": "backupdev6", "label": "SelfPrivacy\nbackup device", "nodeType": "device", "icon": "laptop", "color": "green",
                   "x": 1045, "y": -20, "w": 137, "h": 167, "showWhen": {"reach": ["ipv6"], "scenario": ["restore"]}})
d["edges"].append({"id": "e_backup6", "from": "backupdev6", "to": "inet", "kind": "pipe", "role": "tunnel", "color": "#8b949e", "label": "",
                   "so": 47.0, "eo": -26.9, "showWhen": {"reach": ["ipv6"], "scenario": ["restore"]}})   # (straight down from the laptop's right-hand edge, clear of its label)
HOST = {"duckdns": "yourname.duckdns.org", "buy": "yourdomain.org"}
BOOK = {"duckdns": "duck", "buy": "pbook"}
LOOKUP = {"duckdns": "e_duck", "buy": "e_pb_friend"}
for nm in ("duckdns", "buy"):   # the book's entry: the server's own address — a new one after a reinstall or a restore (FR143, nested entryWhen)
    N[BOOK[nm]]["entryWhen"] = {"reach": {"ipv6": {"entry": f"https://{HOST[nm]}\n→ your ip, like: 2001:db8::1",
                                                    "scenario": {s: f"https://{HOST[nm]}\n→ your ip, like: 2001:db8::2" for s in ("reinstall", "restore")}}}}
IP1, IP2 = "Your SelfPrivacy IPv6 address:\n2001:db8::1", "Your SelfPrivacy IPv6 address:\n2001:db8::2"
INSTALL = ["server", "router", "e_cable", "e_usb", "e_wifi", "e_scable"]
FW = ["inet", "e_v6", "v6warn", "v6warnVM", "e_v6you", "e_v6youVM", "e_v6open"]
HOME = [{"run": ["e_cable", "e_usb"], "back": True}]
# the fire wall, by hand: from your computer along the note's line to the gate; the wall slides open and the address goes into the router
OPENFW = HOME + [{"get": "ip"}, {"run": ["e_v6you", "e_v6youVM"]}, {"run": "e_v6open"}, {"open": "firewall", "of": "router"}, {"put": "ip", "in": "router"},
                 {"pop": "TCP 443 → 2001:db8::1 ✓"}, {"run": "e_v6open", "back": True}, {"run": ["e_v6you", "e_v6youVM"], "back": True}, {"wait": 0.4}]
# …again, after a reinstall / restore: the old opening named the old address, so the wall is shut for the new one — open it once more
FW_AGAIN = HOME + [{"get": "ip"}, {"run": ["e_v6you", "e_v6youVM"]}, {"run": "e_v6open"}, {"close": "firewall", "of": "router"},
                   {"pop": "the old opening: the old address", "bad": True, "dur": 1.6}, {"open": "firewall", "of": "router"}, {"put": "ip", "in": "router"},
                   {"pop": "TCP 443 → 2001:db8::2 ✓"}, {"run": "e_v6open", "back": True}, {"run": ["e_v6you", "e_v6youVM"], "back": True}, {"wait": 0.4}]
# the install: the light and the name (and for DuckDNS the token, out of KeePass on your computer) go down the cable; the server is built up, the
# name and the token go in, and its IPv6 address comes out — Mario keeps only the address (he gets the name again when he shares it)
INSTALL_PLAY = lambda get, token, pop: [{"get": "light"}] + get + [{"run": ["e_cable", "e_usb"]}, {"hammer": 3, "at": "server"}, {"put": "domain", "in": "server"}] + \
    ([{"put": "token", "in": "server"}] if token else []) + [{"get": "ip", "from": "server"}, {"pop": pop}, {"wait": 0.6}]
TOKEN = [{"get": "token", "from": "you"}]   # the token comes out of KeePass on your computer's screen
def friend(nm):   # FR136 / FR142: Jazz gets the address from Mario, looks it up, goes straight to the server through the open fire wall and back with the call; then a knock on the IPv4 way
    bk, lk = BOOK[nm], LOOKUP[nm]
    return [{"who": "jazz", "appear": "friend"}, {"give": "domain", "to": "jazz"}, {"run": ["e_share", "e_sharevm"], "back": True},
            {"who": "jazz", "run": "e_friend"}, {"who": "jazz", "run": lk, "back": True}, {"who": "jazz", "lookup": bk},
            {"who": "jazz", "run": lk}, {"who": "jazz", "run": "e_v6", "back": True},
            {"who": "jazz", "put": "answer", "in": "server"}, {"who": "jazz", "show": "jitsi", "at": "server"}, {"who": "jazz", "get": "jitsi", "from": "server"},
            {"who": "jazz", "run": "e_v6"}, {"who": "jazz", "run": "e_friend", "back": True}, {"who": "jazz", "show": "jitsi", "at": "friend"},
            {"wait": 0.4}, {"knock": "e_v4"}, {"wait": 0.6}]
GAPS = [{"who": "jazz", "run": "e_friend"}, {"who": "jazz", "run": "e_v6", "back": True},
        {"who": "jazz", "pop": "✕ refused: the server listens on IPv4 only", "bad": True, "dur": 2.4},
        {"who": "jazz", "run": "e_v6"}, {"who": "jazz", "run": "e_friend", "back": True}, {"wait": 0.8}]
FRIEND_CAP = {"duckdns": "Your friend opens the link to call you on Jitsi Meet. The phone asks DuckDNS, gets your server's IPv6 address and goes straight "
                         "to your server: across the internet and through the opening in your fire wall. No company in between. Over IPv4 nobody gets "
                         "in: the router has no port-forward, and a friend on an IPv4-only network can't open the link at all.",
              "buy": "Your friend opens the link to call you on Jitsi Meet. The phone asks the registrar's phonebook, gets your server's IPv6 address "
                     "and goes straight to your server through the opening in your fire wall. No company in between. Over IPv4 nobody gets in: the "
                     "router has no port-forward, and a friend on an IPv4-only network can't open the link at all."}
GAPS_CAP = {"duckdns": "Today the call would not get through: the server's web server listens on IPv4 only, so an IPv6 visitor is refused at the door "
                       "(fix: listen on [::]:443 too). Also: no automatic certificate, so browsers warn; the updater may send a temporary address that "
                       "changes daily; and its service is lost on reboot, so the entry goes stale after a restart.",
            "buy": "Today the call would not get through: the server's web server listens on IPv4 only, so an IPv6 visitor is refused at the door "
                   "(fix: listen on [::]:443 too). Also: no automatic certificate, so browsers warn (DNS-01 through the registrar's API, or HTTP-01 "
                   "over port 80, would fix it); and the installer prints only the bare domain's record, not the five you need."}
steps = []
W = lambda nm, s: {"reach": ["ipv6"], "name": [nm], "scenario": [s]}
S = lambda nm, s, i, **k: steps.append({"id": f"v6{'d' if nm == 'duckdns' else 'b'}{s}{i}", "showWhen": W(nm, {"": "first", "r": "reinstall", "s": "restore"}[s]), **k})
for nm in ("duckdns", "buy"):
    duck, host, bk, lk = nm == "duckdns", HOST[nm], BOOK[nm], LOOKUP[nm]
    # ---- first install (FR141 / FR144) ----
    if duck:
        S(nm, "", 0, label="account", title="Claim a DuckDNS name, keep the token", show=["you", "duck", "e9"], texts={"domain": host, "ip": IP1},
          caption="First you sign in at duckdns.org (with a GitHub, Google, … account) and claim a free name: yourname.duckdns.org. You also copy "
                  "your account's token. It is not used up, so you keep it in KeePass on your computer.",
          play=[{"run": "e9"}, {"pop": "name claimed ✓"}, {"get": "domain"}, {"get": "vault"}, {"open": "vault"}, {"copy": "token", "from": "duck", "in": "vault"},
                {"close": "vault"}, {"run": "e9", "back": True}, {"put": "vault", "in": "you", "screen": True}, {"wait": 0.6}])
        S(nm, "", 1, label="install", title="Install, with the name baked in", show=INSTALL,
          caption="The installer bakes the name into the install and builds SelfPrivacy on your server. At the end it finds the server's public "
                  "IPv6 address and asks for the DuckDNS token: from now on the server keeps DuckDNS up to date by itself.",
          play=INSTALL_PLAY(TOKEN, True, "IPv6 found ✓"))
        S(nm, "", 2, label="phonebook", title="The server writes its own entry", show=["e_duck_srv"],
          caption="No helper at a company: every 5 minutes your server sends its IPv6 address to DuckDNS, which writes it in its phonebook under "
                  "your name. The entry is your server's own address, which anyone can look up.",
          play=[{"update": "duck"}, {"pop": "again every 5 minutes"}, {"wait": 0.4}])
    else:
        S(nm, "", 0, label="domain", title="Buy a domain", show=["you", "pbook", "e_pb_you"], texts={"domain": host, "ip": IP1},
          caption="First you buy a domain at a registrar (a shop for domain names, €/yr). The registrar's phonebook will hold your records, and "
                  "you edit them by hand on its website.",
          play=[{"run": "e_pb_you"}, {"pop": "bought ✓ (€/yr)"}, {"get": "domain"}, {"run": "e_pb_you", "back": True}, {"wait": 0.6}])
        S(nm, "", 1, label="install", title="Install, with the domain baked in", show=INSTALL,
          caption="The installer bakes the domain into the install and builds SelfPrivacy on your server. At the end it finds the server's public "
                  "IPv6 address and prints it. On this route nothing on the server updates the phonebook.",
          play=INSTALL_PLAY([], False, "IPv6 found ✓"))
        S(nm, "", 2, label="phonebook", title="Write the address in the phonebook, by hand", show=[],
          caption="You write the server's IPv6 address in the registrar's phonebook yourself: an AAAA record for api.yourdomain.org, and the same "
                  "for cloud., git., matrix. and meet. (Gap today: the installer prints only one record, for the bare domain.)",
          play=HOME + [{"run": "e_pb_you"}, {"write": "pbook"}, {"pop": "×5: api · cloud · git · matrix · meet"}, {"run": "e_pb_you", "back": True}, {"wait": 0.4}])
    S(nm, "", 3, label="fire wall", title="Open the router's fire wall by hand", show=FW,
      caption="On IPv6 the router has no receptionist (no port-forward), only a fire wall, and most home routers let no visitor in until you open "
              "it. You do that once, by hand, in the router's settings: allow TCP 443 to the server's IPv6 address, which the installer printed.",
      play=OPENFW)
    S(nm, "", 4, label="share", title="Send your friend the link", show=["friend", "e_share", "e_sharevm"],
      caption="You send your friend the link, for example in a chat message.", play=[{"get": "domain"}, {"run": ["e_share", "e_sharevm"]}, {"wait": 0.6}])
    S(nm, "", 5, label="friend", title="A friend opens the link", show=["e_friend", lk, "e_v4"], caption=FRIEND_CAP[nm], play=friend(nm))
    S(nm, "", 6, label="gaps", title="Gaps in this project today", show=[], caption=GAPS_CAP[nm], play=GAPS)
    # ---- reinstall (FR143): the name stays, the server gets a new address — the phonebook and the fire wall again ----
    T2 = {"domain": host, "ip": IP2}
    if duck:
        S(nm, "r", 0, label="token", title="The name and the token are still yours", show=["you"], texts=T2,
          stored=[{"id": "vault", "at": "you", "inside": ["token"]}], gates={"router": {"firewall": 1}},
          caption="You install again. Your DuckDNS name stays in your account and the token is still valid: you take it out of KeePass on your "
                  "computer. (The fire wall is still open, for the old address.)",
          play=[{"appear": "you", "foot": True}, {"pop": "same name, same token"}] + TOKEN + [{"get": "domain"}, {"wait": 0.4}])
    else:
        S(nm, "r", 0, label="domain", title="The domain is still yours", show=["you"], texts=T2, gates={"router": {"firewall": 1}},
          caption="You install again. The domain stays yours at the registrar, and its phonebook still holds the old address. (The fire wall is "
                  "still open, for the old address.)",
          play=[{"appear": "you", "foot": True}, {"pop": "same domain"}, {"get": "domain"}, {"wait": 0.4}])
    S(nm, "r", 1, label="install again", title="Install again: a new IPv6 address", show=INSTALL,
      caption=("The installer builds SelfPrivacy again with the same name and takes the same token. " if duck else
               "The installer builds SelfPrivacy again with the same domain. ")
              + "But the server's IPv6 address is made from a secret created during the install, so it probably gets a new one.",
      play=INSTALL_PLAY([], duck, "a NEW address"))
    if duck:
        S(nm, "r", 2, label="phonebook", title="The old entry is overwritten", show=["duck", "e_duck_srv"],
          caption="Within 5 minutes the server sends its new address to DuckDNS, which overwrites the old entry (2001:db8::1). Your friends' link "
                  "keeps working… once the router lets them in again.",
          play=[{"update": "duck"}, {"pop": "old entry replaced ✓"}, {"wait": 0.4}])
    else:
        S(nm, "r", 2, label="phonebook", title="Edit the records again, by hand", show=["pbook", "e_pb_you"],
          caption="Nothing updates the registrar's phonebook for you: edit the five AAAA records by hand to the new address. Until then friends "
                  "get the old address, and phonebooks along the way may remember it for an hour or more.",
          play=HOME + [{"run": "e_pb_you"}, {"write": "pbook"}, {"pop": "×5 records → the new address"}, {"run": "e_pb_you", "back": True}, {"wait": 0.4}])
    S(nm, "r", 3, label="fire wall", title="Open the fire wall again", show=FW,
      caption="The opening you made named the old address, so for the new one the fire wall is shut again. Open it once more, by hand, for "
              "TCP 443 to the new address.", play=FW_AGAIN)
    # ---- restore a backup (FR143): like Tailscale's, over the internet with no company in between; the restored server has a new address ----
    S(nm, "s", 0, label="backup", title="Back up to your backup device", texts=T2, gates={"router": {"firewall": 1}},
      show=["you", "server", "router", "e_cable", "e_usb", "e_wifi", "e_scable", "inet", "e_v6", "backupdev6", "e_backup6"],
      **({"stored": [{"id": "vault", "at": "you", "inside": ["token"]}]} if duck else {}),
      caption="Your server makes a backup. It goes out through your router (the fire wall only stops what comes in) and straight over the "
              "internet to your SelfPrivacy backup device" + (", together with the KeePass vault that holds your DuckDNS token." if duck else "."),
      play=[{"appear": "you", "foot": True}] + ([{"get": "vault", "from": "you"}] if duck else []) + [{"run": ["e_cable", "e_usb"]}, {"get": "backup", "from": "server"},
            {"run": "e_v6"}, {"run": "e_backup6", "back": True}]
           + ([{"put": "backup", "in": "backupdev6", "screen": "left"}, {"put": "vault", "in": "backupdev6", "screen": "right"}] if duck
              else [{"put": "backup", "in": "backupdev6", "screen": True}]) + [{"wait": 0.8}])
    S(nm, "s", 1, label="fire", title="Your server is lost", show=[],
      caption="Then disaster: your server burns down (or it is stolen, or it breaks). What it held is now only on your backup device.",
      play=[{"burn": "server"}, {"wait": 0.6}])
    S(nm, "s", 2, label="restore", title="Restore from the backup", show=[],
      caption="You install again, from the backup device: the install light and the backup" + (" and the KeePass vault" if duck else "")
              + " come back over the internet to where the server stood. The server is built up again and gets its data back from the backup"
              + (" and the DuckDNS token from KeePass" if duck else "") + ". But it is a new install, so it probably has a new IPv6 address.",
      play=[{"get": "light", "from": "backupdev6"}, {"get": "backup", "from": "backupdev6"}] + ([{"get": "token", "from": "backupdev6"}] if duck else [])
           + [{"run": "e_backup6"}, {"run": "e_v6", "back": True}, {"hammer": 3, "at": "server"}, {"put": "backup", "in": "server"}]
           + ([{"put": "token", "in": "server"}] if duck else [])
           + [{"get": "ip", "from": "server"}, {"pop": "a NEW address"}, {"wait": 0.6}])
    if duck:
        S(nm, "s", 3, label="phonebook", title="The server writes its new address", show=["duck", "e_duck_srv"],
          caption="Within 5 minutes the restored server sends its new address to DuckDNS, which overwrites the old entry.",
          play=[{"update": "duck"}, {"pop": "old entry replaced ✓"}, {"wait": 0.4}])
    else:
        S(nm, "s", 3, label="phonebook", title="Edit the records again, by hand", show=["pbook", "e_pb_you"],
          caption="Nothing updates the registrar's phonebook for you: edit the five AAAA records by hand to the restored server's new address.",
          play=HOME + [{"run": "e_pb_you"}, {"write": "pbook"}, {"pop": "×5 records → the new address"}, {"run": "e_pb_you", "back": True}, {"wait": 0.4}])
    S(nm, "s", 4, label="fire wall", title="Open the fire wall again", show=FW,
      caption="The fire wall opening named the old address, so open it once more, by hand, for the new one.", play=FW_AGAIN)
d["steps"] = [s for s in d["steps"] if not s["id"].startswith("v6")] + steps
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False, sort_keys=True)
open(p, "a").write("\n")
print("IPv6 steps written:", [s["id"] for s in steps])
