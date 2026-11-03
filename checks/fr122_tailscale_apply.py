"""FR122 (Tailscale detail) — the key is a one-time ticket sent at the end; a note on keeping the same address.
Run from dev-dashboard: python3 checks/fr122_tailscale_apply.py docs/diagrams/setup-map.json"""
import json, sys

p = sys.argv[1]
d = json.load(open(p))
N = {n["id"]: n for n in d["nodes"]}
E = {e["id"]: e for e in d["edges"]}

N["tskey"].update(y=-238, h=88, label="Auth key: tskey-auth-…\none-time entry ticket, used\nup when the server joins")
E["e_ts_srv"]["label"] = "pasted at the end, sent to your server"
N["tswarn"].update(h=230, label="\n".join([
    "Free Tailscale Funnel = at a company",
    "• needs a Tailscale account (Google/GitHub/… login)",
    "• address: selfprivacy.<tailnet>.ts.net",
    "  (no own domain)",
    "• switch Funnel on once, in your browser",
    "• ONE name only → the app's API, not the",
    "  cloud. / git. / matrix. / meet. services",
    "• bandwidth limits (not published) · still beta",
    "• a new name can take ~10 min to work",
    "• the relay passes your traffic on but can't",
    "  read it (the encryption ends on your server)"]))
life = dict(id="tslife", nodeType="info", color="red", icon="warn", x=50, y=215, w=280, h=275,
            showWhen={"reach": ["tailscale"]}, label="\n".join([
    "Keeping the same address",
    "• the key is used once; after that the",
    "  server proves who it is with its own",
    "  ID file on its disk (tailscaled.state)",
    "• reboot / new home ip: same machine,",
    "  same address — but today the tunnel",
    "  only comes back when you re-run the",
    "  finish step",
    "• reinstall wipes the ID file → a new",
    "  machine selfprivacy-1, old links stop",
    "  working: delete the old machine first",
    "  (fix planned: keep the ID file)",
    "• its login runs out after 180 days:",
    "  switch off key expiry on Tailscale's",
    "  Machines page"]))
if "tslife" in N:
    N["tslife"].clear()
    N["tslife"].update(life)
else:
    d["nodes"].append(life)

json.dump(d, open(p, "w"), indent=2, ensure_ascii=False, sort_keys=True)
open(p, "a").write("\n")
print("ok")
