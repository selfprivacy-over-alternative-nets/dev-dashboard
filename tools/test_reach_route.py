#!/usr/bin/env python3
"""Tests dash's box-route check (req 181) without a box: live DoH + TLS against public hosts, every decision
branch of verify_reach_route with canned box answers, and _dispatch_l3's refuse / --allow-dirty wiring.
Needs internet (cloudflare-dns.com, one.one.one.one, badssl.com); writes nothing.
  python3 tools/test_reach_route.py ./dash"""
import importlib.util, importlib.machinery, sys, io, contextlib, types, subprocess as real_sp
sys.dont_write_bytecode = True   # no __pycache__ next to dash
loader = importlib.machinery.SourceFileLoader("dash", sys.argv[1])
spec = importlib.util.spec_from_loader("dash", loader); d = importlib.util.module_from_spec(spec); loader.exec_module(d)
ok = True
def check(name, cond, extra=""):
    global ok; ok &= bool(cond); print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra else ""))
rows = {r["id"]: r for r in d.load_catalog()["reach_rows"]}

print("== 1. live: DNS-over-HTTPS (cloudflare-dns.com, never /etc/hosts)")
a, aaaa = d._doh("one.one.one.one", "A"), d._doh("one.one.one.one", "AAAA")
check("A one.one.one.one has 1.1.1.1", "1.1.1.1" in a, a)
check("AAAA one.one.one.one has 2606:4700:4700::1111", "2606:4700:4700::1111" in aaaa, aaaa)
check("nonexistent name -> []", d._doh("no-such-host-7f3a9.invalid", "A") == [])
check("/etc/hosts name (theory7) is NOT resolved via hosts", "127.0.0.1" not in d._doh("theory7", "A"))
print("== 1b. live: TLS precheck codes (dash refuses on curl 35/51/58/60/77)")
TLS_BAD = (35, 51, 58, 60, 77)
for host, want_bad in [("one.one.one.one", False), ("expired.badssl.com", True), ("self-signed.badssl.com", True),
                       ("wrong.host.badssl.com", True), ("untrusted-root.badssl.com", True)]:
    r = d._sh(f"curl -sS -o /dev/null --max-time 20 https://{host}/", timeout=30)
    check(f"TLS {host}: {'refused' if want_bad else 'accepted'}", (r.returncode in TLS_BAD) == want_bad, f"curl exit {r.returncode}")

print("== 2. every decision branch, canned box answers")
def run_case(row_id, domain, A, AAAA, box_answers):
    d._doh = lambda name, rtype: {"A": A, "AAAA": AAAA}[rtype]
    def fake_run(cmd, **k):
        c = cmd[-1]
        out = next((v for key, v in box_answers.items() if key in c), "")
        return types.SimpleNamespace(stdout=out, stderr="", returncode=0 if out else 255)
    d.subprocess = types.SimpleNamespace(run=fake_run)
    try:
        return d.verify_reach_route({"https_domain": f"api.{domain}", "ip": "192.0.2.10", "key": "/dev/null"}, rows[row_id])
    finally:
        d.subprocess = real_sp
PUB4 = "81.204.10.7"; V6 = "2a02:a46a:1::42"
up4 = {"api.ipify.org": PUB4}; up6 = {"ip -6 addr": f"fe80::1\nfd00::5\n{V6}"}
cases = [
  ("duckdns name on a bought domain", "ipv6-duckdns", "example.nl", [], [V6], up6, False),
  ("buy name on a duckdns domain", "portfwd-buy", "me.duckdns.org", [PUB4], [], up4, False),
  ("portfwd: A = box public IPv4", "portfwd-buy", "example.nl", [PUB4], [], up4, True),
  ("portfwd duckdns: A = box public IPv4", "portfwd-duckdns", "me.duckdns.org", [PUB4], [], up4, True),
  ("portfwd: A is a private LAN address", "portfwd-buy", "example.nl", ["192.168.1.167"], [], up4, False),
  ("portfwd: A public + private mixed", "portfwd-buy", "example.nl", [PUB4, "10.0.0.5"], [], up4, False),
  ("portfwd: A is someone else", "portfwd-buy", "example.nl", ["94.212.5.9"], [], up4, False),
  ("portfwd: no A record", "portfwd-buy", "example.nl", [], [], up4, False),
  ("portfwd: box unreachable (no public IPv4)", "portfwd-buy", "example.nl", [PUB4], [], {}, False),
  ("ipv6: AAAA = box global IPv6", "ipv6-buy", "example.nl", [], [V6], up6, True),
  ("ipv6 duckdns: AAAA = box global IPv6", "ipv6-duckdns", "me.duckdns.org", [PUB4], [V6], up6, True),
  ("ipv6: AAAA is another host", "ipv6-buy", "example.nl", [], ["2a02:a46a:2::99"], up6, False),
  ("ipv6: AAAA only matches a ULA/link-local", "ipv6-buy", "example.nl", [], ["fd00::5"], up6, False),
  ("ipv6: no AAAA", "ipv6-buy", "example.nl", [PUB4], [], up6, False),
  ("ipv6: box unreachable", "ipv6-buy", "example.nl", [], [V6], {}, False),
  ("cloudflare: cloudflared active + Cloudflare A", "cloudflare-buy", "example.nl", ["104.21.1.1"], [], {"is-active": "active", **up4}, True),
  ("cloudflare: cloudflared inactive", "cloudflare-buy", "example.nl", ["104.21.1.1"], [], {"is-active": "inactive", **up4}, False),
  ("cloudflare: active but no public A", "cloudflare-buy", "example.nl", [], [], {"is-active": "active", **up4}, False),
  ("cloudflare: box unreachable", "cloudflare-buy", "example.nl", ["104.21.1.1"], [], {}, False),
  ("cloudflare: A points straight at the box (a port-forward)", "cloudflare-buy", "example.nl", [PUB4], [], {"is-active": "active", **up4}, False),
  ("portfwd: A is a carrier-grade-NAT address", "portfwd-buy", "example.nl", ["100.72.3.4"], [], up4, False),
  ("cloudflare: A is a carrier-grade-NAT address", "cloudflare-buy", "example.nl", ["100.72.3.4"], [], {"is-active": "active", **up4}, False),
  ("cloudflare: A is a private LAN address", "cloudflare-buy", "example.nl", ["192.168.1.167"], [], {"is-active": "active", **up4}, False),
]
for name, rid, dom, A, AAAA, box, want in cases:
    got, ev, why = run_case(rid, dom, A, AAAA, box)
    check(f"{rid:<16} {name} -> {'verified' if want else 'refused'}", got == want, why or "ok")

print("== 3. wiring in _dispatch_l3: refuse, --allow-dirty = forced, TLS failure refuses")
calls = []
d.resolve_backend_target = lambda *a, **k: {"kind": "box", "https_domain": "api.example.nl", "ip": "192.0.2.10", "key": "/dev/null",
                                           "token": "t", "onion": None, "socks": None}
d._port_open = lambda *a, **k: False
d._backend_install_id = lambda t: "mid"
d.mark_record = lambda *a, **k: None
d.run_l3_flutter = lambda *a, **k: (calls.append(k), {"run_id": "x", "status": "pass"})[1]
entry = {"id": "L3.connect.desktop", "client": "desktop"}
def dispatch(route_ok, tls_rc, allow):
    calls.clear()
    d.verify_reach_route = lambda t, r: (route_ok, {"host": "api.example.nl"}, "" if route_ok else "port-forward: mismatch")
    d._sh = lambda cmd, timeout=None: types.SimpleNamespace(returncode=tls_rc, stdout="", stderr="SSL certificate problem" if tls_rc else "")
    base = {"reach_row": "portfwd-buy", "state_hash": "s"}
    with contextlib.redirect_stdout(io.StringIO()) as out:
        rec = d._dispatch_l3(entry, "https", "cable-0a", "192.0.2.10", ["KEY=/dev/null", "API_TOKEN=t"], allow, base,
                             reach="portfwd", reach_name="buy")
    return rec, base, out.getvalue()
rec, base, out = dispatch(False, 0, False)
check("route mismatch -> refused, app never started", rec is None and not calls and "route not verified" in out)
rec, base, out = dispatch(False, 0, True)
check("route mismatch + --allow-dirty -> runs, forced reach-unverified", rec and base.get("forced") and "reach-unverified" in base["forced_reasons"]
      and calls and calls[0]["marks"]["forced"], base.get("forced_reasons"))
check("evidence recorded", base.get("reach_evidence", {}).get("host") == "api.example.nl")
rec, base, out = dispatch(True, 60, False)
check("route ok but TLS untrusted (curl 60) -> refused", rec is None and not calls and "TLS" in out)
rec, base, out = dispatch(True, 0, False)
check("route ok + TLS ok -> runs, not forced", rec and calls and not base.get("forced") and calls[0]["marks"] is None)
sys.exit(0 if ok else 1)
