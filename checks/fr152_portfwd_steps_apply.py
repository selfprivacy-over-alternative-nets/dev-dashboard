"""FR152 — the port-forward stories, DuckDNS and a bought domain, told like the Direct IPv6 ones (FR141 / FR144), each step carrying the
dash command that does it: the matrix twin's command (index.html#method=…;net=…;reach=portfwd;name=…), built from catalog.json the way
app.js cellCmd builds the cells', with the view's values filled in (TRANSPORT=https, the name) and never an address (a placeholder instead).
A step with one command per Install × Network view stores them as cmdWhen = {method: {…: {net: {…: cmd}}}} (resolved like labelWhen).
Run from dev-dashboard AFTER fr124, fr139, fr141 and fr145:
    python3 checks/fr152_portfwd_steps_apply.py docs/diagrams/setup-map.json
    python3 checks/fr152_portfwd_steps_apply.py --check docs/diagrams/setup-map.json   # writes nothing; exit 1 when the file's commands or steps drifted from the catalog
Re-runnable: it replaces what it wrote before (the steps whose id starts with "pf")."""
import json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); from keep_layout import put   # an editor change to an item survives a re-run
ROOT = os.path.dirname(HERE)
FLOWS = ["connect", "login", "services", "providers", "nextcloud", "users", "menus"]   # the L3 proof in one line; L3.addremove.desktop on its own (it adds and removes a user)
VM_REACH = "# not wired for the VM: tools/add-cloudflare.sh drives an installed BOX over SSH"   # the matrix's words (app.js niCell) for a make-reachable cell on the VM
NAME = {"duckdns": "<NAME>.duckdns.org", "buy": "<YOUR_DOMAIN>"}
HOST = {"duckdns": "yourname.duckdns.org", "buy": "yourdomain.org"}
LAN = "192.0.2.10"   # the server's address on your home network — a documentation address (RFC 5737), never a real one


def view_cmd(cmd, nm):   # a catalog command as this view shows it: the transport is https, the domain is the view's name, and never an address — a placeholder
    cmd = cmd.replace("<none|https|onion>", "https").replace("<https|onion>", "https").replace("<YOUR_DOMAIN>", NAME[nm])
    return re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "<TARGET_IP_ON_CABLE>", cmd)   # (install.cable's --ip is the target's address on the direct cable)


def matrix_cmds(cat, s, nm):   # this view's cells, as app.js cellCmd0 prints them: the setup's install, the make-reachable and the L3 cells
    setup, kind = s["id"], "vm" if s["method"] == "vm" else "box"
    ins = next(e for e in cat["installs"] if e["id"] == next(m["install"] for m in cat["setup_map"]["methods"] if m["id"] == s["method"]))
    install = ins["cmd_template"].replace("{setup}", setup).replace("{wifi}", (ins.get("wifi_args") or "") if s.get("target_wifi") else "")
    rch = next(e for e in cat["reaches"] if e["id"] == f"reach.portfwd-{nm}")
    reach = VM_REACH if kind == "vm" else view_cmd(rch["cmd_template"].replace("{setup}", setup), nm)
    row = next(r for r in cat["reach_rows"] if r["id"] == f"portfwd-{nm}")
    tail = f" --on {setup} --reach portfwd --name {nm} --net {row['net']}" + ((cat["setup_map"].get("box_args") or " --ip <BOX_LAN_IP> --key <SSH_KEY> --token <API_TOKEN>") if kind == "box" else "")
    if kind in (row.get("l3_wired") or []):
        l3 = ["./dash run " + " ".join(f"L3.{f}.desktop" for f in FLOWS) + tail, "./dash run L3.addremove.desktop" + tail]
    else:
        l3 = [f"# not wired: L3 over {row['label']} on the VM has no automated test yet (the VM is not reachable over a public route)"]
    return view_cmd(install, nm), reach, [view_cmd(x, nm) for x in l3]


def when_by_setup(cat, f):   # {"method": {m: {"net": {n: f(setup)}}}} — one value per Install × Network view, resolved like labelWhen (a VM has no net)
    w = {}
    for s in cat["setups"]:
        v = f(s)
        if s.get("net"):
            w.setdefault(s["method"], {"net": {}})["net"][s["net"]] = v
        else:
            w[s["method"]] = v
    return {"method": w}


def build(d, cat):
    E = {e["id"]: e for e in d["edges"]}
    for eid in ("e_share", "e_sharevm"):   # the line your friend gets the link over is drawn in the port-forward views too
        E[eid]["showWhen"]["reach"] = sorted(set(E[eid]["showWhen"].get("reach") or []) | {"portfwd"}, key=["tailscale", "ipv6", "portfwd"].index)
    INSTALL = ["server", "router", "e_cable", "e_usb", "e_wifi", "e_scable"]
    GATES = ["inet", "e_pf_b", "pfwarn", "e5", "e6"]   # the internet, the yellow IPv4 pipe through both gates, the port-forward note and your way along it to the port
    HOME = [{"run": ["e_cable", "e_usb"], "back": True}]
    IP = f"Your server's LAN address:\n{LAN}"
    # the install: the light and the name go down the cable; the server is built up, the name goes in and its LAN address comes out — Mario keeps the address
    INSTALL_PLAY = [{"get": "light"}, {"run": ["e_cable", "e_usb"]}, {"hammer": 3, "at": "server"}, {"put": "domain", "in": "server"}, {"get": "ip", "from": "server"},
                    {"pop": "LAN address found ✓"}, {"wait": 0.6}]
    # both gates, by hand: from your computer along the note's line to the router's port; the fire wall slides down, the barrier lifts, the LAN address goes into the router
    OPEN2 = HOME + [{"get": "ip"}, {"run": "e5"}, {"run": "e6"}, {"open": "firewall", "of": "router"}, {"open": "port", "of": "router"}, {"put": "ip", "in": "router"},
                    {"pop": f"TCP 443 → {LAN} ✓"}, {"run": "e6", "back": True}, {"run": "e5", "back": True}, {"wait": 0.4}]
    SHARE = [{"get": "domain"}, {"run": ["e_share", "e_sharevm"]}, {"who": "jazz", "appear": "friend"}, {"give": "domain", "to": "jazz"}, {"run": ["e_share", "e_sharevm"], "back": True}, {"wait": 0.4}]   # FR148: the hand-over and the way home
    def friend(bk, lk):   # FR148: Jazz (who got the address from Mario) looks it up, gets your router's public IPv4 and goes in over IPv4: through both open gates to the server, and back with the call
        return [{"who": "jazz", "run": "e_friend"}, {"who": "jazz", "run": lk, "back": True}, {"who": "jazz", "lookup": bk}, {"who": "jazz", "run": lk},
                {"who": "jazz", "run": "e_pf_b", "back": True}, {"who": "jazz", "put": "answer", "in": "server"}, {"who": "jazz", "show": "jitsi", "at": "server"},
                {"who": "jazz", "get": "jitsi", "from": "server"}, {"who": "jazz", "run": "e_pf_b"}, {"who": "jazz", "run": "e_friend", "back": True},
                {"who": "jazz", "show": "jitsi", "at": "friend"}, {"wait": 1}]
    GATE_CAP = ("Your router has two gates shut: the fire wall and port 443. You open both by hand in the router's settings, as the make-reachable command "
                "printed: forward TCP 443 to the server's LAN address (and TCP 80 too if the certificate comes from Let's Encrypt over HTTP-01). That works "
                "only when your router has a public IPv4 address of its own: behind CGNAT (an address shared with other customers) there is no way in.")
    steps = []
    def S(nm, i, **k):
        steps.append({"id": f"pf{'d' if nm == 'duckdns' else 'b'}{i}", "showWhen": {"reach": ["portfwd"], "name": [nm]}, **k})
    for nm in ("duckdns", "buy"):
        duck, host = nm == "duckdns", HOST[nm]
        bk, lk = ("duck", "e_duck") if duck else ("pbook", "e_pb_friend")
        cmd_install = when_by_setup(cat, lambda s: matrix_cmds(cat, s, nm)[0])
        cmd_reach = when_by_setup(cat, lambda s: matrix_cmds(cat, s, nm)[1])
        cmd_l3 = when_by_setup(cat, lambda s: matrix_cmds(cat, s, nm)[2])
        if duck:
            S(nm, 0, label="account", title="Claim a DuckDNS name, keep the token", show=["you", "duck", "e9"], texts={"domain": host, "ip": IP},
              caption="First you sign in at duckdns.org (with a GitHub, Google, … account) and claim a free name: yourname.duckdns.org. You also copy "
                      "your account's token: the server will need it to keep your entry up to date. It is not used up, so you keep it in KeePass on your computer.",
              play=[{"run": "e9"}, {"pop": "name claimed ✓"}, {"get": "domain"}, {"get": "vault"}, {"open": "vault"}, {"copy": "token", "from": "duck", "in": "vault"},
                    {"close": "vault"}, {"run": "e9", "back": True}, {"put": "vault", "in": "you", "screen": True}, {"wait": 0.6}])
            S(nm, 1, label="install", title="Install, with the name baked in", show=INSTALL, cmdWhen=cmd_install,
              caption="The installer bakes the name into the install and builds SelfPrivacy on your server, with https as the transport. At the end it prints "
                      "the server's address on your home network (its LAN address): the router will need it.",
              play=INSTALL_PLAY)
            S(nm, 2, label="phonebook", title="The server keeps its own entry up to date", show=["e_duck_srv"], cmdWhen=cmd_reach,
              caption="The make-reachable command checks the install and prints what to set up: the port-forward, and a timer on the server that sends your "
                      "public IPv4 address to DuckDNS every 5 minutes with your token (gap today: you add that timer yourself). DuckDNS writes the address in "
                      "its phonebook under your name. It is your router's address, which anyone can look up.",
              play=HOME + [{"get": "token", "from": "you"}, {"run": ["e_cable", "e_usb"]}, {"put": "token", "in": "server"}, {"update": "duck"}, {"pop": "again every 5 minutes"}, {"wait": 0.4}])
        else:
            S(nm, 0, label="domain", title="Buy a domain", show=["you", "pbook", "e_pb_you"], texts={"domain": host, "ip": IP},
              caption="First you buy a domain at a registrar (a shop for domain names, €/yr). The registrar's phonebook will hold your records, and "
                      "you edit them by hand on its website.",
              play=[{"run": "e_pb_you"}, {"pop": "bought ✓ (€/yr)"}, {"get": "domain"}, {"run": "e_pb_you", "back": True}, {"wait": 0.6}])
            S(nm, 1, label="install", title="Install, with the domain baked in", show=INSTALL, cmdWhen=cmd_install,
              caption="The installer bakes the domain into the install and builds SelfPrivacy on your server, with https as the transport. At the end it "
                      "prints the server's address on your home network (its LAN address): the router will need it. On this route nothing on the server "
                      "updates the phonebook.",
              play=INSTALL_PLAY)
            S(nm, 2, label="phonebook", title="Write your public address in the phonebook, by hand", show=[], cmdWhen=cmd_reach,
              caption="The make-reachable command checks the install and prints what to set up: the port-forward, and five A records pointing at your "
                      "router's public IPv4 address: api, cloud, git, matrix and meet of yourdomain.org. You write them in the registrar's phonebook "
                      "yourself. They point at your router, not at your server.",
              play=HOME + [{"run": "e_pb_you"}, {"write": "pbook"}, {"pop": "×5 A records → your public IPv4"}, {"run": "e_pb_you", "back": True}, {"wait": 0.4}])
        S(nm, 3, label="router", title="Open the fire wall and port 443 by hand", show=GATES, caption=GATE_CAP, play=OPEN2)
        S(nm, 4, label="share", title="Send your friend the link", show=["friend", "e_share", "e_sharevm"],
          caption="You send your friend the link, for example in a chat message.", play=SHARE)
        S(nm, 5, label="friend", title="A friend opens the link", show=["e_friend", lk], cmdWhen=cmd_l3,
          caption="Your friend opens the link to call you on Jitsi Meet. The phone asks " + ("DuckDNS" if duck else "the registrar's phonebook")
                  + " and gets your router's public IPv4 address" + ("" if duck else " (the A record you wrote)") + ", so the call arrives at your router, "
                  "which passes TCP 443 on to your server through both open gates: no company in between, and IPv4-only friends get in too. Gaps today: "
                  + ("the DuckDNS timer is yours to add; " if duck else "a new public address (home connections get one now and then) means editing the five records again by hand; ")
                  + "a certificate needs TCP 80 forwarded too (Let's Encrypt HTTP-01); nothing works behind CGNAT.",
          play=friend(bk, lk))
    d["steps"] = [s for s in d["steps"] if not s["id"].startswith("pf")] + steps
    return [s["id"] for s in steps]


def dumps(d):
    return json.dumps(d, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


if __name__ == "__main__":
    check = "--check" in sys.argv
    p = [a for a in sys.argv[1:] if a != "--check"][0]
    cat = json.load(open(os.path.join(ROOT, "catalog.json")))
    before = open(p).read()
    d = json.loads(before)
    ids = build(d, cat)
    after = dumps(d)
    if check:   # the file holds exactly what this script writes from catalog.json — else a command (or a step) drifted
        if after == before:
            print(f"step commands aligned — the {len(ids)} port-forward steps in {os.path.relpath(p)} are what catalog.json gives.")
            sys.exit(0)
        old = {s["id"]: s for s in json.loads(before)["steps"]}
        new = {s["id"]: s for s in d["steps"]}
        for sid in ids:
            if old.get(sid) != new[sid]:
                diff = [k for k in set(old.get(sid) or {}) | set(new[sid]) if (old.get(sid) or {}).get(k) != new[sid].get(k)]
                print(f"  - step {sid}: {', '.join(sorted(diff))} differ" + ("" if sid in old else " (missing)"))
        print(f"step commands ≠ catalog — re-run: python3 checks/fr152_portfwd_steps_apply.py {os.path.relpath(p)}")
        sys.exit(1)
    open(p, "w").write(after)
    print("port-forward steps written:", ids)
