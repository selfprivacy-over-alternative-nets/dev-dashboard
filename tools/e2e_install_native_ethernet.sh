#!/usr/bin/env bash
# END-TO-END integration test for catalog test case: install.native-ethernet
#
#   ONE command:  WIPE the target's disks -> INSTALL native NixOS + SelfPrivacy over the
#   LAN (nixos-anywhere from this device) -> VERIFY it comes up validly over the LAN.
#
# Precondition ("boot the target in network mode"): the target is powered on and reachable
# over the LAN via SSH with the deploy key — either its already-installed NixOS (nixos-anywhere
# kexecs into an in-RAM installer) or a booted NixOS installer. Nothing else is needed.
#
# What gets injected into the fresh install (so it comes up "validly" = publicly trusted, same
# identity) via nixos-anywhere --extra-files:
#   - /etc/ssl/selfprivacy-le/{fullchain,key}.pem   (the real Let's Encrypt cert -> trusted TLS)
#   - /etc/selfprivacy/secrets.json                 (keeps the API token stable across re-installs)
# The .onion regenerates on each wipe; the verifier reads the fresh value from the box.
# Public DNS A records (api/cloud/... -> LAN IP) live at the DNS host, so they survive the wipe.
set -euo pipefail

# All user-facing args are REQUIRED (no implicit defaults): the written command is the
# whole truth on any network/device. Omitting one fails fast telling you what to set.
FLAKE=${FLAKE:?required: path to deploy flake, e.g. FLAKE=/home/a/git/personal/selfprivacy/selfprivacy-altnet-deployer}
IP=${IP:?required: target IP, e.g. IP=192.168.100.50 (lan-setup-0 direct-cable installer) or IP=192.168.1.167 (via router R)}
MAC=${MAC:?required: target NIC MAC for LAN discovery, e.g. MAC=d8:cb:8a:7c:0a:f4}
KEY=${KEY:?required: ssh deploy key path, e.g. KEY=$HOME/.ssh/pcname_ed25519}
DOMAIN=${DOMAIN:?required: public domain, e.g. DOMAIN=weersurf.nl}
NETBOOT=${NETBOOT:?required: auto (start the direct-cable netboot server) or off}
TRANSPORT=${TRANSPORT:?required: https (public, from anywhere) | onion | none (install-only, skip live verify)}
EXTRA=${EXTRA:-$FLAKE/state/extra}             # derived from FLAKE (override only if non-standard)
NETBOOT_SCRIPT=${NETBOOT_SCRIPT:-$HOME/netboot/start-netboot-server.sh}  # internal
WAIT_TARGET_S=${WAIT_TARGET_S:-}               # internal timeout (default set below per NETBOOT)
HERE="$(cd "$(dirname "$0")" && pwd)"
SSHO="-i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=6"
export NIX_CONFIG='experimental-features = nix-command flakes'
say(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ssh_ok(){ ssh $SSHO -o BatchMode=yes "root@$1" true 2>/dev/null; }

# The box build-identity JSON to stamp onto the target. Prefers the FULL identity dash passes
# via $DEV_TEST_STAMP (repos/branches/commits + dirtiness + pins); falls back to reading
# $FLAKE/flake.lock when run standalone. Surfaces api/nixpkgs at top level for verify-box.
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

# Setup-availability preflight for wifi setups (lan-setup-0b/0c/0d): a wifi spec must be given,
# and we confirm the SSID is in range WITHOUT disturbing the current connection (scan only).
# Internet-through-that-wifi can't be verified without connecting, so we don't.
wifi_preflight(){
  [ -n "${WIFI_SSID:-}" ] || return 0   # no wifi spec → non-wifi setup, nothing to check
  if command -v nmcli >/dev/null 2>&1; then
    if nmcli -t -f SSID dev wifi list 2>/dev/null | grep -qxF "$WIFI_SSID"; then
      echo "   wifi '$WIFI_SSID' is in range ✓ (internet via it not verified — that needs connecting)"
    else
      echo "   ⚠ wifi '$WIFI_SSID' is NOT visible in a scan — the target likely can't use it. Aborting."
      return 1
    fi
  else
    echo "   (nmcli unavailable — cannot scan for wifi '$WIFI_SSID'; skipping check)"
  fi
}

# Scan the LAN(s) this laptop is on for the target's NIC MAC and echo its IP ("" if not found).
# Populates the neighbour table with a backgrounded ping sweep over each connected RFC1918 /24
# (plus the direct-cable netboot subnet 192.168.100.0/24), then matches MAC in `ip neigh`.
discover_by_mac(){
  local mac="$1" prefixes p i
  prefixes=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' \
    | while IFS= read -r cidr; do echo "${cidr%/*}"; done \
    | awk -F. '/^10\./ || /^192\.168\./ || ($1=="172" && $2>=16 && $2<=31){print $1"."$2"."$3}' | sort -u)
  prefixes=$(printf '%s\n192.168.100\n' "$prefixes" | sort -u)
  echo "   scanning for MAC $mac on:$(printf ' %s.0/24' $prefixes)" >&2
  for p in $prefixes; do
    for i in $(seq 1 254); do ping -c1 -W1 "$p.$i" >/dev/null 2>&1 & done
  done
  wait 2>/dev/null || true
  ip neigh | awk -v m="$mac" 'tolower($0) ~ tolower(m){print $1; exit}'
}

# Make $IP point at a reachable target: if it isn't reachable, find the box by MAC and adopt it.
# Mutates the global IP. Returns 0 on success, 1 if the box can't be found on the LAN.
ensure_target(){
  if ssh_ok "$IP"; then echo "target root@$IP reachable"; return 0; fi
  echo "target not at root@$IP — scanning the LAN for the box by MAC $MAC ..."
  local dip; dip=$(discover_by_mac "$MAC")
  if [ -n "$dip" ] && ssh_ok "$dip"; then
    echo "found the target at root@$dip (was $IP) — adopting"; IP="$dip"; return 0
  fi
  return 1
}

NETBOOT_STARTED=""; SUDO_KEEPALIVE=""
stop_netboot(){
  [ -n "$SUDO_KEEPALIVE" ] && kill "$SUDO_KEEPALIVE" 2>/dev/null || true; SUDO_KEEPALIVE=""
  [ -n "$NETBOOT_STARTED" ] || return 0
  echo "stopping the netboot server we started ..."
  sudo pkill -x dnsmasq 2>/dev/null || true
  sudo pkill -f "http\.server 8080" 2>/dev/null || true
  NETBOOT_STARTED=""
}
# (re)start the direct-cable netboot server ourselves so the whole install is ONE command.
# Idempotent: reuses an already-running server. Needs sudo (prompted once; kept warm so the
# EXIT-time cleanup doesn't re-prompt during a long install).
start_netboot(){
  if ss -lun 2>/dev/null | grep -q ':67 '; then echo "netboot server already running — reusing it"; return 0; fi
  [ -f "$NETBOOT_SCRIPT" ] || { echo "netboot script not found: $NETBOOT_SCRIPT"; return 1; }
  echo "starting the direct-cable netboot server (sudo — you'll be prompted once) ..."
  sudo -v || { echo "sudo needed to start the netboot server"; return 1; }
  ( while true; do sudo -n true 2>/dev/null || break; sleep 50; done ) & SUDO_KEEPALIVE=$!
  sudo bash "$NETBOOT_SCRIPT" >/tmp/netboot-server.log 2>&1 &
  NETBOOT_STARTED=1
  trap 'stop_netboot' EXIT INT TERM
  local i; for i in $(seq 1 20); do ss -lun 2>/dev/null | grep -q ':67 ' && break; sleep 0.5; done
  if ss -lun 2>/dev/null | grep -q ':67 '; then
    echo "netboot server up (DHCP+TFTP on the direct link; log: /tmp/netboot-server.log)"
  else
    echo "netboot server did not come up — see /tmp/netboot-server.log"; return 1
  fi
}

# Verify the TARGET can reach the internet before a live service verify. Checks from the box
# itself; if it can't (and we're interactive) it asks the user to fix it, then re-checks.
ensure_internet(){
  say "internet check — the target must reach the internet for the live service verify"
  while :; do
    if ssh_ok "$IP" && ssh $SSHO "root@$IP" 'curl -sf --max-time 10 https://api.ipify.org >/dev/null 2>&1 || ping -c1 -W2 1.1.1.1 >/dev/null 2>&1'; then
      echo "   target root@$IP has internet access ✓"; return 0
    fi
    echo "   target root@$IP has NO internet access."
    [ -t 0 ] || return 1
    echo "   >> Ensure the target device has internet access (uplink/router reachable), then press ENTER to re-check (Ctrl-C to abort)."
    read _ans || return 1
    ensure_target >/dev/null 2>&1 || true   # its IP may have changed
  done
}

if [ "$NETBOOT" = auto ]; then
  say "0a. bring up the direct-cable netboot server (one-command mode)"
  start_netboot || exit 1
  echo ">>> now POWER ON / RESET the target into UEFI IPv4 network boot — waiting for it to appear <<<"
  : "${WAIT_TARGET_S:=300}"
else
  : "${WAIT_TARGET_S:=20}"
fi

say "0. preflight — wifi spec (if any) + target reachable over LAN (network mode)?"
wifi_preflight || exit 1
_deadline=$((SECONDS + WAIT_TARGET_S)); _t0=$SECONDS
until ssh_ok "$IP" || [ $SECONDS -ge $_deadline ]; do
  echo "   ... waiting for target at root@$IP (or MAC $MAC on the LAN) — $((SECONDS-_t0))s/${WAIT_TARGET_S}s  (Ctrl-C to abort)"
  sleep 8
done
if ! ensure_target; then
  echo "target not reachable at root@$IP and not found on the LAN by MAC $MAC (waited ${WAIT_TARGET_S}s)."
  echo "  - boot it in network mode (installer or installed NixOS, sshd up, on the LAN), or"
  echo "  - pass the right IP:   IP=<addr> $0    (or  ./dash run <install-id> --ip <addr>), or"
  echo "  - check MAC=$MAC matches the target's NIC."
  exit 1
fi

# Auto-retarget: if the deploy flake's disko disks don't exist on THIS target, adapt disko.nix (+ the
# netboot MAC pin) to the target's REAL hardware before installing, so a different device "just works".
# You confirm which disk gets WIPED here — UP FRONT, before the long install. Runs only on a mismatch.
disko_matches(){
  local dev devs
  devs=$(grep -oE '/dev/disk/by-id/[^"]+' "$FLAKE/disko.nix" 2>/dev/null | sort -u)
  [ -n "$devs" ] || return 0        # nothing by-id to check
  for dev in $devs; do
    ssh $SSHO -o BatchMode=yes "root@$IP" "test -e '$dev'" 2>/dev/null || return 1
  done
  return 0
}
if ! disko_matches; then
  say "0b. RETARGET — this target's disks don't match the flake; adapting disko.nix (confirm the wipe)"
  if [ -f "$HERE/retarget_device.sh" ]; then
    TARGET_IP="$IP" KEY="$KEY" DISKO="$FLAKE/disko.nix" bash "$HERE/retarget_device.sh" \
      || { echo "!! retarget aborted — not installing."; exit 1; }
    disko_matches || { echo "!! disko still doesn't match the target after retarget — check the disks."; exit 1; }
  else
    echo "!! disko.nix targets disks not on this device and $HERE/retarget_device.sh is missing —"
    echo "   fix disko.nix for this target's disks, then re-run."; exit 1
  fi
fi

[ -f "$EXTRA/etc/ssl/selfprivacy-le/fullchain.pem" ] || { echo "missing LE cert in $EXTRA — run the staging step first"; exit 1; }

# Wifi (setups …-0b/0c/0d): inject a NetworkManager connection so the box joins wifi after install.
# The PSK lives ONLY in $FLAKE/state (git-ignored + excluded from the mirror) and on the target —
# NEVER committed. Pass it once with --env WIFI_PSK=<pass> (saved for reuse); thereafter WIFI_SSID is
# enough. The connection file is written into the --extra-files tree at 0600.
if [ -n "${WIFI_SSID:-}" ]; then
  WIFI_DIR="$FLAKE/state/wifi"; mkdir -p "$WIFI_DIR"; chmod 700 "$WIFI_DIR"
  PSK_FILE="$WIFI_DIR/$WIFI_SSID.psk"
  if [ -n "${WIFI_PSK:-}" ]; then printf '%s' "$WIFI_PSK" > "$PSK_FILE"; chmod 600 "$PSK_FILE"; fi
  [ -s "$PSK_FILE" ] || { echo "!! no wifi PSK for '$WIFI_SSID' — pass it once: --env WIFI_PSK=<pass> (saved to $PSK_FILE, git-ignored, never committed)"; exit 1; }
  NMDIR="$EXTRA/etc/NetworkManager/system-connections"; mkdir -p "$NMDIR"
  CONN="$NMDIR/$WIFI_SSID.nmconnection"
  { printf '[connection]\nid=%s\ntype=wifi\nautoconnect=true\n' "$WIFI_SSID"
    printf '[wifi]\nmode=infrastructure\nssid=%s\n' "$WIFI_SSID"
    printf '[wifi-security]\nkey-mgmt=wpa-psk\npsk=%s\n' "$(cat "$PSK_FILE")"
    printf '[ipv4]\nmethod=auto\n[ipv6]\nmethod=auto\n'; } > "$CONN"
  chmod 600 "$CONN"
  echo "wifi: injected NetworkManager connection for '$WIFI_SSID' (PSK from $PSK_FILE; 0600; not committed)"
fi

# Direct-cable (NETBOOT=auto): install WITHOUT rebooting. Network boot is first in the
# target's boot order and our netboot server is still up, so a reboot now would PXE
# straight back into the installer instead of the freshly-installed disk (and the disk
# would have no DHCP on this cable anyway). We verify on disk and hand off instead.
NA_MAIN=""; NA_FALLBACK="--phases disko,install,reboot"
if [ "$NETBOOT" = auto ]; then NA_MAIN="--phases disko,install"; NA_FALLBACK="--phases disko,install"; fi

say "1. WIPE + INSTALL (nixos-anywhere, both disks by serial, inject cert+secrets)"
if ! nix run github:nix-community/nixos-anywhere -- \
      --flake "$FLAKE#box" --target-host "root@$IP" -i "$KEY" --extra-files "$EXTRA" $NA_MAIN; then
  echo "!! nixos-anywhere could not reconnect at $IP (kexec installer took a different DHCP lease)."
  echo "   Discovering the box by MAC $MAC and resuming ..."
  DIP=$(discover_by_mac "$MAC")
  [ -n "$DIP" ] || { echo "could not locate the box by MAC — aborting"; exit 1; }
  echo "   installer found at $DIP — resuming"
  nix run github:nix-community/nixos-anywhere -- \
    --flake "$FLAKE#box" --target-host "root@$DIP" -i "$KEY" --extra-files "$EXTRA" \
    $NA_FALLBACK
fi

# Verify the install ON DISK (works with no reboot / no internet). After --phases disko,install
# the new root is left MOUNTED (disko's /mnt); a rebooted/fresh installer leaves it unmounted.
# Handle both: check mounted ext4 filesystems first, then mount unmounted ext4 partitions RO.
ondisk_verify(){
  ssh $SSHO "root@$IP" '
    check(){ [ -f "$1/etc/selfprivacy/secrets.json" ] && [ -L "$1/nix/var/nix/profiles/system" ]; }
    report(){ printf "root=%s secrets=yes " "$1"; [ -f "$1/etc/ssl/selfprivacy-le/fullchain.pem" ] && printf "le=yes" || printf "le=no"; echo " OK"; }
    for mp in $(findmnt -rno TARGET -t ext4 2>/dev/null); do check "$mp" && { report "$mp"; exit 0; }; done
    mkdir -p /mnt/t
    for part in $(lsblk -lnpo NAME,FSTYPE,MOUNTPOINT | awk "\$2==\"ext4\" && \$3==\"\"{print \$1}"); do
      mount -o ro "$part" /mnt/t 2>/dev/null || continue
      if check /mnt/t; then report "$part"; umount /mnt/t 2>/dev/null || true; exit 0; fi
      umount /mnt/t 2>/dev/null || true
    done
    echo NO-INSTALLED-ROOT-FOUND
  ' 2>/dev/null || echo NO-INSTALLED-ROOT-FOUND
}

# Post-install next steps: find the box's IP, the DNS records to add, and the integration test.
print_next_steps(){
  local BOLD=$'\033[1m' OFF=$'\033[0m' tok sub
  tok=$(python3 -c "import json;print(json.load(open('$EXTRA/etc/selfprivacy/secrets.json'))['api']['token'])" 2>/dev/null || echo "<box-api-token>")
  say "NEXT STEPS"
  echo "① Find the box's IP + confirm it's online — run this ON THE BOX (its own keyboard/screen),"
  if [ -n "${WIFI_SSID:-}" ]; then
    echo "   after you reboot it so it boots from disk and joins wifi '${WIFI_SSID}'"
    echo "   (this laptop can't see it — the box is on a different radio/MAC/network):"
  else
    echo "   after you cable it to your router and reboot it"
    echo "   (or from this laptop:  ./dash find-target  once it's on this LAN):"
  fi
  echo "   log in at the box's console as  ${BOLD}root${OFF}  password  ${BOLD}tijdelijkwachtwoord${OFF}  then run:"
  echo "     ${BOLD}ping -c1 1.1.1.1 && hostname -I && curl -s https://api.ipify.org; echo${OFF}"
  echo "   → 'bytes from…' = ONLINE; then the box's LAN IP (192.168.x.x — home access)"
  echo "     and the public IP (the last line — public access, needs :443 forwarded on the router)."
  echo
  echo "② Add these 5 DNS A-records at your DNS host, pointing at <box-ip>:"
  for sub in api cloud git matrix meet; do printf "     A   %-28s <box-ip>\n" "$sub.$DOMAIN"; done
  echo "   <box-ip> = the box's LAN IP (home access) OR your router's PUBLIC IP (public access + forward :443)."
  echo
  echo "③ Integration-test the whole stack (once <box-ip> is reachable and the name resolves):"
  echo "     ${BOLD}./dash run L3.connect.desktop --net https --on ${SP_SETUP:-lan-setup-0a} \\${OFF}"
  echo "     ${BOLD}  --ip <box-ip> --key ${KEY/#$HOME/\~} --token ${tok}${OFF}"
  echo "   (no public DNS yet? use  --net tor  against the box's .onion instead.)"
}

if [ "$NETBOOT" = auto ]; then
  say "2. verify the install ON DISK (from the still-running installer — no reboot/internet needed)"
  ondisk=$(ondisk_verify)
  echo "   on-disk: $ondisk"
  stop_netboot
  echo "$ondisk" | grep -q OK || { echo "!! no installed root with secrets.json found on disk — install may have failed"; exit 1; }
  say "install.native-ethernet [${SP_SETUP:-lan-setup-0}]: INSTALL VERIFIED ON DISK"

  # Install-only when non-interactive or explicitly requested (TRANSPORT=none): hand off and stop.
  if [ ! -t 0 ] || [ "$TRANSPORT" = none ]; then
    cat <<EOM
The install is complete; the injected identity (secrets.json + LE cert) is on disk.
A live/service verify needs the box on a network WITH INTERNET (a direct cable has none):
  1) Move the target to router R (or set its BIOS boot order to the internal disk).
  2) Reboot it — the netboot server is stopped, so it boots from disk and joins the LAN.
  3) Re-run this (interactively) with the box online, or run the verifier directly.
EOM
    print_next_steps
    exit 0
  fi

  # Continue to the live verify. The box is still running the in-RAM INSTALLER (we didn't
  # reboot, to avoid the PXE loop). Ask the user to put it on an internet network, then reboot
  # it OURSELVES so it boots from disk into the installed system (no manual reboot needed).
  say "2b. bring the target ONLINE for the live service verify"
  echo "Connect the target to a network WITH INTERNET (e.g. router R) — it's currently running"
  echo "the in-RAM installer; I'll reboot it into the installed disk once it's on that network."
  echo ">> Press ENTER when it's cabled to that network (or Ctrl-C to finish at install-only)."
  read _ans || { echo "(no input — finishing at install-only)"; exit 0; }

  # find_installed: scan by MAC until we see the INSTALLED system (secrets.json on the live fs).
  # echoes the IP, or "" on timeout. $1 = timeout seconds, $2 = label.
  find_installed(){
    local dl=$(( SECONDS + $1 )) dip
    while [ $SECONDS -lt $dl ]; do
      dip=$(discover_by_mac "$MAC")
      if [ -n "$dip" ] && ssh_ok "$dip" && ssh $SSHO "root@$dip" 'test -f /etc/selfprivacy/secrets.json' 2>/dev/null; then
        echo "$dip"; return 0
      fi
      echo "   ... $2 — waiting" >&2; sleep 10
    done
    return 1
  }

  # Locate the box by MAC (installer or, if you already rebooted, the installed system).
  say "   locating the target on the LAN (by MAC $MAC) ..."
  BIP=""; _dl=$((SECONDS+180))
  while [ $SECONDS -lt $_dl ]; do
    _dip=$(discover_by_mac "$MAC")
    if [ -n "$_dip" ] && ssh_ok "$_dip"; then BIP="$_dip"; break; fi
    echo "   ... not found yet — waiting"; sleep 10
  done
  [ -n "$BIP" ] || { echo "couldn't find the target on the LAN by MAC $MAC — is it cabled to the router and powered on?"; exit 1; }

  if ssh $SSHO "root@$BIP" 'test -f /etc/selfprivacy/secrets.json' 2>/dev/null; then
    IP="$BIP"; echo "   already the installed system at root@$IP"
  else
    echo "   target at root@$BIP is still the INSTALLER — rebooting it to boot the installed disk ..."
    ssh $SSHO "root@$BIP" 'systemctl reboot || reboot' 2>/dev/null || true
    sleep 20
    say "   waiting for the INSTALLED system to boot from disk (by MAC $MAC) ..."
    IP=$(find_installed 300 "not up yet (booting from disk)") || {
      echo "installed system didn't come up from disk within 5m — check the target booted the disk (not PXE) and reached the network"; exit 1; }
    echo "   installed system up at root@$IP"
  fi
else
  say "2. wait for reboot into the installed system at static $IP"
  up=""
  for i in $(seq 1 48); do
    if ssh_ok "$IP"; then up=1; echo "up after ~$((i*5))s"; break; fi
    sleep 5
  done
  if [ -z "$up" ]; then
    echo "box not back at $IP within timeout — scanning the LAN for it by MAC $MAC ..."
    DIP=$(discover_by_mac "$MAC")
    if [ -n "$DIP" ] && ssh_ok "$DIP"; then echo "found at root@$DIP — adopting"; IP="$DIP"; up=1; fi
  fi
  [ -n "$up" ] || { echo "box did not come back on the LAN within timeout"; exit 1; }
fi

say "3. post-install — tighten LE key perms, ensure nginx serving"
ssh $SSHO "root@$IP" '
  chown root:nginx /etc/ssl/selfprivacy-le/key.pem 2>/dev/null || true
  chmod 640 /etc/ssl/selfprivacy-le/key.pem 2>/dev/null || true
  systemctl reload nginx 2>/dev/null || systemctl restart nginx || true
  sleep 2'

say "3b. stamp the box with its FULL build identity (so later runs can check box-vs-code)"
STAMP=$(stamp_json)
printf '%s' "$STAMP" | ssh $SSHO "root@$IP" "cat > /etc/dev-test-build.json"
# Record the running-system BASELINE into the stamp (readlink on the box, post-switch) so a later
# run can detect a box nixos-rebuilt/hand-edited since install — the stamp alone is only a claim.
ssh $SSHO "root@$IP" 'python3 - <<PY
import json, subprocess
d = json.load(open("/etc/dev-test-build.json"))
d["system"] = subprocess.check_output(["readlink","-f","/run/current-system"]).decode().strip()
try: d["nixos_version"] = subprocess.check_output(["nixos-version"]).decode().strip()
except Exception: pass
json.dump(d, open("/etc/dev-test-build.json","w"))
PY' || echo "   (warning: could not record running-system baseline in the stamp)"
echo "   stamped: $(printf '%s' "$STAMP" | python3 -c "import sys,json;d=json.load(sys.stdin);print('state_hash='+str(d.get('state_hash','?'))+' pins='+str(d.get('pins',{})))" 2>/dev/null || echo written)"

say "4. read freshly-deployed identity from the target"
TOKEN=$(ssh $SSHO "root@$IP" 'jq -r .api.token /etc/selfprivacy/secrets.json')
ONION=$(ssh $SSHO "root@$IP" 'cat /var/lib/tor/hidden_service/hostname 2>/dev/null || true')
echo "token=<${#TOKEN} chars>  onion=${ONION:-<none>}"

say "4b. record deployment credentials in a KeePassXC DB (git-ignored under state/)"
# Non-fatal: a failed/absent DB must never block the deploy or verify.
if command -v keepassxc-cli >/dev/null 2>&1; then
  DOMAIN="$DOMAIN" IP="$IP" KEY="$KEY" TOKEN="$TOKEN" ONION="$ONION" \
  ROOT_USER=root ROOT_PW="${ROOT_PW:-}" HOST="${HOST:-pcname}" \
  OUT="${KEEPASS_OUT:-$FLAKE/state/keepass/${HOST:-pcname}.kdbx}" \
    "$HERE/make_keepass_db.sh" || echo "   (KeePassXC DB generation failed — non-fatal; set SP_KEEPASS_PASSWORD)"
else
  echo "   keepassxc-cli not installed — skipping (install it to capture credentials)."
fi

# TRANSPORT is required + validated at the top.
ensure_internet || { echo "!! target has no internet access — cannot run the live $TRANSPORT verify"; exit 1; }
say "5. VERIFY over transport=$TRANSPORT"
# Public https also needs (box/router side): api.$DOMAIN -> the box's PUBLIC IP, and :443
# reachable from the internet (public IP or router port-forward). The verifier enforces this.
echo "   box's public (WAN) IP as seen from itself: $(ssh $SSHO "root@$IP" 'curl -s --max-time 10 https://api.ipify.org || echo unknown' 2>/dev/null)"
# Not `exec`: let the script reach its EXIT trap so an auto-started netboot server is stopped.
# With `set -e`, a failing verify still exits non-zero (and fires the trap).
if [ "$TRANSPORT" = onion ]; then
  python3 "$HERE/verify_install_native_ethernet.py" --transport onion --onion "$ONION" --token "$TOKEN"
else
  python3 "$HERE/verify_install_native_ethernet.py" --transport https --domain "$DOMAIN" --token "$TOKEN" --ssh-key "$KEY"
fi

# The box is live and its real IP/token are known — print the DNS records with the IP filled in,
# plus the ready-to-run L3 integration test (the full app-vs-backend "whole shebang").
B=$'\033[1m'; N=$'\033[0m'
say "NEXT STEPS"
echo "Add these 5 DNS A-records at your DNS host (home: box LAN IP $IP; public: your router's WAN IP + forward :443):"
for sub in api cloud git matrix meet; do printf "     A   %-28s %s\n" "$sub.$DOMAIN" "$IP"; done
echo
echo "Integration-test the whole stack (app driven against this backend):"
echo "     ${B}./dash run L3.connect.desktop --net $TRANSPORT --on ${SP_SETUP:-lan-setup-0a} \\${N}"
echo "     ${B}  --ip $IP --key ${KEY/#$HOME/\~} --token $TOKEN${N}"
[ -n "${ONION:-}" ] && echo "   (or --net tor against the box's .onion: $ONION)"
