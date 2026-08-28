#!/usr/bin/env python3
"""Generate catalog.json — the declarative list of every command the dashboard tracks.

Edit this file (not catalog.json) to add/adjust commands, then run:  python3 tools/gen_catalog.py
The catalog drives both the `dash` orchestrator and the matrix scaffold (so a test that has
never run still shows up as a grey 'pending' cell — you always see the full picture).
"""
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Repos under test, relative to this dashboard repo (sibling checkouts).
API = "../selfprivacy-api"
TESTS = "../selfprivacy-tor-tests"
MANAGER = "../Manager-Ubuntu-SelfPrivacy-Over-Tor"
BACKEND = "../Manager-Ubuntu-SelfPrivacy-Over-Tor/backend"

# L3 usage flows — "walk the app like a user". These exercise the Flutter app.
FLOWS = [
    ("connect", "connect to server"),
    ("login", "login / auth"),
    ("services", "services list loads"),
    ("nextcloud", "open Nextcloud"),
    ("menus", "navigate menus"),
    ("addremove", "add / remove service"),
    ("logout", "logout"),
]
# Which transports each client supports for L3.
CLIENT_TRANSPORTS = {
    "desktop": ["tor", "chutney", "https"],
    "android": ["tor", "https"],
}

entries = []

# ── CORE: L1 unit + L2 nixosTests ────────────────────────────────────────────
entries.append({
    "id": "L1.onion-routing", "name": "onion URL routing", "category": "test",
    "level": "L1", "client": "-", "transport": "unit", "backend": "-",
    "repo": API, "budget_s": 180,
    "cmd": "nix run .#pytest-vm -- tests/test_onion_routing.py -q",
})
entries.append({
    "id": "L2.tor-integration", "name": "backend up + routing", "category": "test",
    "level": "L2", "client": "-", "transport": "tor", "backend": "native",
    "repo": TESTS, "budget_s": 1800,
    "cmd": "nix build .#checks.x86_64-linux.tor-integration --no-link -L",
})
entries.append({
    "id": "L2.https-integration", "name": "backend up + routing", "category": "test",
    "level": "L2", "client": "-", "transport": "https", "backend": "native",
    "repo": TESTS, "budget_s": 1800,
    "cmd": "nix build .#checks.x86_64-linux.https-integration --no-link -L",
})

# ── L3: usage flows × client × transport ─────────────────────────────────────
for client, transports in CLIENT_TRANSPORTS.items():
    for t in transports:
        for slug, name in FLOWS:
            entries.append({
                "id": f"L3.{slug}.{client}.{t}", "name": name, "category": "test",
                "level": "L3", "client": client, "transport": t, "backend": "-",
                "repo": MANAGER, "budget_s": 60,
                # @todo = Flutter integration test not written yet -> shows as 'pending'.
                "cmd": "@todo",
            })

# ── Installations: separate section, tracked for time + method ───────────────
installs = [
    ("install.vm-ubuntu-here", "VM on Ubuntu — this device", "vm-local", "vm",
     "SP_BUILD_MODE=download SP_VM_ACTION=reinstall ./build-and-run.sh"),
    ("install.vm-ubuntu-remote", "VM on Ubuntu — another device", "vm-remote", "vm", "@manual"),
    ("install.native-ethernet", "NixOS native — ethernet", "native-ethernet", "native", "@manual"),
    ("install.native-usb-nvme", "NixOS native — USB installer → NVMe", "usb-installer", "native", "@manual"),
    ("install.native-boot-usb", "NixOS native — bootable USB", "bootable-usb", "native", "@manual"),
]
for iid, name, method, backend, cmd in installs:
    entries.append({
        "id": iid, "name": name, "category": "install", "level": "install",
        "client": "-", "transport": "-", "backend": backend, "method": method,
        "repo": BACKEND, "budget_s": 900, "cmd": cmd,
    })

catalog = {
    "transports": ["unit", "tor", "chutney", "https", "yggdrasil", "hyphanet"],
    "future_transports": ["yggdrasil", "hyphanet"],
    "clients": ["desktop", "android"],
    "flows": [f[0] for f in FLOWS],
    "entries": entries,
}

out = os.path.join(HERE, "catalog.json")
with open(out, "w") as f:
    json.dump(catalog, f, indent=2)
    f.write("\n")
print(f"wrote {out}: {len(entries)} entries")
