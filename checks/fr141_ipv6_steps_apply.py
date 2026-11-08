"""FR141–FR144 — the Direct IPv6 stories: DuckDNS (FR141) and a bought domain (FR144), each told in the three scenarios (FR143),
with the IPv4 way blocked at the router (FR142). Run from dev-dashboard AFTER fr124_steps_apply.py and fr139_scenarios_apply.py:
    python3 checks/fr141_ipv6_steps_apply.py docs/diagrams/setup-map.json
Re-runnable: it replaces what it wrote before (the steps whose id starts with "v6", the IPv4 pipe e_v4, the IPv6 views' backup device,
FR149 / FR150's second phone friend4 with its lines e_friend4 and e_share2)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from keep_layout import put   # an editor change to an item survives a re-run

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
if E["e9"].get("ss") == -30:
    E["e9"]["ss"] = -10   # (once) your line to DuckDNS leaves your computer's top 20 px further right, clear of the share line's stub
# FR142: the IPv4 way — a yellow pipe out of the internet's bottom (right of the blue IPv6 one) that ends at the router's wall below the
# IPv6 exit: nobody gets through (no port-forward); its label on its long level stretch
put(d["edges"], {"id": "e_v4", "from": "inet", "to": "router", "kind": "pipe", "role": "tunnel", "color": "#eab308", "label": "IPv4 · blocked: no port-forward",
                   "_H": True, "so": 265, "ss": 50, "eo": 100, "blocked": True, "labelMid": True, "showWhen": {"method": ["cable", "wifi", "usb"], "reach": ["ipv6"]}})
# FR143: the IPv6 views' backup device — right of the DuckDNS note, left of your friend's lookup line; its pipe drops into the internet's top
put(d["nodes"], {"id": "backupdev6", "label": "SelfPrivacy\nbackup device", "nodeType": "device", "icon": "laptop", "color": "green",
                   "x": 1045, "y": -20, "w": 137, "h": 167, "showWhen": {"reach": ["ipv6"], "scenario": ["restore"]}})
put(d["edges"], {"id": "e_backup6", "from": "backupdev6", "to": "inet", "kind": "pipe", "role": "tunnel", "color": "#8b949e", "label": "",
                   "so": 47.0, "eo": -26.9, "showWhen": {"reach": ["ipv6"], "scenario": ["restore"]}})   # (straight down from the laptop's right-hand edge, clear of its label)
# FR149: DuckDNS — two friends: the phone you had (on IPv6) and a phone on an IPv4-only network, under the internet (clear of the step's caption
# panel), with a short pipe straight up into the internet; Mario's line from under the first phone on to the second (the box views: the IPv4 way
# is drawn there only). FR150: the same two phones for a bought domain.
BOXV = ["cable", "wifi", "usb"]
TWO = {"method": BOXV, "reach": ["ipv6"], "name": ["duckdns", "buy"]}
N["friend"]["labelWhen"] = {"reach": {"ipv6": {"name": {"duckdns": "A friend's phone · IPv6", "buy": "A friend's phone · IPv6"}}}}
put(d["nodes"], {"id": "friend4", "label": "A friend's phone · IPv4 only", "nodeType": "device", "icon": "phone", "color": "input",
                 "x": 1159, "y": 400, "w": 160, "h": 100, "showWhen": TWO})
put(d["edges"], {"id": "e_friend4", "from": "friend4", "to": "inet", "kind": "pipe", "role": "tunnel", "color": "#6e7681", "label": "",
                 "_H": False, "eo": 50, "showWhen": TWO})
put(d["edges"], {"id": "e_share2", "from": "friend", "to": "friend4", "kind": "plain", "role": "info", "dir": "to", "cost": "free", "label": "",
                 "_H": False, "so": 60, "eo": 50, "showWhen": TWO})
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
def friend(nm):   # FR136 / FR147 / FR148: Jazz (who got the address from Mario in the share step) looks it up; at the internet he first tries the yellow IPv4 way and is bounced at its
    # entry (a forbidden sign on the pipe, its label lit up, "refused"), then goes straight to the server over IPv6 through the open fire wall and back with the call
    bk, lk = BOOK[nm], LOOKUP[nm]
    return [{"who": "jazz", "run": "e_friend"}, {"who": "jazz", "run": lk, "back": True}, {"who": "jazz", "lookup": bk},
            {"who": "jazz", "run": lk}, {"who": "jazz", "bounce": "e_v4", "at": 40, "say": "✕ refused over IPv4"}, {"who": "jazz", "run": "e_v6", "back": True},
            {"who": "jazz", "put": "answer", "in": "server"}, {"who": "jazz", "show": "jitsi", "at": "server"}, {"who": "jazz", "get": "jitsi", "from": "server"},
            {"who": "jazz", "run": "e_v6"}, {"who": "jazz", "run": "e_friend", "back": True}, {"who": "jazz", "show": "jitsi", "at": "friend"}, {"wait": 1}]
# FR149: DuckDNS — Jazz (the IPv6 phone) and his cousin (the IPv4-only phone) set off together; up the lookup line the cousin follows a little
# behind and waits its turn in the queue; it gets the IPv4 card. Going down it leads: at the internet it tries the yellow IPv4 pipe and is bounced
# (it can use no other way) and goes home without a call (the address goes into its phone), while Jazz goes on over IPv6 to your server and back with the call.
# FR150: the same for a bought domain — but the registrar's phonebook holds only the IPv6 records you wrote, so the cousin's card says so
C4 = lambda **k: {"who": "cousin", "when": "friend4", **k}   # (only in the views that draw the second phone)
ANSWER4 = {"duckdns": "ip 203.0.113.7", "buy": "no IPv4 address"}   # what the IPv4-only phone gets: at most your router's address / nothing
SAY4 = {"duckdns": "✕ refused over IPv4", "buy": "✕ no IPv4 address"}
def friends2(nm):
    bk, lk = BOOK[nm], LOOKUP[nm]
    return [{"together": [{"who": "jazz", "run": "e_friend"}, C4(run="e_friend4")]},
            {"together": [[{"who": "jazz", "run": lk, "back": True}, {"who": "jazz", "lookup": bk}],
                          [C4(wait=0.6), C4(run=lk, back=True, near=140), C4(lookup=bk, **{"as": "answer4"})]]},
            {"together": [[C4(run=lk, **{"from": "here"}), C4(bounce="e_v4", at=40, say=SAY4[nm]), C4(run="e_friend4", back=True),
                           C4(put="answer4", **{"in": "friend4"}), C4(pop="✕ no call", bad=True, dur=2)],
                          [{"who": "jazz", "wait": 0.5}, {"who": "jazz", "run": lk}, {"who": "jazz", "run": "e_v6", "back": True},
                           {"who": "jazz", "put": "answer", "in": "server"}, {"who": "jazz", "show": "jitsi", "at": "server"}, {"who": "jazz", "get": "jitsi", "from": "server"},
                           {"who": "jazz", "run": "e_v6"}, {"who": "jazz", "run": "e_friend", "back": True}, {"who": "jazz", "show": "jitsi", "at": "friend"}]]},
            {"wait": 1}]
# FR149: Mario takes the link to both phones in one trip: to the first (a copy for Jazz), on to the second (the cousin), and back home
SHARE2 = [{"get": "domain"}, {"run": ["e_share", "e_sharevm"]}, {"who": "jazz", "appear": "friend"}, {"give": "domain", "to": "jazz", "copy": True},
          {"run": "e_share2"}, {"who": "cousin", "appear": "friend4"}, {"give": "domain", "to": "cousin"},
          {"run": "e_share2", "back": True}, {"run": ["e_share", "e_sharevm"], "back": True}, {"wait": 0.4}]
FRIEND_CAP1 = {   # the VM views: one friend
    "duckdns": "Your friend opens the link to call you on Jitsi Meet. The phone gets your server's IPv6 address from DuckDNS. Over IPv4 it is "
               "refused: the router has no port-forward, so an IPv4-only friend can't open the link. Over IPv6 it goes straight to your server "
               "through the opening in your fire wall: no company in between. Gaps today: the web server listens on IPv4 only, so this call is "
               "still refused; no automatic certificate; the updater may send a temporary address and is lost on reboot.",
    "buy": "Your friend opens the link to call you on Jitsi Meet. The phone gets your server's IPv6 address from the registrar's phonebook. Over "
           "IPv4 it is refused: the router has no port-forward, so an IPv4-only friend can't open the link. Over IPv6 it goes straight to your "
           "server through the opening in your fire wall: no company in between. Gaps today: the web server listens on IPv4 only, so this call "
           "is still refused; no automatic certificate; the installer prints only the bare domain's record."}
FRIEND_CAP = {   # FR148: the friend's call is the story's last step; the route's gaps today close its caption (FR149 / FR150: the two friends)
    "duckdns": "Your two friends open the link at the same time, to call you on Jitsi Meet; both phones ask DuckDNS. The phone on IPv6 gets your "
               "server's IPv6 address and goes straight to your server, through the opening in your fire wall: no company in between. The other "
               "phone has IPv4 only. Over IPv4 DuckDNS has at most your router's address (the server sends only its IPv6 one), and the router "
               "refuses: no port-forward, so that friend can't open the link. Gaps today: the web server listens on IPv4 only, so even the IPv6 "
               "call is still refused; no automatic certificate; the updater may send a temporary address and is lost on reboot.",
    "buy": "Your two friends open the link at the same time, to call you on Jitsi Meet; both phones ask the registrar's phonebook. The phone on "
           "IPv6 gets your server's IPv6 address and goes straight to your server, through the opening in your fire wall: no company in between. "
           "The other phone has IPv4 only, and the phonebook holds only the IPv6 records you wrote: no IPv4 address (one for your router "
           "wouldn't help: no port-forward), so that friend can't open the link. Gaps today: the web server listens on IPv4 only, so even the "
           "IPv6 call is still refused; no automatic certificate; the installer prints only the bare domain's record."}
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
    ONE4 = dict(label="share", title="Send your friend the link", show=["friend", "e_share", "e_sharevm"],
                caption="You send your friend the link, for example in a chat message.",
                play=[{"get": "domain"}, {"run": ["e_share", "e_sharevm"]}, {"who": "jazz", "appear": "friend"}, {"give": "domain", "to": "jazz"}, {"run": ["e_share", "e_sharevm"], "back": True}, {"wait": 0.4}])   # FR148: the hand-over and the way home
    ONE5 = dict(label="friend", title="A friend opens the link", show=["e_friend", lk, "e_v4"], caption=FRIEND_CAP1[nm], play=friend(nm))
    # FR149 / FR150: two friends, one on IPv6 and one on IPv4 only — in the box views, where the IPv4 way is drawn; the VM views keep the one friend
    v = "d" if duck else "b"
    S(nm, "", 4, label="share", title="Send two friends the link", show=["friend", "friend4", "e_share", "e_sharevm", "e_share2"],
      caption="You send the link to two friends, for example in a chat message. One friend's network has IPv6, the other's has IPv4 only.",
      play=SHARE2)
    steps[-1]["showWhen"]["method"] = BOXV
    steps.append({"id": f"v6{v}4vm", "showWhen": {**W(nm, "first"), "method": ["vm"]}, **ONE4})
    S(nm, "", 5, label="friends", title="Two friends open the link", show=["e_friend", "e_friend4", lk, "e_v4"], texts={"answer4": ANSWER4[nm]},
      caption=FRIEND_CAP[nm], play=friends2(nm))
    steps[-1]["showWhen"]["method"] = BOXV
    steps.append({"id": f"v6{v}5vm", "showWhen": {**W(nm, "first"), "method": ["vm"]}, **ONE5})
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
