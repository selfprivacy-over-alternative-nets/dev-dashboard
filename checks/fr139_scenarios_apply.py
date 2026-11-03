"""FR139 / FR140 — the Tailscale story's two more scenarios: install again (the old machine is still at Tailscale) and restore
from a backup. Run from dev-dashboard AFTER fr124_steps_apply.py (which writes the first-install steps):
    python3 checks/fr139_scenarios_apply.py docs/diagrams/setup-map.json
Re-runnable: it replaces what it wrote before."""
import copy, json, sys

p = sys.argv[1]
d = json.load(open(p))
SC = ["first", "reinstall", "restore"]
# the Scenario toggle — Tailscale views only; all three share one layout, so a box hidden in a view stays hidden in all three
tg = {"id": "scenario", "label": "Scenario", "default": "first",
      "options": [{"label": "First install", "value": "first"}, {"label": "Reinstall", "value": "reinstall"}, {"label": "Restore a backup", "value": "restore"}],
      "optionsWhen": {"reach": {"tailscale": SC}}, "sameLayout": [SC]}
d["meta"]["toggles"] = [t for t in d["meta"]["toggles"] if t["id"] != "scenario"] + [tg]
# a Tailscale view's key now ends in ;scenario=first (FR113 hideIn)
for o in d["nodes"] + d["edges"]:
    if o.get("hideIn"):
        o["hideIn"] = [k + ";scenario=first" if "reach=tailscale" in k and "scenario=" not in k else k for k in o["hideIn"]]
when = lambda s: {"reach": ["tailscale"], "scenario": [s]}
# FR140: your SelfPrivacy backup device — a laptop above the internet (left of your friend's lookup line), on its own pipe
d["nodes"] = [n for n in d["nodes"] if n["id"] != "backupdev"] + [
    {"id": "backupdev", "label": "SelfPrivacy\nbackup device", "nodeType": "device", "icon": "laptop", "color": "green",
     "x": 1000, "y": -10, "w": 137, "h": 167, "showWhen": when("restore")}]
d["edges"] = [e for e in d["edges"] if e["id"] != "e_backup"] + [
    {"id": "e_backup", "from": "backupdev", "to": "inet", "kind": "pipe", "role": "tunnel", "color": "#8b949e", "label": "", "_H": True,   # out of its right side, into
     "showWhen": when("restore")}]   # the internet's left (clear of the label and of your friend's lookup line, which comes down into its top)
# the first install is one scenario of three
FIRST = ["ts0", "ts1", "ts2", "tskeep", "tsshare", "ts3"]
S = {s["id"]: s for s in d["steps"]}
for i in FIRST:
    S[i]["showWhen"] = when("first")
d["steps"] = [s for s in d["steps"] if not s["id"].startswith(("tsr", "tsb"))]
# FR139: install again — a new one-time key; at the closet the old machine's name and address go into the fire first, then
# the server registers as in the first install (the same name again); the helper writes the phonebook again
r1 = copy.deepcopy(S["ts1"]["play"])
k = next(i for i, a in enumerate(r1) if isinstance(a.get("scene"), dict))
r1[k] = {"scene": {**r1[k]["scene"], "S.top": "olddomain", "S.bottom": "oldip"}}
r1[k + 1:k + 1] = [{"walk": "S"}, {"fire": True}, {"take": "olddomain", "from": "S.top"}, {"throw": "olddomain", "in": "F"},
                   {"take": "oldip", "from": "S.bottom"}, {"throw": "oldip", "in": "F"}]
d["steps"] += [
    {"id": "tsr0", "showWhen": when("reinstall"), "label": "new key", "title": "Get a new auth key", "show": copy.deepcopy(S["ts0"]["show"]),
     "caption": "You install again. The one-time auth key was used up by the first install, so you get a new one from Tailscale.",
     "play": [{"run": "e4"}, {"get": "key"}, {"pop": "new key ✓"}, {"run": "e4", "back": True}, {"wait": 0.8}]},
    {"id": "tsr1", "showWhen": when("reinstall"), "label": "install again", "title": "Clean out the old machine, then register again",
     "show": copy.deepcopy(S["ts1"]["show"]),
     "caption": "Tailscale still has your old machine: its name and its IP address are still in the closet. They go out first "
                "(remove the old machine in Tailscale's admin console), else the new server would get the name selfprivacy-1. "
                "Then it registers as before and gets the same name back.",
     "play": r1},
    {"id": "tsr2", "showWhen": when("reinstall"), "label": "phonebook", "title": "Tailscale writes the name again", "show": copy.deepcopy(S["ts2"]["show"]),
     "caption": "Tailscale's helper writes your name in its phonebook again. It points to Tailscale's relay, which now passes "
                "visitors on to your new server.",
     "play": copy.deepcopy(S["ts2"]["play"])},
    # FR140: restore from a backup — the backup and a KeePass vault with the server's own key go through Tailscale over the
    # internet to the backup device's screen; the server burns down; the install light, the backup and the vault come back
    # from the backup device, the server is built up again and gets its data and its own key back: the same machine
    {"id": "tsb0", "showWhen": when("restore"), "label": "backup", "title": "Back up to your backup device",
     "show": ["you", "server", "router", "e_cable", "e_usb", "e_wifi", "e_scable", "e_ts_up", "relayTS", "e_ts_run", "inet", "backupdev", "e_backup"],
     "caption": "Your SelfPrivacy server makes a backup, and you lock a copy of its own key in a KeePass vault (planned: round0 R2). "
                "Both go through Tailscale over the internet to your SelfPrivacy backup device, which keeps them on its screen.",
     "play": [{"run": ["e_cable", "e_usb"]}, {"appear": "server"}, {"get": "backup", "from": "server"},
              {"get": "vault"}, {"open": "vault"}, {"copy": "idkey", "from": "server", "in": "vault"}, {"close": "vault"},
              {"run": "e_ts_up"}, {"run": "e_ts_run"}, {"run": "e_backup", "back": True},
              {"put": "backup", "in": "backupdev", "screen": "left"}, {"put": "vault", "in": "backupdev", "screen": "right"}, {"wait": 0.8}]},
    {"id": "tsb1", "showWhen": when("restore"), "label": "fire", "title": "Your server is lost", "show": [],
     "caption": "Then disaster: your server burns down (or it is stolen, or it breaks). What it held is now only on your backup device.",
     "play": [{"burn": "server"}, {"wait": 0.6}]},
    {"id": "tsb2", "showWhen": when("restore"), "label": "restore", "title": "Restore from the backup", "show": [],
     "caption": "You install again, from the backup device: the install light, the backup and the KeePass vault go back to where "
                "the server stood. The server is built up again and gets its data back from the backup and its own key from KeePass, "
                "so Tailscale knows it as the same machine: the same name and address, nothing to clean out.",
     "play": [{"get": "light", "from": "backupdev"}, {"get": "backup", "from": "backupdev"}, {"get": "vault", "from": "backupdev"},
              {"run": "e_backup"}, {"run": "e_ts_run", "back": True}, {"run": "e_ts_up", "back": True},
              {"hammer": 3, "at": "server"}, {"put": "backup", "in": "server"},
              {"open": "vault"}, {"take": "idkey", "from": "vault"}, {"put": "idkey", "in": "server"}, {"close": "vault"}, {"wait": 1}]},
]
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False, sort_keys=True)
open(p, "a").write("\n")
print("scenarios written:", [s["id"] for s in d["steps"]])
