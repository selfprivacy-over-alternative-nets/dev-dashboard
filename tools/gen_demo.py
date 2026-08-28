#!/usr/bin/env python3
"""Illustrative DEMO records (demo=true). The dashboard hides these by default (top-bar toggle);
they exist only so you can see the full 3-axis layout. `./dash clear-demo` removes them.
These are NOT real results.
"""
import datetime
import os

R = {
    "api": ("selfprivacy-api", "91462d2", "fix: await async get_users()"),
    "tests": ("selfprivacy-tor-tests", "4fec551", "docs: how_to_test_what"),
    "man": ("Manager-Ubuntu-SelfPrivacy-Over-Tor", "d94090d", "wip: socks5 proxy retries"),
}
FLOWS = [("connect", "connect to server"), ("login", "login / auth"),
         ("services", "services list loads"), ("providers", "providers tab"),
         ("nextcloud", "open Nextcloud"), ("menus", "navigate menus"),
         ("addremove", "add / remove service")]


def generate(append_record, now_iso):
    base = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    n = [0]

    def ts(m):
        return (base - datetime.timedelta(minutes=m)).isoformat().replace("+00:00", "Z")

    def rec(repo, cid, name, level, client, net, method, status, dur, mins, env="local",
            error="", cfg="", diff="", video=False, backend="-"):
        n[0] += 1
        rr, sha, subj = R[repo]
        art = {"client_log": "", "server_log": "", "video": ""}
        if level == "L3":
            art["client_log"] = f"logs/demo-{n[0]:04d}.log"
            art["server_log"] = f"logs/demo-{n[0]:04d}.server.log"
            if video:
                art["video"] = "media/demo-providers.mp4"
        append_record({
            "run_id": f"demo-{n[0]:04d}", "ts": ts(mins), "env": env, "host": "demo",
            "category": "install" if level == "install" else "test", "id": cid, "name": name,
            "level": level, "client": client, "transport": net, "method": method, "backend": backend,
            "config_label": cfg, "status": status, "duration_s": dur,
            "exit_code": 0 if status in ("pass", "slow") else 1, "error": error, "log_path": "",
            "artifacts": art, "records_video": video,
            "repo": rr, "commit": sha, "subject": subj, "dirty": bool(diff), "diff_hash": diff, "demo": True,
        })

    # Installations (network-independent) — populate the install row per method
    rec("man", "install.vm-local", "VM · same device", "install", "-", "-", "vm-local", "pass", 720, 400, backend="vm")
    rec("man", "install.vm-local", "VM · same device", "install", "-", "-", "vm-local", "pass", 118, 40, backend="vm")
    rec("man", "install.native-ethernet", "native · ethernet", "install", "-", "-", "native-ethernet", "pass", 735, 500, backend="native")
    rec("man", "install.native-usb-nvme", "native · USB→NVMe", "install", "-", "-", "native-usb-nvme", "slow", 1180, 520, backend="native", error="slow: 19m40s over 15m budget")
    rec("man", "install.native-boot-usb", "native · bootable USB", "install", "-", "-", "native-boot-usb", "fail", 240, 540, backend="native", error="mount: /dev/sda1: can't read superblock (USB write incomplete?)")

    # L1 unit
    rec("api", "L1.onion-routing", "onion URL routing", "L1", "-", "-", "-", "pass", 0.8, 300, env="ci")
    rec("api", "L1.onion-routing", "onion URL routing", "L1", "-", "-", "-", "pass", 0.8, 12)

    # L2 backend integration (method=test-vm), per network
    rec("tests", "L2.backend", "backend up + routing", "L2", "-", "tor", "test-vm", "pass", 372, 305, env="ci")
    rec("tests", "L2.backend", "backend up + routing", "L2", "-", "tor", "test-vm", "pass", 358, 15)
    rec("tests", "L2.backend", "backend up + routing", "L2", "-", "https", "test-vm", "pass", 70, 305, env="ci")
    rec("tests", "L2.backend", "backend up + routing", "L2", "-", "https", "test-vm", "slow", 130, 14, error="slow: 130s over budget")

    # L3 desktop · tor · on the local VM backend — a full flow with one fail + a dirty-config fix
    tor = {"connect": ("pass", 12), "login": ("pass", 3), "services": ("slow", 9),
           "providers": ("pass", 7), "nextcloud": ("pass", 5), "menus": ("pass", 6),
           "addremove": ("fail", 22)}
    for slug, name in FLOWS:
        st, d = tor[slug]
        err = ("TimeoutException: POST /services no response in 20s" if st == "fail"
               else "slow: over 5s budget" if st == "slow" else "")
        rec("man", f"L3.{slug}.desktop", name, "L3", "desktop", "tor", "vm-local", st, d, 20,
            error=err, video=(slug == "providers"))
        st2, d2 = ("pass", 18) if slug == "addremove" else (st, d)
        rec("man", f"L3.{slug}.desktop", name, "L3", "desktop", "tor", "vm-local", st2, d2, 6,
            error=("" if slug == "addremove" else err), cfg="socks5 retry patch (uncommitted)",
            diff="e4f5a1b2", video=(slug == "providers"))

    # L3 desktop · https · local VM — fast + green
    https_d = {"connect": 2, "login": 1, "services": 2, "providers": 3, "nextcloud": 3, "menus": 4, "addremove": 11}
    for slug, name in FLOWS:
        rec("man", f"L3.{slug}.desktop", name, "L3", "desktop", "https", "vm-local", "pass", https_d[slug], 18,
            env="ci", video=(slug == "providers"))

    # L3 desktop · tor · native-ethernet backend (other hardware) — partial
    rec("man", "L3.connect.desktop", "connect to server", "L3", "desktop", "tor", "native-ethernet", "pass", 14, 25)
    rec("man", "L3.providers.desktop", "providers tab", "L3", "desktop", "tor", "native-ethernet", "pass", 8, 25, video=True)

    # L3 android · https — partial
    rec("man", "L3.connect.android", "connect to server", "L3", "android", "https", "vm-local", "pass", 3, 26)
    rec("man", "L3.providers.android", "providers tab", "L3", "android", "https", "vm-local", "pass", 4, 26, video=True)
    rec("man", "L3.connect.android", "connect to server", "L3", "android", "tor", "vm-local", "fail", 30, 27,
        error="SocketException: SOCKS5 handshake timed out (Orbot not bootstrapped?)")


if __name__ == "__main__":
    import json
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "results.jsonl")
    with open(out, "a") as f:
        generate(lambda r: f.write(json.dumps(r) + "\n"), None)
    print("appended demo data to", out)
