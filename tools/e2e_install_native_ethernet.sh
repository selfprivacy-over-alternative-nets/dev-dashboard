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

say "0. preflight — target reachable over LAN (network mode)?"
if ssh $SSHO -o BatchMode=yes "root@$IP" true 2>/dev/null; then
  echo "target root@$IP reachable"
else
  echo "target not reachable at root@$IP — boot it in network mode (on the LAN, sshd up) and retry"; exit 1
fi
[ -f "$EXTRA/etc/ssl/selfprivacy-le/fullchain.pem" ] || { echo "missing LE cert in $EXTRA — run the staging step first"; exit 1; }

say "1. WIPE + INSTALL (nixos-anywhere, both disks by serial, inject cert+secrets)"
if ! nix run github:nix-community/nixos-anywhere -- \
      --flake "$FLAKE#pcname" --target-host "root@$IP" -i "$KEY" --extra-files "$EXTRA"; then
  echo "!! nixos-anywhere could not reconnect at $IP (kexec installer took a different DHCP lease)."
  echo "   Discovering the box by MAC $MAC and resuming disko,install,reboot ..."
  for i in $(seq 1 254); do ping -c1 -W1 "192.168.1.$i" >/dev/null 2>&1 & done; wait 2>/dev/null || true
  DIP=$(ip neigh | awk -v m="$MAC" 'tolower($0) ~ tolower(m){print $1; exit}')
  [ -n "$DIP" ] || { echo "could not locate the box by MAC — aborting"; exit 1; }
  echo "   installer found at $DIP — resuming"
  nix run github:nix-community/nixos-anywhere -- \
    --flake "$FLAKE#pcname" --target-host "root@$DIP" -i "$KEY" --extra-files "$EXTRA" \
    --phases disko,install,reboot
fi

say "2. wait for reboot into the installed system at static $IP"
up=""
for i in $(seq 1 48); do
  if ssh $SSHO -o BatchMode=yes "root@$IP" true 2>/dev/null; then up=1; echo "up after ~$((i*5))s"; break; fi
  sleep 5
done
[ -n "$up" ] || { echo "box did not come back at $IP within timeout"; exit 1; }

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
