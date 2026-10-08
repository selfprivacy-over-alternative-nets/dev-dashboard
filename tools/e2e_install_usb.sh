#!/usr/bin/env bash
# ONE-CHAIN usb install+verify for catalog test case: install.usb
#
#   prepare a bootable installer USB on THIS device  ->  you boot+install it on the TARGET
#   ->  stamp the box with its build identity  ->  verify.  No separate steps; one chain.
#
# All user-facing args are REQUIRED (no implicit defaults): the written command is the whole
# truth on any device. Omitting one fails fast telling you what to set.
set -euo pipefail

FLAKE=${FLAKE:?required: deploy flake (for the stamp pins), e.g. FLAKE=/home/a/git/personal/selfprivacy/selfprivacy-altnet-deployer}
IP=${IP:?required: target IP once installed + on the network, e.g. IP=192.168.1.167}
MAC=${MAC:?required: target NIC MAC for LAN discovery, e.g. MAC=d8:cb:8a:7c:0a:f4}
KEY=${KEY:?required: ssh deploy key path, e.g. KEY=$HOME/.ssh/pcname_ed25519}
DOMAIN=${DOMAIN:?required: public domain, e.g. DOMAIN=example.com}
TRANSPORT=${TRANSPORT:?required: https | onion | none (install-only)}
ISO=${ISO:-}                                            # prebuilt installer .iso; else built from ISO_FLAKE
ISO_FLAKE=${ISO_FLAKE:-../Manager-Ubuntu-SelfPrivacy-Over-Tor/backend#packages.x86_64-linux.default}
USB_DEV=${USB_DEV:-}                                    # USB block device to WRITE (e.g. /dev/sdX) — ERASED
HERE="$(cd "$(dirname "$0")" && pwd)"
SSHO="-i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=6"
export NIX_CONFIG='experimental-features = nix-command flakes'
say(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ssh_ok(){ ssh $SSHO -o BatchMode=yes "root@$1" true 2>/dev/null; }

# Box build-identity JSON — prefers dash's full $DEV_TEST_STAMP, else reads $FLAKE/flake.lock.
stamp_json(){
  if [ -n "${DEV_TEST_STAMP:-}" ]; then
    DEV_TEST_STAMP="$DEV_TEST_STAMP" FLAKE="$FLAKE" python3 - <<'PY'
import os, json, datetime
d = json.loads(os.environ["DEV_TEST_STAMP"])
d["flake"] = os.environ.get("FLAKE", "")
d["deployed_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
for k, v in (d.get("pins") or {}).items():
    d.setdefault(k, v)
print(json.dumps(d))
PY
  else
    FLAKE="$FLAKE" python3 - <<'PY'
import os, json, datetime
f = os.environ["FLAKE"]
try:
    nodes = json.load(open(f + "/flake.lock")).get("nodes", {})
    pins = {k: (nodes.get(k, {}).get("locked", {}) or {}).get("rev", "unknown") for k in ("selfprivacy-api", "nixpkgs")}
except Exception:
    pins = {}
d = {"flake": f, "pins": pins, "deployed_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
d.update(pins)
print(json.dumps(d))
PY
  fi
}

# wifi setups (usb-0b/0c) need a wifi spec; confirm the SSID is in range without disturbing the
# current connection (scan only). Internet-through-it can't be checked without connecting.
wifi_preflight(){
  [ -n "${WIFI_SSID:-}" ] || return 0
  if command -v nmcli >/dev/null 2>&1; then
    if nmcli -t -f SSID dev wifi list 2>/dev/null | grep -qxF "$WIFI_SSID"; then
      echo "   wifi '$WIFI_SSID' is in range ✓ (internet via it not verified — that needs connecting)"
    else
      echo "   ⚠ wifi '$WIFI_SSID' is NOT visible in a scan — aborting."; return 1
    fi
  else
    echo "   (nmcli unavailable — cannot scan for wifi '$WIFI_SSID'; skipping check)"
  fi
}

say "0. preflight — setup availability (USB + wifi spec)"
wifi_preflight || exit 1

say "1. prepare the bootable installer USB on THIS device"
echo ">>> Insert a USB stick into THIS laptop now (its contents will be ERASED)."
read -r -p "Press ENTER when the USB is inserted (Ctrl-C to abort) ... " _ || true

if [ -z "$ISO" ]; then
  say "   building the installer ISO from $ISO_FLAKE (nix build) ..."
  nix build -L "$ISO_FLAKE" --out-link /tmp/sp-usb-iso
  ISO=$(find -L /tmp/sp-usb-iso -name '*.iso' 2>/dev/null | head -1)
fi
[ -n "$ISO" ] && [ -f "$ISO" ] || { echo "no ISO found ('$ISO') — set ISO=<path> or ISO_FLAKE=<flake#attr>"; exit 1; }
echo "   ISO: $ISO"

echo "Block devices (pick the USB — NOT your system disk):"
lsblk -dpno NAME,SIZE,MODEL,TRAN 2>/dev/null | sed 's/^/   /'
: "${USB_DEV:?set USB_DEV=/dev/sdX — the USB device to WRITE (this ERASES it); then re-run.}"
[ -b "$USB_DEV" ] || { echo "USB_DEV '$USB_DEV' is not a block device — is the USB inserted? aborting."; exit 1; }
if [ "$(lsblk -no NAME "$USB_DEV" 2>/dev/null | tail -n +2 | wc -l)" -gt 0 ]; then
  echo "   note: $USB_DEV already has partitions (they will be erased)."
  [ "${EMPTY_REQUIRED:-0}" = 1 ] && { echo "   EMPTY_REQUIRED=1 and the USB is not empty — aborting."; exit 1; }
fi
echo "About to ERASE ${USB_DEV} and write ${ISO}."
read -r -p "Re-type the device path to confirm: " _c || true
[ "${_c:-}" = "$USB_DEV" ] || { echo "confirmation mismatch — aborting."; exit 1; }
sudo dd if="$ISO" of="$USB_DEV" bs=4M status=progress conv=fsync
sync
say "   done — you may REMOVE the USB from this device."

say "2. install on the TARGET"
echo ">>> Put the USB into the TARGET, boot from it, install SelfPrivacy, and connect it to the network."
read -r -p "Did you install it on the target and is it on the network? Press ENTER to continue (Ctrl-C to abort) ... " _ || true

say "3. locate the installed target"
up=""
for i in $(seq 1 60); do ssh_ok "$IP" && { up=1; echo "up at root@$IP"; break; }; sleep 5; done
if [ -z "$up" ]; then
  echo "   not at $IP — scanning the LAN by MAC $MAC ..."
  for p in $(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | awk -F/ '{print $1}' \
             | awk -F. '/^10\.|^192\.168\.|^172\./{print $1"."$2"."$3}' | sort -u); do
    for n in $(seq 1 254); do ping -c1 -W1 "$p.$n" >/dev/null 2>&1 & done
  done; wait 2>/dev/null || true
  DIP=$(ip neigh | awk -v m="$MAC" 'tolower($0) ~ tolower(m){print $1; exit}')
  if [ -n "$DIP" ] && ssh_ok "$DIP"; then IP="$DIP"; up=1; echo "   found at root@$IP"; fi
fi
[ -n "$up" ] || { echo "target not reachable — is it installed and on the network?"; exit 1; }

say "4. stamp the box with its build identity"
printf '%s' "$(stamp_json)" | ssh $SSHO "root@$IP" "cat > /etc/dev-test-build.json"
# Record the running-system BASELINE so a later run can detect a box rebuilt/edited since install.
ssh $SSHO "root@$IP" 'python3 - <<PY
import json, subprocess
d = json.load(open("/etc/dev-test-build.json"))
d["system"] = subprocess.check_output(["readlink","-f","/run/current-system"]).decode().strip()
try: d["nixos_version"] = subprocess.check_output(["nixos-version"]).decode().strip()
except Exception: pass
json.dump(d, open("/etc/dev-test-build.json","w"))
PY' || echo "   (warning: could not record running-system baseline)"
echo "   stamped."

say "5. VERIFY over transport=$TRANSPORT"
if [ "$TRANSPORT" = none ]; then
  echo "   TRANSPORT=none — install-only; skipping the live service verify."
  exit 0
fi
TOKEN=$(ssh $SSHO "root@$IP" 'jq -r .api.token /etc/selfprivacy/secrets.json' 2>/dev/null)
if [ "$TRANSPORT" = onion ]; then
  ONION=$(ssh $SSHO "root@$IP" 'cat /var/lib/tor/hidden_service/hostname 2>/dev/null')
  python3 "$HERE/verify_install_native_ethernet.py" --transport onion --onion "$ONION" --token "$TOKEN"
else
  python3 "$HERE/verify_install_native_ethernet.py" --transport https --domain "$DOMAIN" --token "$TOKEN" --ssh-key "$KEY"
fi
