#!/usr/bin/env python3
"""Tests dash's install arguments (req 190) without a stick, a box or the network: `--to-usb <path>` resolves to the
removable drive behind that path (never a drive holding the system), the overview names it AND the other removable
drives, the confirm re-asks until the drive's name is typed (blank aborts), the setup is derived (usb-0a, usb-0d, an
explicit --on may agree but never contradict), the transport follows --domain, the domain is checked (a DuckDNS name
must exist), each install gets a fresh key, and the fully written-out command is built and redacted. Every probe is
mocked (lsblk, DNS, ssh-keygen); writes nothing.
  python3 tools/test_install_args.py ./dash"""
import importlib.machinery, importlib.util, datetime, os, socket, sys
sys.dont_write_bytecode = True   # no __pycache__ next to dash
path = sys.argv[1] if len(sys.argv) > 1 else "./dash"
loader = importlib.machinery.SourceFileLoader("dash", path)
spec = importlib.util.spec_from_loader("dash", loader)
d = importlib.util.module_from_spec(spec)
loader.exec_module(d)
bad = 0


def check(name, cond, extra=""):
    global bad
    print(("ok   " if cond else "FAIL ") + name + (f"  {extra}" if extra and not cond else ""))
    bad += not cond


G = 1024 ** 3
MNT = "/run/media/a/f4fbd8ee-b585-4759-9f38-e2e32072a9d8"
# this laptop's shape: an SD card (hotplug, tran mmc, rm false) with a mounted partition, the NVMe system disk whose LVM
# holds /, plus a USB stick with a label
TREE = {"blockdevices": [
    {"name": "mmcblk0", "path": "/dev/mmcblk0", "type": "disk", "rm": False, "hotplug": True, "tran": "mmc", "size": int(477.5 * G),
     "fsavail": None, "fssize": None, "fstype": None, "label": None, "vendor": None, "model": None, "mountpoints": [None], "pkname": None,
     "children": [
         {"name": "mmcblk0p1", "path": "/dev/mmcblk0p1", "type": "part", "rm": False, "hotplug": True, "tran": "mmc", "size": G, "fsavail": None,
          "fssize": None, "fstype": "vfat", "label": None, "vendor": None, "model": None, "mountpoints": [None], "pkname": "mmcblk0"},
         {"name": "mmcblk0p2", "path": "/dev/mmcblk0p2", "type": "part", "rm": False, "hotplug": True, "tran": "mmc", "size": 2 * G,
          "fsavail": int(1.4 * G), "fssize": int(1.9 * G), "fstype": "ext4", "label": None, "vendor": None, "model": None, "mountpoints": [MNT], "pkname": "mmcblk0"}]},
    {"name": "nvme0n1", "path": "/dev/nvme0n1", "type": "disk", "rm": False, "hotplug": False, "tran": "nvme", "size": int(476.9 * G),
     "fsavail": None, "fssize": None, "fstype": None, "label": None, "vendor": None, "model": "SK hynix PC801", "mountpoints": [None], "pkname": None,
     "children": [
         {"name": "nvme0n1p2", "path": "/dev/nvme0n1p2", "type": "part", "rm": False, "hotplug": False, "tran": "nvme", "size": 2 * G, "fsavail": G,
          "fssize": 2 * G, "fstype": "ext4", "label": None, "vendor": None, "model": None, "mountpoints": ["/boot"], "pkname": "nvme0n1"},
         {"name": "nvme0n1p3", "path": "/dev/nvme0n1p3", "type": "part", "rm": False, "hotplug": False, "tran": "nvme", "size": int(473.9 * G), "fsavail": None,
          "fssize": None, "fstype": "crypto_LUKS", "label": None, "vendor": None, "model": None, "mountpoints": [None], "pkname": "nvme0n1",
          "children": [{"name": "dm_crypt-0", "path": "/dev/mapper/dm_crypt-0", "type": "crypt", "rm": False, "hotplug": False, "tran": None, "size": int(473.9 * G),
                        "fsavail": None, "fssize": None, "fstype": "LVM2_member", "label": None, "vendor": None, "model": None, "mountpoints": [None], "pkname": "nvme0n1p3",
                        "children": [{"name": "ubuntu--vg-ubuntu--lv", "path": "/dev/mapper/ubuntu--vg-ubuntu--lv", "type": "lvm", "rm": False, "hotplug": False, "tran": None,
                                      "size": int(473.9 * G), "fsavail": int(145.2 * G), "fssize": int(465.4 * G), "fstype": "ext4", "label": None, "vendor": None, "model": None,
                                      "mountpoints": ["/"], "pkname": "dm_crypt-0"}]}]}]},
    {"name": "sdb", "path": "/dev/sdb", "type": "disk", "rm": True, "hotplug": True, "tran": "usb", "size": int(28.7 * G), "fsavail": None, "fssize": None,
     "fstype": None, "label": None, "vendor": "SanDisk", "model": "Ultra", "mountpoints": [None], "pkname": None,
     "children": [{"name": "sdb1", "path": "/dev/sdb1", "type": "part", "rm": True, "hotplug": True, "tran": "usb", "size": int(28.7 * G), "fsavail": int(12 * G),
                   "fssize": int(28.6 * G), "fstype": "vfat", "label": "STICK", "vendor": None, "model": None, "mountpoints": ["/media/a/STICK"], "pkname": "sdb"}]},
    {"name": "loop0", "path": "/dev/loop0", "type": "loop", "rm": False, "hotplug": False, "tran": None, "size": 4096, "fsavail": 0, "fssize": 131072,
     "fstype": "squashfs", "label": None, "vendor": None, "model": None, "mountpoints": ["/snap/bare/5"], "pkname": None}]}

# ---- the drives: which are removable, which hold the system ----
disks = d.usb_disks(TREE)
by = {x["name"]: x for x in disks}
check("removable drives found: the SD card (hotplug, mmc) and the USB stick; loops and the NVMe are not", [x["name"] for x in disks if x["removable"]] == ["mmcblk0", "sdb"], str([x["name"] for x in disks]))
check("the NVMe holds the system (/ through LUKS + LVM, /boot) → protected", by["nvme0n1"]["protected"] and not by["mmcblk0"]["protected"] and not by["sdb"]["protected"])
# ---- --to-usb <path> → the drive behind it ----
disk, part = d.usb_resolve(MNT, TREE)
check("--to-usb <mount path of the SD card> → mmcblk0 (its partition p2)", disk["name"] == "mmcblk0" and part["name"] == "mmcblk0p2")
disk, part = d.usb_resolve(MNT + "/some/folder", TREE)
check("a folder inside the mount resolves to the same drive", disk["name"] == "mmcblk0")
check("--to-usb /dev/sdb1 (a partition) → sdb", d.usb_resolve("/dev/sdb1", TREE)[0]["name"] == "sdb")
check("--to-usb /dev/sdb (the disk) → sdb", d.usb_resolve("/dev/sdb", TREE)[0]["name"] == "sdb")
for p, why in (("/boot", "system"), ("/dev/nvme0n1", "system"), ("/nowhere/at/all", "not")):
    try:
        d.usb_resolve(p, TREE); check(f"--to-usb {p} is refused", False)
    except ValueError as ex:
        check(f"--to-usb {p} is refused ({why})", why in str(ex), str(ex))
# ---- the overview: the chosen drive AND the others, so nobody confirms the wrong one ----
ov = d.usb_overview(by["mmcblk0"], [by["sdb"]], chosen_path=MNT)
check("overview names the chosen drive with its size, free space and path", all(s in ov for s in ("mmcblk0", "477.5 GB", "1.4 GB free", MNT, "ERASED")), ov)
check("…and the other removable drive, marked not chosen", "sdb" in ov and "SanDisk Ultra" in ov and "28.7 GB" in ov and "NOT chosen" in ov, ov)
ov1 = d.usb_overview(by["sdb"], [], chosen_path="/dev/sdb")
check("with one removable drive the overview says there is no other", "no other removable drive" in ov1, ov1)
check("sizes read like a person says them", d.human_size(int(477.5 * G)) == "477.5 GB" and d.human_size(int(1.4 * G)) == "1.4 GB" and d.human_size(512 * 1024 ** 2) == "512 MB")
# ---- the setup: derived from the flags, an explicit --on may agree but never contradict ----
cat = d.load_catalog()
check("--to-usb alone → usb-0a (the server's cable goes into your router)", d.derive_install_setup(MNT, None, None, cat) == ("usb-0a", None))
check("--to-usb --wifi <ssid> → usb-0d (wifi only)", d.derive_install_setup(MNT, "HomeWifi", None, cat) == ("usb-0d", None))
check("--to-usb --wifi --on usb-0c → usb-0c (cable to R, wifi to another router)", d.derive_install_setup(MNT, "Other", "usb-0c", cat) == ("usb-0c", None))
check("--to-usb --on usb-0a agrees", d.derive_install_setup(MNT, None, "usb-0a", cat) == ("usb-0a", None))
s, err = d.derive_install_setup(MNT, None, "cable-0a", cat)
check("--to-usb with --on cable-0a contradicts", s is None and "contradict" in (err or ""), err)
s, err = d.derive_install_setup(MNT, None, "usb-0d", cat)
check("--on usb-0d without --wifi is refused (that setup leaves the server on wifi)", s is None and "wifi" in (err or ""), err)
check("no --to-usb: --on is taken as before", d.derive_install_setup(None, None, "cable-0a", cat) == ("cable-0a", None))
# ---- the transport follows the domain ----
check("--domain → https", d.derive_transport("yourname.duckdns.org", []) == "https")
check("an explicit --env TRANSPORT=onion wins", d.derive_transport("yourname.duckdns.org", ["TRANSPORT=onion"]) == "onion")
check("no domain, nothing explicit → none derived", d.derive_transport(None, []) is None)
# ---- the domain is checked: syntax, and a DuckDNS name must exist (it is claimed on the website first) ----
def gai_fail(*a, **k): raise socket.gaierror("NXDOMAIN")
def gai_ok(*a, **k): return [(2, 1, 6, "", ("203.0.113.7", 0))]
ok, msg = d.domain_check("not a domain", resolve=gai_ok)
check("syntax: 'not a domain' is refused", not ok and "domain" in msg, msg)
ok, msg = d.domain_check("yourname.duckdns.org", resolve=gai_fail)
check("an unclaimed DuckDNS name is refused (claim it at duckdns.org first)", not ok and "duckdns" in msg.lower(), msg)
ok, msg = d.domain_check("yourname.duckdns.org", resolve=gai_ok)
check("a claimed DuckDNS name passes", ok, msg)
ok, msg = d.domain_check("example.org", resolve=gai_fail)
check("a bought domain that does not resolve yet is a warning, not a refusal", ok and "warn" in msg.lower(), msg)
# ---- a fresh key per install, named after the domain and the moment ----
when = datetime.datetime(2026, 11, 11, 15, 30)
kp = d.fresh_key_path("yourname.duckdns.org", when=when)
check("fresh key path: ~/.ssh/selfprivacy-<domain>-<YYYYMMDD-HHMM>_ed25519", kp == os.path.expanduser("~/.ssh/selfprivacy-yourname.duckdns.org-20261111-1530_ed25519"), kp)
calls = []
def keygen(p): calls.append(p); return p, p + ".pub"
# ---- the whole preparation: env for the chain, the setup, the ids and the fully written-out command ----
class A: pass
a = A(); a.ids = ["install"]; a.to_usb = MNT; a.wifi = None; a.on = None; a.domain = "yourname.duckdns.org"; a.key = None; a.ip = None; a.token = None; a.env = []
asked = []
def ask(prompt):   # a wrong drive name re-asks (req 142): first "sdb" (the other stick), then the right name
    asked.append(prompt); return "sdb" if len(asked) == 1 else "mmcblk0"
prep = d.install_run_prep(a, cat, tree=TREE, ask=ask, keygen=keygen, resolve=gai_ok, when=when, isatty=True)
check("a wrong drive name re-asks, the right one confirms", prep is not None and len(asked) == 2, str(asked))
env = dict(kv.split("=", 1) for kv in prep["env"])
check("the chain gets the drive, the confirmation, the domain, the transport, the key and the flakes from git",
      env.get("USB_DEV") == "/dev/mmcblk0" and env.get("USB_CONFIRMED") == "/dev/mmcblk0" and env.get("DOMAIN") == "yourname.duckdns.org"
      and env.get("TRANSPORT") == "https" and env.get("KEY") == kp and env.get("ISO_FLAKE", "").startswith("github:selfprivacy-over-tor/Manager-Ubuntu-SelfPrivacy-Over-Tor")
      and env.get("FLAKE", "").startswith("github:"), str(env))
check("a fresh key was generated for this install", calls == [kp], str(calls))
check("the run is filed under usb-0a and runs install.usb-0a", prep["on"] == "usb-0a" and prep["ids"] == ["install.usb-0a"], str((prep["on"], prep["ids"])))
full = prep["cmd_full"]
check("the fully written-out command names every value", all(s in full for s in ("./dash run install.usb-0a --on usb-0a", f"--to-usb {MNT}", "--domain yourname.duckdns.org", f"--key {kp}",
                                                                                   "--env USB_DEV=/dev/mmcblk0", "--env TRANSPORT=https", "--env ISO_FLAKE=github:", "--env FLAKE=github:")), full)
check("…and no address, token or password", "192." not in full and "token" not in full.lower(), full)
# blank = abort
a2 = A(); a2.__dict__.update(a.__dict__)
try:
    r = d.install_run_prep(a2, cat, tree=TREE, ask=lambda p: "", keygen=keygen, resolve=gai_ok, when=when, isatty=True); aborted = r is None
except SystemExit:
    aborted = True
check("a blank answer aborts, nothing is written", aborted)
# not a terminal: no question can be asked → refuse, unless the drive was confirmed on the command line
try:
    r = d.install_run_prep(a2, cat, tree=TREE, ask=None, keygen=keygen, resolve=gai_ok, when=when, isatty=False); refused = r is None
except SystemExit:
    refused = True
check("without a terminal the drive cannot be confirmed → refused", refused)
a3 = A(); a3.__dict__.update(a.__dict__); a3.env = ["USB_CONFIRMED=/dev/mmcblk0"]
r = d.install_run_prep(a3, cat, tree=TREE, ask=None, keygen=keygen, resolve=gai_ok, when=when, isatty=False)
check("…unless --env USB_CONFIRMED=/dev/mmcblk0 says it was", r is not None and dict(kv.split("=", 1) for kv in r["env"]).get("USB_DEV") == "/dev/mmcblk0")
# an explicit --key is used as given (no fresh key), --ip is passed on
a4 = A(); a4.__dict__.update(a.__dict__); a4.key = "/home/me/.ssh/my_key"; a4.ip = "198.51.100.9"; a4.env = ["USB_CONFIRMED=/dev/mmcblk0"]
calls.clear()
r = d.install_run_prep(a4, cat, tree=TREE, ask=None, keygen=keygen, resolve=gai_ok, when=when, isatty=False)
check("an explicit --key is used and no key is generated; --ip goes into the command", calls == [] and "--key /home/me/.ssh/my_key" in r["cmd_full"] and "--ip 198.51.100.9" in r["cmd_full"], r["cmd_full"])
# the wifi variant: --wifi goes to the chain as WIFI_SSID, the setup is usb-0d
a5 = A(); a5.__dict__.update(a.__dict__); a5.wifi = "HomeWifi"; a5.env = ["USB_CONFIRMED=/dev/mmcblk0"]
r = d.install_run_prep(a5, cat, tree=TREE, ask=None, keygen=keygen, resolve=gai_ok, when=when, isatty=False)
check("--wifi HomeWifi → usb-0d, WIFI_SSID for the chain, in the full command", r["on"] == "usb-0d" and "WIFI_SSID=HomeWifi" in r["env"] and "--wifi HomeWifi" in r["cmd_full"], str((r["on"], r["cmd_full"])))
# ---- redaction of the stored command ----
red = d.redact_cmdline("./dash run L3.connect.desktop --token abc123 --env WIFI_PSK=s3cret --env DOMAIN=x.org")
check("tokens and wifi passwords are redacted in the stored command", "abc123" not in red and "s3cret" not in red and "--token <redacted>" in red and "WIFI_PSK=<redacted>" in red and "DOMAIN=x.org" in red, red)
# ---- what the chain reports back ----
check("a '[dash-found] IP=… MAC=…' line from the chain is read", d.found_marks("[dash-found] IP=203.0.113.9 MAC=aa:bb:cc:dd:ee:ff") == {"IP": "203.0.113.9", "MAC": "aa:bb:cc:dd:ee:ff"} and d.found_marks("hello") is None)
print(f"\n{'all good' if not bad else str(bad) + ' problem(s)'}")
sys.exit(1 if bad else 0)
