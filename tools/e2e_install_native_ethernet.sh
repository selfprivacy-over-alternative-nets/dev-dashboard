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

say "0. preflight — target reachable over LAN (network mode)?"
if ! ensure_target; then
  echo "target not reachable at root@$IP and not found on the LAN by MAC $MAC."
  echo "  - boot it in network mode (installer or installed NixOS, sshd up, on the LAN), or"
  echo "  - pass the right IP:   IP=<addr> $0    (or  ./dash run <install-id> --ip <addr>), or"
  echo "  - check MAC=$MAC matches the target's NIC."
  exit 1
fi
[ -f "$EXTRA/etc/ssl/selfprivacy-le/fullchain.pem" ] || { echo "missing LE cert in $EXTRA — run the staging step first"; exit 1; }

say "1. WIPE + INSTALL (nixos-anywhere, both disks by serial, inject cert+secrets)"
if ! nix run github:nix-community/nixos-anywhere -- \
      --flake "$FLAKE#pcname" --target-host "root@$IP" -i "$KEY" --extra-files "$EXTRA"; then
  echo "!! nixos-anywhere could not reconnect at $IP (kexec installer took a different DHCP lease)."
  echo "   Discovering the box by MAC $MAC and resuming disko,install,reboot ..."
  DIP=$(discover_by_mac "$MAC")
  [ -n "$DIP" ] || { echo "could not locate the box by MAC — aborting"; exit 1; }
  echo "   installer found at $DIP — resuming"
  nix run github:nix-community/nixos-anywhere -- \
    --flake "$FLAKE#pcname" --target-host "root@$DIP" -i "$KEY" --extra-files "$EXTRA" \
    --phases disko,install,reboot
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
if [ "$TRANSPORT" = onion ]; then
  exec python3 "$HERE/verify_install_native_ethernet.py" --transport onion --onion "$ONION" --token "$TOKEN"
else
  exec python3 "$HERE/verify_install_native_ethernet.py" --transport https --domain "$DOMAIN" --token "$TOKEN" --ssh-key "$KEY"
fi
