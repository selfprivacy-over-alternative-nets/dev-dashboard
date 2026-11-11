#!/usr/bin/env bash
# ONE-CHAIN usb install+verify for catalog test case: install.usb
#
#   prepare a bootable installer USB on THIS device  ->  you boot+install it on the TARGET
#   ->  stamp the box with its build identity  ->  verify.  No separate steps; one chain.
#
# What the user gives (req 190): the stick, the domain and the transport — `./dash run install --to-usb <path> --domain <name>`
# derives the rest, prints every value and records the whole line. Nothing is guessed, nothing comes from this computer's checkouts:
#   USB_DEV    the stick's block device (dash shows it with the other removable drives and has it confirmed by name; ERASED)
#   DOMAIN     the server's public name (checked: syntax, and a DuckDNS name must exist)     TRANSPORT  https | onion | none
#   KEY        this install's FRESH key pair (dash makes it); its public half goes INTO the installer image (/sp/authorized_keys),
#              so the live installer and the installed server trust that key and nothing else over SSH
#   ISO_FLAKE  the installer image, built/fetched from the PUBLIC repo (reproducible from any device)
#   FLAKE      what the box is stamped with: that flake's lock, read from git (nix flake metadata) — no deployer checkout needed
#   IP / MAC   discovered after you boot the box: it is the one host on the LAN that accepts this install's key (IP may be given)
# A required value that is missing fails fast telling you what to set. Runs directly too (same env, no dash).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/install_lib.sh"
. "$HERE/prompt_lib.sh"

DOMAIN=${DOMAIN:?required: the public domain of the server, e.g. DOMAIN=yourname.duckdns.org (dash: --domain)}
TRANSPORT=${TRANSPORT:?required: https | onion | none (install-only); dash derives https from --domain}
KEY=${KEY:?required: the ssh key of THIS install, e.g. KEY=~/.ssh/selfprivacy-<domain>-<date>_ed25519 (dash makes a fresh one)}
USB_DEV=${USB_DEV:?required: the block device of the stick to WRITE (ERASED), e.g. USB_DEV=/dev/sdb (dash: --to-usb <path> shows + confirms it)}
KEY=${KEY/#\~/$HOME}
PUBKEY=${PUBKEY:-$KEY.pub}
ISO_FLAKE=${ISO_FLAKE:-github:selfprivacy-over-tor/Manager-Ubuntu-SelfPrivacy-Over-Tor?dir=backend#packages.x86_64-linux.default}
FLAKE=${FLAKE:-${ISO_FLAKE%%#*}}                       # the stamp's pins: the image's own flake, from git
ISO=${ISO:-}                                           # a prebuilt installer .iso; else built/fetched from ISO_FLAKE
IP=${IP:-}; MAC=${MAC:-}                               # optional: IP is tried first; else the box is discovered by the key
USB_CONFIRMED=${USB_CONFIRMED:-}                       # = USB_DEV when dash already showed the drive and had it confirmed
CACHE=${SP_CACHE:-$HOME/.cache/selfprivacy-usb}        # images live on disk, not in /tmp (RAM)
SSHO="-i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=6"   # IdentitiesOnly: the box trusts THIS key only; an agent offering other keys first gets cut off (MaxAuthTries)
export NIX_CONFIG='experimental-features = nix-command flakes'
say(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ssh_ok(){ ssh $SSHO -o BatchMode=yes "root@$1" true 2>/dev/null; }

echo "ran as (every value written out):"
echo "  DOMAIN=$DOMAIN TRANSPORT=$TRANSPORT KEY=$KEY USB_DEV=$USB_DEV ISO_FLAKE=$ISO_FLAKE FLAKE=$FLAKE${IP:+ IP=$IP}${MAC:+ MAC=$MAC}${WIFI_SSID:+ WIFI_SSID=$WIFI_SSID} bash tools/e2e_install_usb.sh"
[ -f "$KEY" ] && [ -f "$PUBKEY" ] || { echo "KEY=$KEY needs its public half at $PUBKEY (dash makes both: ./dash run install --to-usb … --domain …)"; exit 1; }
is_domain "$DOMAIN" || { echo "DOMAIN='$DOMAIN' is not a domain name (like yourname.duckdns.org or example.org)"; exit 1; }
if getent hosts "$DOMAIN" >/dev/null 2>&1; then echo "   $DOMAIN exists in DNS ✓"
elif [[ "${DOMAIN,,}" == *.duckdns.org ]]; then echo "   $DOMAIN is unknown to DNS — claim the name at duckdns.org first, or check the spelling"; exit 1
else echo "   warning: $DOMAIN does not resolve yet — fine before its records are written, wrong if it is a typo"; fi

# Box build-identity JSON: dash's full $DEV_TEST_STAMP (repos, pins, state) when it runs the chain, else the flake's pins from git;
# always with the flake, its revision and the moment.
stamp_json(){
  local base; base=$(sp_pins_from_flake "$FLAKE")
  DEV_TEST_STAMP="${DEV_TEST_STAMP:-}" BASE="$base" python3 - <<'PY'
import os, json, datetime
b = json.loads(os.environ["BASE"])
d = json.loads(os.environ["DEV_TEST_STAMP"]) if os.environ.get("DEV_TEST_STAMP") else {"pins": b["pins"]}
d["flake"] = b["flake"]; d["flake_revision"] = b.get("revision", ""); d.setdefault("pins", b["pins"])
d["deployed_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
for k, v in (d.get("pins") or {}).items():
    d.setdefault(k, v)
print(json.dumps(d))
PY
}

# wifi setups (usb-0d/0c) need a wifi spec; confirm the SSID is in range without disturbing the
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
[ -b "$USB_DEV" ] || { echo "USB_DEV '$USB_DEV' is not a block device — is the stick plugged in? aborting."; exit 1; }

say "1. the installer image, from the public repo, with this install's key"
mkdir -p "$CACHE"
if [ -z "$ISO" ]; then
  echo "   building/fetching the installer image from $ISO_FLAKE (nix build) ..."
  nix build -L "$ISO_FLAKE" --out-link "$CACHE/iso"
  ISO=$(find -L "$CACHE/iso" -name '*.iso' 2>/dev/null | head -1)
fi
[ -n "$ISO" ] && [ -f "$ISO" ] || { echo "no ISO found ('$ISO') — set ISO=<path> or ISO_FLAKE=<flake#attr>"; exit 1; }
echo "   image: $ISO"
ISO_KEYED="$CACHE/installer-with-key.iso"
sp_remaster_iso "$ISO" "$PUBKEY" "$ISO_KEYED" || exit 1

say "2. write the stick (ERASED): $USB_DEV"
if [ "$USB_CONFIRMED" = "$USB_DEV" ]; then
  echo "   (confirmed by name on the command line: dash showed this drive with the other removable drives)"
else
  echo "Block devices (the stick — NOT your system disk):"
  lsblk -dpno NAME,SIZE,MODEL,TRAN 2>/dev/null | sed 's/^/   /'
  echo "About to ERASE ${USB_DEV} and write ${ISO_KEYED}."
  # Rule (req 142): a mismatched device path RE-ASKS (a typo shouldn't drop the whole flow); empty = abort
  # (this is a destructive erase, so proceeding still requires an EXACT match to $USB_DEV).
  while :; do
    read -r -p "Re-type the device path to confirm (empty = abort): " _c || _c=""
    [ -z "${_c:-}" ] && { echo "aborted — nothing erased."; exit 1; }
    [ "${_c}" = "$USB_DEV" ] && break
    echo "  that doesn't match ${USB_DEV} — try again, or press Enter to abort."
  done
fi
sp_unmount_all "$USB_DEV" || exit 1
${SP_SUDO-sudo} dd if="$ISO_KEYED" of="$USB_DEV" bs=4M status=progress conv=fsync
sync
sp_verify_written "$ISO_KEYED" "$USB_DEV" || exit 1
say "   done — you may REMOVE the USB from this device."

say "3. install on the TARGET"
cat <<EOT
>>> Put the USB into the TARGET and boot from it. The installer trusts only this install's key over SSH (no password login).
    On the target's screen, install SelfPrivacy; when you copy the config, copy the key next to it so the INSTALLED server
    trusts it too:
      cp -r /selfprivacy-config/* /mnt/etc/nixos/  &&  cp /iso/sp/authorized_keys /mnt/etc/nixos/authorized_keys
    Then reboot it with its cable into your router${WIFI_SSID:+ (or on wifi '$WIFI_SSID')}.
EOT
read -r -p "Did you install it on the target and is it on the network? Press ENTER to continue (Ctrl-C to abort) ... " _ || true

say "4. find the installed server on your network"
up=""
if [ -n "$IP" ]; then
  for i in $(seq 1 24); do ssh_ok "$IP" && { up=1; echo "   up at root@$IP"; break; }; sleep 5; done
fi
if [ -z "$up" ]; then
  echo "   looking for the one host that accepts this install's key (up to 15 min) ..."
  if hit=$(sp_discover_by_key "$KEY" 900); then
    IP=${hit%% *}; MAC=${hit##* }; up=1
    echo "   found your server at root@$IP (MAC $MAC)"
  fi
fi
[ -n "$up" ] || { echo "target not reachable — is it installed, booted and on the network? (its SSH accepts only $KEY)"; exit 1; }
[ -n "$MAC" ] || MAC=$(ip neigh 2>/dev/null | awk -v i="$IP" '$1==i && $4=="lladdr"{print $5; exit}')
echo "[dash-found] IP=$IP MAC=${MAC:-?}"

say "5. stamp the box with its build identity"
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

say "6. VERIFY over transport=$TRANSPORT"
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
