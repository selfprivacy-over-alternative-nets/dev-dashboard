#!/usr/bin/env python3
"""Generate clearly-labeled DEMO records (demo=true) so the dashboard shows a full matrix
before real runs accumulate. Remove anytime with `./dash clear-demo` or the in-page toggle.
These are illustrative, NOT real test results.
"""
import datetime
import os

REPOS = {
    "api": ("selfprivacy-api", "91462d2", "fix: await async get_users()"),
    "tests": ("selfprivacy-tor-tests", "4fec551", "docs: how_to_test_what"),
    "manager": ("Manager-Ubuntu-SelfPrivacy-Over-Tor", "d94090d", "wip: socks5 proxy retries"),
    "manager_old": ("Manager-Ubuntu-SelfPrivacy-Over-Tor", "c1c2c3d", "feat: android deploy"),
}
FLOWS = [("connect", "connect to server"), ("login", "login / auth"),
         ("services", "services list loads"), ("nextcloud", "open Nextcloud"),
         ("menus", "navigate menus"), ("addremove", "add / remove service"),
         ("logout", "logout")]


def generate(append_record, now_iso):
    base = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    n = [0]

    def ts(mins_ago):
        return (base - datetime.timedelta(minutes=mins_ago)).isoformat().replace("+00:00", "Z")

    def rec(repo_key, cid, name, level, client, transport, status, dur, mins_ago,
            env="local", error="", method="-", backend="-", config_label="", diff_hash=""):
        n[0] += 1
        r, sha, subj = REPOS[repo_key]
        append_record({
            "run_id": f"demo-{n[0]:04d}", "ts": ts(mins_ago), "env": env, "host": "demo",
            "category": "install" if level == "install" else "test", "id": cid, "name": name,
            "level": level, "client": client, "transport": transport, "backend": backend,
            "method": method, "config_label": config_label, "status": status,
            "duration_s": dur, "exit_code": 0 if status in ("pass", "slow") else 1,
            "error": error, "log_path": "", "repo": r, "commit": sha, "subject": subj,
            "dirty": bool(diff_hash), "diff_hash": diff_hash, "demo": True,
        })

    # ── CORE: L1 (multiple runs, stacked) + L2 ──────────────────────────────
    rec("api", "L1.onion-routing", "onion URL routing", "L1", "-", "unit", "pass", 0.8, 300, env="ci")
    rec("api", "L1.onion-routing", "onion URL routing", "L1", "-", "unit", "pass", 0.9, 130)
    rec("api", "L1.onion-routing", "onion URL routing", "L1", "-", "unit", "pass", 0.8, 12)
    rec("tests", "L2.tor-integration", "backend up + routing", "L2", "-", "tor", "pass", 372, 305, env="ci")
    rec("tests", "L2.tor-integration", "backend up + routing", "L2", "-", "tor", "pass", 358, 15)
    rec("tests", "L2.https-integration", "backend up + routing", "L2", "-", "https", "pass", 70, 305, env="ci")
    rec("tests", "L2.https-integration", "backend up + routing", "L2", "-", "https", "slow", 130, 14,
        error="slow: 130s > budget")

    # ── L3 desktop·tor : a full clean run + a dirty-config run (shows config dropdown) ──
    tor_status = {"connect": ("pass", 12), "login": ("pass", 3), "services": ("slow", 9),
                  "nextcloud": ("pass", 5), "menus": ("pass", 6),
                  "addremove": ("fail", 22), "logout": ("pass", 2)}
    for slug, name in FLOWS:
        st, d = tor_status[slug]
        err = "TimeoutException: POST /services no response in 20s" if st == "fail" else (
            "slow: 9s > 5s budget" if st == "slow" else "")
        # clean tree
        rec("manager", f"L3.{slug}.desktop.tor", name, "L3", "desktop", "tor", st, d, 20, error=err)
        # dirty 'socks5 retry patch' — the addremove flow now passes with the WIP fix
        st2, d2 = ("pass", 18) if slug == "addremove" else (st, d)
        err2 = "" if slug == "addremove" else err
        rec("manager", f"L3.{slug}.desktop.tor", name, "L3", "desktop", "tor", st2, d2, 6,
            config_label="socks5 retry patch (uncommitted)", diff_hash="e4f5a1b2", error=err2)

    # ── L3 desktop·https : fast + reliable path, all green ──────────────────
    https_dur = {"connect": 2, "login": 1, "services": 2, "nextcloud": 3, "menus": 4,
                 "addremove": 11, "logout": 1}
    for slug, name in FLOWS:
        rec("manager", f"L3.{slug}.desktop.https", name, "L3", "desktop", "https", "pass",
            https_dur[slug], 18, env="ci")

    # ── L3 android·https : partial ─────────────────────────────────────────
    rec("manager", "L3.connect.android.https", "connect to server", "L3", "android", "https", "pass", 3, 25)
    rec("manager", "L3.login.android.https", "login / auth", "L3", "android", "https", "pass", 2, 25)
    rec("manager", "L3.services.android.https", "services list loads", "L3", "android", "https", "pass", 2, 25)
    rec("manager", "L3.nextcloud.android.https", "open Nextcloud", "L3", "android", "https", "slow", 7, 25,
        error="slow: 7s > 5s budget")
    # android·tor connect fails (Orbot circuit)
    rec("manager", "L3.connect.android.tor", "connect to server", "L3", "android", "tor", "fail", 30, 26,
        error="SocketException: SOCKS5 handshake timed out (Orbot not bootstrapped?)")

    # ── Installations: separate section, times stacked ──────────────────────
    rec("manager", "install.vm-ubuntu-here", "VM on Ubuntu — this device", "install", "-", "-",
        "pass", 720, 400, method="vm-local", backend="vm")
    rec("manager", "install.vm-ubuntu-here", "VM on Ubuntu — this device", "install", "-", "-",
        "pass", 118, 40, method="vm-local", backend="vm")  # download mode, faster
    rec("manager", "install.native-ethernet", "NixOS native — ethernet", "install", "-", "-",
        "pass", 735, 500, method="native-ethernet", backend="native")
    rec("manager", "install.native-usb-nvme", "NixOS native — USB installer → NVMe", "install", "-", "-",
        "slow", 1180, 520, method="usb-installer", backend="native", error="slow: 19m40s")
    rec("manager", "install.native-boot-usb", "NixOS native — bootable USB", "install", "-", "-",
        "fail", 240, 540, method="bootable-usb", backend="native",
        error="mount: /dev/sda1: can't read superblock (USB write incomplete?)")


if __name__ == "__main__":
    import json
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "results.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "a") as f:
        generate(lambda r: f.write(json.dumps(r) + "\n"), None)
    print("appended demo data to", out)
