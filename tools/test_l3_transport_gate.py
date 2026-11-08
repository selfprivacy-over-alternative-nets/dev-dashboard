#!/usr/bin/env python3
"""Tests dash's L3 transport gate (req 189) without a VM, a box or Tor: an onion L3 flow must be REFUSED — nothing
injected into the app, nothing recorded — when its transport is down, with the cause named (host Tor SOCKS not
running / listening but not bootstrapped = the network blocks Tor / the backend's hidden-service descriptor not
published / the chutney backend not up). Every probe is mocked; the app repo is not touched. Writes nothing.
  python3 tools/test_l3_transport_gate.py ./dash"""
import importlib.machinery, importlib.util, io, contextlib, os, sys

sys.dont_write_bytecode = True   # no __pycache__ next to dash
path = sys.argv[1] if len(sys.argv) > 1 else "./dash"
loader = importlib.machinery.SourceFileLoader("dash", path)
spec = importlib.util.spec_from_loader("dash", loader)
d = importlib.util.module_from_spec(spec)
loader.exec_module(d)

ok = True


def check(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


app_dir = os.path.normpath(os.path.join(d.ROOT, d.FLUTTER_APP_DIR))
itdir = os.path.join(app_dir, "integration_test")
had_itdir = os.path.isdir(itdir)

# Nothing real: no nix path check, the onion never answers, no VM tor to kick.
d._ensure_api_nix_path = lambda: None
d._onion_reachable = lambda *a, **k: False
d._kick_vm_tor = lambda: None


def run(net, socks_up, socks_port, works):
    d._tor_socks_works = works
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rec = d.run_l3_flutter("fake-backend.onion", "token", {"tor": socks_up}, net=net,   # not a real onion name
                               socks_port=socks_port, flow="connect")
    return rec, out.getvalue()


rec, out = run("tor", True, 9050, lambda *a, **k: False)
check("tor: SOCKS open but Tor not bootstrapped -> refused, cause = network blocks Tor",
      rec is None and "cannot reach the Tor network" in out)
rec, out = run("tor", True, 9050, lambda *a, **k: True)
check("tor: Tor works but the onion never answers -> refused, cause = descriptor not published",
      rec is None and "descriptor was not published" in out)
rec, out = run("tor", False, 9050, lambda *a, **k: (_ for _ in ()).throw(AssertionError("probed")))
check("tor: SOCKS not running -> refused without probing", rec is None and "is not running" in out)
calls = {"n": 0}


def counting(*a, **k):
    calls["n"] += 1
    return True


rec, out = run("chutney", False, 9009, counting)
check("chutney: never reachable -> refused, clearnet probe NOT used", rec is None and calls["n"] == 0 and "chutney" in out)
check("every refusal says it is not an app failure and records nothing", "no false app failure is recorded" in out)
check("the app repo was never touched (no integration_test/ injected)", os.path.isdir(itdir) == had_itdir)

print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
