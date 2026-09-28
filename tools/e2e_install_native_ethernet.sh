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

FLAKE=${FLAKE:-/home/a/git/personal/selfprivacy/pcname-deploy}
IP=${IP:-192.168.1.167}                       # target's static LAN IP (final system)
MAC=${MAC:-d8:cb:8a:7c:0a:f4}                 # target NIC MAC (for kexec-IP-change fallback)
KEY=${KEY:-$HOME/.ssh/pcname_ed25519}
DOMAIN=${DOMAIN:-weersurf.nl}
EXTRA=${EXTRA:-$FLAKE/state/extra}
NETBOOT=${NETBOOT:-off}                        # auto = (re)start the direct-cable netboot server ourselves (one-command install)
NETBOOT_SCRIPT=${NETBOOT_SCRIPT:-$HOME/netboot/start-netboot-server.sh}
WAIT_TARGET_S=${WAIT_TARGET_S:-}              # seconds to wait for the target at step 0 (default set below per NETBOOT)
HERE="$(cd "$(dirname "$0")" && pwd)"
SSHO="-i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=6"
export NIX_CONFIG='experimental-features = nix-command flakes'
say(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ssh_ok(){ ssh $SSHO -o BatchMode=yes "root@$1" true 2>/dev/null; }

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

if [ "$NETBOOT" = auto ]; then
  say "0a. bring up the direct-cable netboot server (one-command mode)"
  start_netboot || exit 1
  echo ">>> now POWER ON / RESET the target into UEFI IPv4 network boot — waiting for it to appear <<<"
  : "${WAIT_TARGET_S:=300}"
else
  : "${WAIT_TARGET_S:=20}"
fi

say "0. preflight — target reachable over LAN (network mode)?"
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
[ -f "$EXTRA/etc/ssl/selfprivacy-le/fullchain.pem" ] || { echo "missing LE cert in $EXTRA — run the staging step first"; exit 1; }

# Direct-cable (NETBOOT=auto): install WITHOUT rebooting. Network boot is first in the
# target's boot order and our netboot server is still up, so a reboot now would PXE
# straight back into the installer instead of the freshly-installed disk (and the disk
# would have no DHCP on this cable anyway). We verify on disk and hand off instead.
NA_MAIN=""; NA_FALLBACK="--phases disko,install,reboot"
if [ "$NETBOOT" = auto ]; then NA_MAIN="--phases disko,install"; NA_FALLBACK="--phases disko,install"; fi

say "1. WIPE + INSTALL (nixos-anywhere, both disks by serial, inject cert+secrets)"
if ! nix run github:nix-community/nixos-anywhere -- \
      --flake "$FLAKE#pcname" --target-host "root@$IP" -i "$KEY" --extra-files "$EXTRA" $NA_MAIN; then
  echo "!! nixos-anywhere could not reconnect at $IP (kexec installer took a different DHCP lease)."
  echo "   Discovering the box by MAC $MAC and resuming ..."
  DIP=$(discover_by_mac "$MAC")
  [ -n "$DIP" ] || { echo "could not locate the box by MAC — aborting"; exit 1; }
  echo "   installer found at $DIP — resuming"
  nix run github:nix-community/nixos-anywhere -- \
    --flake "$FLAKE#pcname" --target-host "root@$DIP" -i "$KEY" --extra-files "$EXTRA" \
    $NA_FALLBACK
fi

# Direct-cable path: verify the install ON DISK from the still-running installer (no reboot,
# no internet needed), then hand off. Bringing the box up for a live/service verify needs it
# on an internet-connected network (router R) — a separate, documented step.
if [ "$NETBOOT" = auto ]; then
  say "2. verify the install ON DISK (direct cable has no internet path for a service verify)"
  ondisk=$(ssh $SSHO "root@$IP" '
    mkdir -p /mnt/t; ok=""
    for part in $(lsblk -lnpo NAME,FSTYPE | awk "\$2==\"ext4\"{print \$1}"); do
      mount -o ro "$part" /mnt/t 2>/dev/null || continue
      if [ -f /mnt/t/etc/selfprivacy/secrets.json ] && [ -L /mnt/t/nix/var/nix/profiles/system ]; then
        printf "root=%s secrets=yes " "$part"
        [ -f /mnt/t/etc/ssl/selfprivacy-le/fullchain.pem ] && printf "le=yes" || printf "le=no"
        ok=1; umount /mnt/t 2>/dev/null || true; break
      fi
      umount /mnt/t 2>/dev/null || true
    done
    echo; [ -n "$ok" ] && echo OK || echo NO-INSTALLED-ROOT-FOUND
  ' 2>/dev/null || true)
  echo "   on-disk: $(echo "$ondisk" | tr "\n" " ")"
  stop_netboot
  if echo "$ondisk" | grep -q OK; then
    say "install.native-ethernet [lan-setup-0]: INSTALL VERIFIED ON DISK"
    cat <<EOM
The install is complete; the injected identity (secrets.json + LE cert) is on disk.
A live/service verify (https or .onion) needs the box on a network with internet, which a
direct cable is not. To bring it up and verify from anywhere:
  1) Move the target to router R (or set its BIOS boot order to the internal disk).
  2) Power-cycle it — the netboot server is now stopped, so it boots from disk and joins the LAN.
  3) Verify services (from anywhere), reading the token off the box:
       T=\$(ssh $SSHO root@<box-ip> jq -r .api.token /etc/selfprivacy/secrets.json)
       python3 "$HERE/verify_install_native_ethernet.py" --transport https --domain "$DOMAIN" --token "\$T" --ssh-key "$KEY"
EOM
    exit 0
  else
    echo "!! no installed root with secrets.json found on disk — install may have failed"; exit 1
  fi
fi

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

say "3. post-install — tighten LE key perms, ensure nginx serving"
ssh $SSHO "root@$IP" '
  chown root:nginx /etc/ssl/selfprivacy-le/key.pem 2>/dev/null || true
  chmod 640 /etc/ssl/selfprivacy-le/key.pem 2>/dev/null || true
  systemctl reload nginx 2>/dev/null || systemctl restart nginx || true
  sleep 2'

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

TRANSPORT=${TRANSPORT:-https}   # https = PUBLIC, from anywhere (the real requirement); or onion
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
