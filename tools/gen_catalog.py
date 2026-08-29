#!/usr/bin/env python3
"""Generate catalog.json — the declarative source of truth for the dashboard.

Three axes make up the matrix:
  • test / flow        (rows)
  • installation method (columns — WHERE/HOW the backend ran)
  • network / transport (the 3rd dimension — tor, chutney, https, ...)

'unit' is NOT a network — L1 unit tests are transport-agnostic and live in their own strip.
Every test carries a `desc` (shown on hover) and a `level` (explained in the dashboard legend).
Edit this file, then: python3 tools/gen_catalog.py
"""
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "../selfprivacy-api"
TESTS = "../selfprivacy-tor-tests"
MANAGER = "../Manager-Ubuntu-SelfPrivacy-Over-Tor"

# Real connection mechanisms only (no 'unit').
NETWORKS = ["tor", "chutney", "https", "yggdrasil", "hyphanet"]
FUTURE = ["yggdrasil", "hyphanet"]

LEVELS = {
    "L1": "Unit — pure Python logic in the API (e.g. onion/URL routing). No VM, no network, no app. Runs in milliseconds.",
    "L2": "Integration — a real NixOS backend boots in a VM and its routing is checked over a transport. No app involved.",
    "L3": "App usage — the SelfPrivacy app is driven like a user (open, navigate tabs, add a service, ...) against a running backend, and screen-recorded.",
}

# Installation methods = the columns. Each says where/how the backend runs.
INSTALL_METHODS = [
    {"id": "test-vm", "label": "auto test-VM", "backend": "vm", "group": "automated",
     "desc": "The self-contained NixOS test VM the L2 nixosTests spin up. Not a manual install."},
    {"id": "vm-local", "label": "VM · same device", "backend": "vm", "group": "VM on Ubuntu",
     "desc": "NixOS backend in VirtualBox on this Ubuntu host (build-and-run.sh)."},
    {"id": "vm-remote", "label": "VM · other device", "backend": "vm", "group": "VM on Ubuntu",
     "desc": "NixOS backend in VirtualBox, deployed from another device; app connects over the network."},
    {"id": "native-ethernet", "label": "native · ethernet", "backend": "native", "group": "NixOS native",
     "desc": "NixOS installed directly on other hardware (laptop/Pi) over ethernet from this device."},
    {"id": "native-usb-nvme", "label": "native · USB→NVMe", "backend": "native", "group": "NixOS native",
     "desc": "NixOS installed to the machine's internal NVMe via a formatted USB installer."},
    {"id": "native-boot-usb", "label": "native · bootable USB", "backend": "native", "group": "NixOS native",
     "desc": "NixOS booted directly off a bootable USB drive."},
]

FLOWS = [
    ("connect", "connect to server", "App connects to the backend over the selected network and reaches the API."),
    ("login", "login / auth", "App authenticates with the API token and loads the authenticated session."),
    ("services", "services list loads", "The Services tab loads the list of services from the backend."),
    ("providers", "providers tab", "Open the app, switch Providers→Services and back, then close — the recorded smoke flow."),
    ("nextcloud", "open Nextcloud", "Open the Nextcloud service detail from the app."),
    ("menus", "navigate menus", "Walk the main tabs (Providers → Services → Users → More) and back."),
    ("addremove", "add / remove service", "Enable then disable a service and confirm the backend applies it."),
]
CLIENT_NETS = {"desktop": ["tor", "chutney", "https"], "android": ["tor", "https"]}

tests = []

# L1 — unit (own strip; network-agnostic)
tests.append({
    "id": "L1.onion-routing", "name": "onion URL routing", "level": "L1", "client": "-",
    "networks": [], "repo": API, "budget_s": 180,
    "desc": "Unit-tests the API logic that rewrites service URLs for .onion path-routing (T1.1–T1.17).",
    "cmd": "nix run .#pytest-vm -- tests/test_onion_routing.py -q",
})

# L2 — backend integration, one test, transport-specific command
tests.append({
    "id": "L2.backend", "name": "backend up + routing", "level": "L2", "client": "-",
    "networks": ["tor", "https"], "method": "test-vm", "repo": TESTS, "budget_s": 1800,
    "desc": "Boots a NixOS backend in a VM and checks the API + nginx path routing are reachable over the transport (T2/T3).",
    "cmd_by_net": {
        "tor": "nix build .#checks.x86_64-linux.tor-integration --no-link -L",
        "https": "nix build .#checks.x86_64-linux.https-integration --no-link -L",
    },
    # Pulled after the run (best-effort) and stored as the server-side log for inspection.
    "server_log_cmd": "",
})

# Which (flow, client) pairs actually have an automated test written (dashboard/flutter/*.dart,
# injected by `dash here --long`). Everything else is genuinely "not implemented" yet.
IMPLEMENTED = {
    ("connect", "desktop"),
    ("login", "desktop"),
    ("services", "desktop"),
    ("providers", "desktop"),
    ("nextcloud", "desktop"),
    ("menus", "desktop"),
    ("addremove", "desktop"),
}

# L3 — app usage flows × client (network + install-method are runtime tags, not in the id)
for client, nets in CLIENT_NETS.items():
    for slug, name, desc in FLOWS:
        impl = (slug, client) in IMPLEMENTED
        tests.append({
            "id": f"L3.{slug}.{client}", "name": name, "level": "L3", "client": client,
            "networks": nets, "repo": MANAGER, "budget_s": 90,
            "desc": f"[{client}] {desc}",
            "implemented": impl,        # false => cell shows 'not implemented'; true+no run => 'not run'
            "cmd": "@flutter" if impl else "@todo",
            "records_video": True,
        })

# Installations — the manual/deploy procedures (their time is shown in the matrix's install row)
installs = [
    ("install.vm-local", "VM · same device", "vm-local",
     "SP_BUILD_MODE=download SP_VM_ACTION=reinstall ./build-and-run.sh"),
    ("install.vm-remote", "VM · other device", "vm-remote", "@manual"),
    ("install.native-ethernet", "native · ethernet", "native-ethernet", "@manual"),
    ("install.native-usb-nvme", "native · USB→NVMe", "native-usb-nvme", "@manual"),
    ("install.native-boot-usb", "native · bootable USB", "native-boot-usb", "@manual"),
]
install_entries = []
for iid, name, method, cmd in installs:
    m = next(x for x in INSTALL_METHODS if x["id"] == method)
    install_entries.append({
        "id": iid, "name": name, "level": "install", "category": "install", "client": "-",
        "networks": [], "method": method, "backend": m["backend"],
        "repo": MANAGER + "/backend", "budget_s": 900, "desc": m["desc"], "cmd": cmd,
    })

catalog = {
    "networks": NETWORKS, "future_networks": FUTURE, "levels": LEVELS,
    "install_methods": INSTALL_METHODS, "flows": [f[0] for f in FLOWS],
    "tests": tests, "installs": install_entries,
}
out = os.path.join(HERE, "catalog.json")
with open(out, "w") as f:
    json.dump(catalog, f, indent=2)
    f.write("\n")
print(f"wrote {out}: {len(tests)} tests + {len(install_entries)} installs")
