"""FR122 — phonebooks for every name route, lookups through the internet, credentials into the install.
Run from dev-dashboard: python3 <this> docs/diagrams/setup-map.json"""
import json, sys

p = sys.argv[1]
d = json.load(open(p))
N = {n["id"]: n for n in d["nodes"]}
E = {e["id"]: e for e in d["edges"]}
ROUTE = ("bp", "so", "eo", "mo", "ss", "es", "sf", "ef", "ah")   # dragged routing — reset on a retargeted line


def node(nid, **kv):
    if nid in N:
        N[nid].clear()
    else:
        N[nid] = {}
        d["nodes"].append(N[nid])
    N[nid].update(id=nid, **kv)


def edge(eid, **kv):
    if eid in E:
        E[eid].clear()
    else:
        E[eid] = {}
        d["edges"].append(E[eid])
    E[eid].update(id=eid, **kv)


def drop(*ids):
    d["nodes"][:] = [n for n in d["nodes"] if n["id"] not in ids]
    d["edges"][:] = [e for e in d["edges"] if e["id"] not in ids]


def chain(via):   # a lookup: friend → internet → book, the answer back the same way
    return {"ask": ["e_friend", via], "answer": [via, "e_friend"]}


V6 = "→ your ip, like: 2001:db8::1"
RELAY = "→ {}'s relay, like: 98.76.54.32"
BOOK = dict(nodeType="phonebook", x=737, y=-172, w=262, h=140)
LOOKUP = dict(kind="plain", role="info", dir="both", to="inet", label="your friend looks up the ip")

# bought domain / DuckDNS (ipv6 + portfwd): the lookup goes through the internet; IPv6 views show an IPv6 address
pb = N["pbook"]
pb["lights"] = chain("e_pb_friend")
pb["entryWhen"] = {"reach": {"ipv6": "https://yourdomain.org\n" + V6}}
edge("e_pb_friend", **LOOKUP, cost="paid", **{"from": "pbook"}, lw=5)
du = N["duck"]
du["lights"] = dict(chain("e_duck"), update="e_duck_srv")
du["entryWhen"] = {"reach": {"ipv6": "https://yourname.duckdns.org\n" + V6}}
edge("e_duck", **LOOKUP, cost="central", **{"from": "duck"})

# Tailscale: its own phonebook (Tailscale writes your name → its relay); you fetch an auth key, it goes into the install
drop("tsname")
node("tsbook", **BOOK, color="orange", badge="bolt", label="Tailscale (free)",
     entry="https://selfprivacy.tail1234.ts.net\n" + RELAY.format("Tailscale"),
     lights=dict(chain("e_ts_friend"), update="e3"), showWhen={"reach": ["tailscale"]})
node("tskey", nodeType="info", color="orange", icon="key", x=395, y=-230, w=220, h=80,
     label="Auth key: tskey-auth-…\n(single use, from your account)", showWhen={"reach": ["tailscale"]})
edge("e_ts_you", kind="plain", role="action", cost="central", dir="to", **{"from": "you"}, to="tskey", lw=5,
     label="make an account, copy a key")
edge("e_ts_srv", kind="plain", role="info", cost="central", dir="to", **{"from": "tskey"}, to="server", lw=5,
     label="pasted into the install")
edge("e3", kind="plain", role="info", cost="central", dir="to", **{"from": "relayTS"}, to="tsbook",
     label="Tailscale writes your name")
edge("e_ts_friend", **LOOKUP, cost="central", **{"from": "tsbook"})
N["tswarn"].update(x=1295, y=-150)

# Cloudflare + your domain: the domain moves into Cloudflare's phonebook once (by hand); a tunnel token goes into the install
node("cfbook", **BOOK, color="orange", badge="bolt", label="Cloudflare",
     entry="https://yourdomain.org\n" + RELAY.format("Cloudflare"),
     lights=dict(chain("e_cf_net"), update="e1"), showWhen={"name": ["buy"], "reach": ["cloudflare"]})
node("cftoken", nodeType="info", color="orange", icon="key", x=395, y=-230, w=220, h=80,
     label="Tunnel token\n(from your Cloudflare account)", showWhen={"name": ["buy"], "reach": ["cloudflare"]})
N["buy"].update(x=700, y=-360, w=240, h=100, label="Buy a domain\n(registrar, €/yr)\nthen once, by hand: point it\nto Cloudflare's phonebook")
edge("e1", kind="plain", role="info", cost="central", dir="to", **{"from": "relayCF"}, to="cfbook",
     label="Cloudflare writes your name")
edge("e_cf_move", kind="plain", role="action", cost="central", dir="to", **{"from": "buy"}, to="cfbook", lw=5)
edge("e_cf_you", kind="plain", role="action", cost="central", dir="to", **{"from": "you"}, to="cftoken", lw=5,
     label="account + tunnel → copy its token")
edge("e_cf_tok", kind="plain", role="info", cost="central", dir="to", **{"from": "cftoken"}, to="server", lw=5,
     label="pasted into the install")
edge("e_cf_net", **LOOKUP, cost="central", **{"from": "cfbook"})
for k in ROUTE:   # you → buy and buy → server keep their meaning, new places
    E["e8"].pop(k, None)
    E["e7"].pop(k, None)
drop("e4")
BOXES = {"method": ["cable", "wifi", "usb"]}   # in the VM views the server sits inside your computer: its own copy of e7
E["e7"]["showWhen"] = BOXES
edge("e7vm", **{k: v for k, v in E["e7"].items() if k not in ("id", "showWhen")}, showWhen={"method": ["vm"]})

# Cloudflare quick tunnel: no account — Cloudflare's phonebook gets a random name for its relay
drop("cffree", "e_try_you", "e_try_srv")
node("trybook", **BOOK, color="orange", badge="bolt", label="Cloudflare (free)",
     entry="https://pink-owl-sky.trycloudflare.com\n" + RELAY.format("Cloudflare"),
     lights=dict(chain("e_try_friend"), update="e2"), showWhen={"name": ["trycf"], "reach": ["cloudflare"]})
edge("e2", kind="plain", role="info", cost="central", dir="to", **{"from": "relayCF"}, to="trybook",
     label="Cloudflare writes a random name")
edge("e_try_friend", **LOOKUP, cost="central", **{"from": "trybook"})
N["trywarn"].update(x=1295, y=-150)

# routing (FR79 offsets; _H = forced main axis, FR93): lookups leave the book's right side and drop into the cloud's top;
# "you" lines rise from the laptop, then turn into the box's side; the company writes into the book's bottom, right of its label
for eid, r in {"e_pb_friend": dict(_H=True, mo=148), "e_duck": dict(_H=True, mo=148), "e_ts_friend": dict(_H=True, mo=148),
               "e_cf_net": dict(_H=True, mo=148), "e_try_friend": dict(_H=True, mo=148),
               "e_ts_you": dict(mo=-168), "e_cf_you": dict(mo=-129), "e8": dict(mo=-362, eo=-20),
               "e7": dict(_H=True, so=20, mo=27), "e7vm": dict(_H=True, so=20, mo=209.2, eo=-26.5),
               "e_ts_srv": dict(_H=False, mo=113.7), "e_cf_tok": dict(_H=False, mo=91.7), "e_cf_move": dict(so=48),
               "e3": dict(so=9.1, eo=58), "e1": dict(so=40.3, eo=58), "e2": dict(so=40.3, eo=58)}.items():
    E[eid].update(r)

json.dump(d, open(p, "w"), indent=2, ensure_ascii=False, sort_keys=True)
open(p, "a").write("\n")
print("nodes", len(d["nodes"]), "edges", len(d["edges"]))
