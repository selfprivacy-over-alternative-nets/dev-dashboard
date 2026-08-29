#!/usr/bin/env python3
"""CI entrypoint for the L3 `https` flows over the trusted real domain (theory7.weersurf.nl).

Runs on a SELF-HOSTED GitHub Actions runner on the dev machine — the only place this can run: the
backend is a local VBox VM reached over an SSH tunnel + a Caddy/mkcert reverse-proxy that serves a
browser-trusted cert for a real weersurf.nl subdomain, and the flow drives the real Flutter app
headlessly (Xvfb). GitHub's cloud runners cannot reach any of that.

Ensures the VM + tunnel + Caddy are up, waits for the backend to answer over HTTPS with a VALID cert,
then runs each https flow and fails the job (exit 1) if any flow is not green. Flows come from
$CI_FLOWS (comma-separated) or default to all eight desktop flows.
"""
import json
import os
import subprocess
import sys
import time
from importlib.machinery import SourceFileLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
m = SourceFileLoader("dash", "./dash").load_module()

FLOWS = [
    f.strip()
    for f in os.environ.get(
        "CI_FLOWS",
        "connect,login,services,providers,nextcloud,users,menus,addremove",
    ).split(",")
    if f.strip()
]
PF = {"tor": True, "flutter": True, "display": True}


def log(*a):
    print("[ci-https]", *a, flush=True)


def backend_up():
    """True iff https://<domain>/api/version answers 200 with a cert VALID against the mkcert CA."""
    try:
        r = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20",
             "--cacert", m.MKCERT_CA, f"https://{m.THEORY7_DOMAIN}/api/version"],
            capture_output=True, text=True, timeout=30)
        return r.stdout.strip() == "200"
    except Exception:
        return False


def main():
    log(f"target: https://{m.THEORY7_DOMAIN}  flows: {', '.join(FLOWS)}")

    # 1. VM up.
    if not m._vm_running():
        if not m._vm_exists():
            log("FATAL: VBox VM does not exist on this runner host.")
            return 2
        log("VM not running — starting headless…")
        m._sh(f'VBoxManage startvm "{m.VM_NAME}" --type headless', timeout=120)

    # 2. Trusted-HTTPS chain (SSH tunnel + Caddy user-service).
    m._ensure_theory7()
    if not os.path.exists(m.MKCERT_CA):
        log(f"FATAL: mkcert CA missing at {m.MKCERT_CA} — run setup-theory7-https.sh once.")
        return 2

    # 3. Wait for the backend to answer over HTTPS with a valid cert (VM boot can take minutes).
    ok = False
    for i in range(45):
        if backend_up():
            ok = True
            break
        m._ensure_theory7()  # the SSH tunnel can drop while the VM boots — re-establish
        log(f"waiting for a valid-cert 200 from https://{m.THEORY7_DOMAIN} … ({i + 1})")
        time.sleep(10)
    if not ok:
        log(f"FATAL: backend not reachable with a valid cert at https://{m.THEORY7_DOMAIN}.")
        return 2
    log(f"backend up (valid cert) at https://{m.THEORY7_DOMAIN}")

    # 4. Run each https flow; a flow is green only if its latest record says pass.
    failures = []
    for flow in FLOWS:
        log(f"running https flow: {flow}")
        try:
            m.run_l3_flutter("", m.DEV_TOKEN, PF, net="https", flow=flow, retries=1)
        except Exception as e:  # noqa: BLE001 — never let one flow abort the whole job
            log(f"  {flow}: EXCEPTION {e}")
            failures.append((flow, f"exception:{e}"))
            continue
        rows = [json.loads(x) for x in open("data/results.jsonl") if x.strip()]
        rec = [r for r in rows
               if r.get("id") == f"L3.{flow}.desktop" and r.get("transport") == "https"]
        status = rec[-1].get("status") if rec else "missing"
        log(f"  {flow}: {status}")
        if status != "pass":
            failures.append((flow, status))

    if failures:
        log("FAILURES: " + ", ".join(f"{f}={s}" for f, s in failures))
        return 1
    log(f"ALL {len(FLOWS)} https flows PASSED over {m.THEORY7_DOMAIN}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
