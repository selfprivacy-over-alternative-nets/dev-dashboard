#!/usr/bin/env bash
# Guided post-install finish: take a freshly-installed box from "on disk" to "wired up on DNS".
# Steps, in order:
#   1. ask the operator to reboot the box (wifi-only: unplug the install cable too)
#   2. wait until it's back up and reachable over SSH (by --ip, or found by --mac, or typed in)
#   3. confirm it booted the INSTALLED system (secrets.json present), not the installer
#   4. verify it has internet
#   5. read its public IP (and its LAN IP)
#   6. print the 5 DNS A-records with the IP already filled in
#   7. ask "did you enter them?" — and if yes, verify they actually resolve to that IP
#
# Run standalone any time (e.g. to re-check DNS later):
#   bash tools/finish_box_setup.sh --domain weersurf.nl --key ~/.ssh/pcname_ed25519 \
#        [--ip 192.168.1.56] [--mac d8:cb:8a:7c:0a:f4] [--wifi 'Koolwitje 5'] [--setup lan-setup-0d]
# --domain and --key are required; the rest are optional aids.
set -uo pipefail

DOMAIN=""; KEY=""; IP=""; MAC=""; WIFI=""; SETUP="${SP_SETUP:-lan-setup-0a}"
PUBLIC_METHOD="${PUBLIC_METHOD:-}"; PUBLIC_CF_NAMED="${PUBLIC_CF_NAMED:-0}"   # embedded public-access choice
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --key)    KEY="$2";    shift 2;;
    --ip)     IP="$2";     shift 2;;
    --mac)    MAC="$2";    shift 2;;
    --wifi)   WIFI="$2";   shift 2;;
    --setup)  SETUP="$2";  shift 2;;
    --public-method)   PUBLIC_METHOD="$2";   shift 2;;   # cloudflare|ngrok|router|none (embed the tunnel)
    --public-cf-named) PUBLIC_CF_NAMED="$2"; shift 2;;   # 1 = named tunnel, 0 = quick tunnel
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$DOMAIN" ] || { echo "required: --domain <your-domain> (e.g. --domain weersurf.nl)" >&2; exit 2; }
[ -n "$KEY" ]    || { echo "required: --key <ssh deploy key> (e.g. --key ~/.ssh/pcname_ed25519)" >&2; exit 2; }
KEY=${KEY/#\~/$HOME}
SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

G=$'\e[32m'; C=$'\e[36m'; B=$'\e[1m'; R=$'\e[31m'; Y=$'\e[33m'; GR=$'\e[90m'; X=$'\e[0m'
SSHO="-i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=6 -o BatchMode=yes"
say(){ printf '\n%s== %s ==%s\n' "$B" "$*" "$X"; }
ask(){ local p="$1" v=""; printf '%s' "$p" >&2; { read -r v </dev/tty; } 2>/dev/null || v=""; printf '%s' "$v"; }
ssh_ok(){ ssh $SSHO "root@$1" true 2>/dev/null; }
box(){ ssh $SSHO "root@$BIP" "$@" 2>/dev/null; }
is_ipv4(){ [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
is_private(){ case "$1" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0;; *) return 1;; esac; }

SUBS=(api cloud git matrix meet)
dns_records(){ local ip="$1" s; for s in "${SUBS[@]}"; do printf "     A   %-28s %s\n" "$s.$DOMAIN" "$ip"; done; }

# Resolve one name's first A record via PUBLIC resolvers (avoids this laptop's cache + /etc/hosts,
# which could otherwise give a false "correct"). Tries 1.1.1.1 then 8.8.8.8, then getent as a last resort.
resolve_a(){
  local n="$1" out=""
  if command -v dig >/dev/null 2>&1; then
    out=$(dig +short +time=3 +tries=1 A "$n" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
    [ -z "$out" ] && out=$(dig +short +time=3 +tries=1 A "$n" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
  fi
  [ -z "$out" ] && command -v getent >/dev/null 2>&1 && out=$(getent ahostsv4 "$n" 2>/dev/null | awk '{print $1; exit}')
  printf '%s' "$out"
}

# Compare all 5 records against the public IP (and recognise the LAN IP as a home-only choice).
# Returns 0 only if every name resolves to $PUB.
verify_dns(){
  local exp="$1" lan="$2" s name got ok=1 pending=0
  for s in "${SUBS[@]}"; do
    name="$s.$DOMAIN"; got=$(resolve_a "$name")
    if   [ -z "$got" ];            then echo "${R}  ✗ $name → not found (NXDOMAIN / not propagated yet)${X}"; ok=0; pending=1
    elif [ "$got" = "$exp" ];      then echo "${G}  ✓ $name → $got${X}"
    elif [ -n "$lan" ] && [ "$got" = "$lan" ]; then echo "${Y}  ⚠ $name → $got (the box's LAN IP — home access only, NOT reachable from the internet)${X}"; ok=0
    elif is_private "$got";        then echo "${Y}  ⚠ $name → $got (a private/LAN IP — home only, NOT reachable from the internet)${X}"; ok=0
    else                                echo "${R}  ✗ $name → $got (expected $exp — fix this record)${X}"; ok=0
    fi
  done
  [ "$pending" = 1 ] && echo "${GR}  (DNS changes can take a few minutes to propagate — wait, then re-check.)${X}"
  [ "$ok" = 1 ]
}

# ── 1. reboot ───────────────────────────────────────────────────────────────
say "1/7  reboot the box"
if [ -n "$WIFI" ]; then
  echo "At the box's console (user ${B}root${X}, password ${B}tijdelijkwachtwoord${X}) type ${B}reboot${X},"
  echo "then UNPLUG the install cable so it comes up on wifi '${WIFI}'."
  echo "Once it's back, on its console run ${B}hostname -I${X} and note its ${B}LAN IP${X} — the"
  echo "192.168.x.x address. I only need it to CONNECT to the box over your network; I read the box's"
  echo "${B}public${X} IP myself in step 5. (To see the public IP yourself: ${B}curl -s https://api.ipify.org${X} on the box.)"
else
  echo "Reboot the box (type ${B}reboot${X} at its console, or press the power button) and make"
  echo "sure its network cable goes to your router."
fi
_=$(ask $'\nPress ENTER once it is rebooting… ')

# ── 2. locate + wait until reachable ─────────────────────────────────────────
say "2/7  wait for the box to come back up"
BIP="$IP"
if [ -z "$BIP" ] && [ -n "$MAC" ]; then
  echo "looking for it on the LAN by MAC $MAC …"
  prefixes=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' \
    | while IFS= read -r c; do echo "${c%/*}"; done \
    | awk -F. '/^10\./||/^192\.168\./||($1=="172"&&$2>=16&&$2<=31){print $1"."$2"."$3}' | sort -u)
  for p in $prefixes; do for i in $(seq 1 254); do ping -c1 -W1 "$p.$i" >/dev/null 2>&1 & done; done
  wait 2>/dev/null || true
  BIP=$(ip neigh | awk -v m="$MAC" 'tolower($0) ~ tolower(m){print $1; exit}')
fi
if [ -z "$BIP" ]; then
  echo "${GR}(couldn't auto-find it — expected for wifi, where the box uses a different MAC.)${X}"
  BIP=$(ask "Type the box's ${B}LAN IP${X} — the 192.168.x.x address from ${B}hostname -I${X} on its console (NOT the public IP): ")
fi
is_ipv4 "$BIP" || { echo "${R}'$BIP' is not an IP — rerun once you have it from the box console.${X}"; exit 1; }
printf 'waiting for ssh root@%s ' "$BIP"
up=""; for _ in $(seq 1 60); do if ssh_ok "$BIP"; then up=1; echo " up"; break; fi; printf .; sleep 5; done
[ -n "$up" ] || { echo; echo "${R}no SSH on $BIP after ~5m — is it on the network and booted from disk? Check the IP.${X}"; exit 1; }

# ── 3. confirm it's the INSTALLED system, not the installer ───────────────────
say "3/7  confirm it booted the installed system"
if box 'test -f /etc/selfprivacy/secrets.json'; then
  echo "${G}installed system confirmed (secrets.json present).${X}"
else
  echo "${R}this looks like the in-RAM INSTALLER (no secrets.json).${X} It PXE-booted again instead of"
  echo "booting the disk. Stop the netboot server and set the BIOS to boot the internal disk, then rerun."
  exit 1
fi

# ── 4. internet ──────────────────────────────────────────────────────────────
say "4/7  verify the box has internet"
if box 'ping -c1 -W3 1.1.1.1 >/dev/null 2>&1'; then
  echo "${G}online ✓${X}"
else
  echo "${R}the box has no internet.${X} ${WIFI:+Check the wifi password/SSID. }Public HTTPS needs internet; fix this, then rerun."
  exit 1
fi

# Steps 5-7 (read public IP → A-records → verify) are the ROUTER/port-forward path (or a plain
# no-method run). For a tunnel/ipv6 method, step 8 (add-cloudflare) wires up public access and there
# are NO A-records to add — '$DOMAIN' is only the box's internal name from the deploy flake.
case "${PUBLIC_METHOD:-}" in cloudflare|ngrok|pinggy|localtunnel|ipv6|none) _dns=0 ;; *) _dns=1 ;; esac
if [ "$_dns" = 1 ]; then

# ── 5. read the IPs ──────────────────────────────────────────────────────────
say "5/7  read the box's IPs"
LAN=$(box 'hostname -I' | awk '{print $1}')
PUB=$(box 'curl -s --max-time 10 https://api.ipify.org')
echo "  LAN IP (home access):     ${B}${LAN:-unknown}${X}"
echo "  public IP (from anywhere): ${B}${PUB:-unknown}${X}"
is_ipv4 "$PUB" || { echo "${Y}couldn't read a valid public IP — using the LAN IP for the records below.${X}"; PUB="$LAN"; }

# ── 6. DNS records with the IP filled in ─────────────────────────────────────
say "6/7  add these 5 DNS A-records at your DNS host"
echo "For access ${B}from anywhere${X} (needs :443 forwarded on the router to $LAN), point them at the public IP:"
dns_records "$PUB"
if is_ipv4 "$LAN" && [ "$LAN" != "$PUB" ]; then
  echo "${GR}(home-only instead? point them at the LAN IP $LAN — reachable on your wifi, not from outside.)${X}"
fi

# ── 7. confirm + verify ──────────────────────────────────────────────────────
say "7/7  verify the records"
ans=$(ask "Did you enter all 5 records at your DNS host? [y/N]: ")
case "$ans" in
  y|Y|yes|YES)
    while :; do
      echo "checking what they resolve to (via 1.1.1.1 / 8.8.8.8) …"
      if verify_dns "$PUB" "$LAN"; then
        echo "${G}✓ all 5 records resolve to $PUB — DNS is set up correctly.${X}"
        echo "${GR}Next: integration-test the stack —${X}"
        echo "   ${B}./dash run L3.connect.desktop --net https --on ${SETUP} --ip $BIP --key ${KEY/#$HOME/\~} \\${X}"
        echo "   ${B}  --token \$(ssh -i ${KEY/#$HOME/\~} root@$BIP 'jq -r .api.token /etc/selfprivacy/secrets.json')${X}"
        break
      fi
      again=$(ask $'\nSome records aren\'t right yet. Re-check now? [y/N]: ')
      case "$again" in y|Y|yes|YES) continue;; *) echo "Stopped — fix the records and rerun this script to re-check."; break;; esac
    done ;;
  *) echo "No problem — add them when ready, then rerun this script to verify:"
     echo "   ${C}bash $(basename "$0") --domain $DOMAIN --key ${KEY/#$HOME/\~} --ip $BIP --setup $SETUP${X}" ;;
esac
elif [ "${PUBLIC_METHOD:-}" = none ]; then
  : # LAN / .onion only — nothing public to add
else
  say "public access via ${PUBLIC_METHOD}"
  echo "Nothing to add here — a FREE tunnel gives you a random public URL from the provider, printed"
  echo "${GR}when it starts in step 8 below (e.g. https://<random>.trycloudflare.com). Nothing to register or pick.${X}"
fi

# ── 8. public access (embedded; configured ENTIRELY over SSH — nothing is typed on the box) ────────
if [ -n "$PUBLIC_METHOD" ] && [ "$PUBLIC_METHOD" != none ] && [ -n "${BIP:-}" ]; then
  say "8  public access via $PUBLIC_METHOD (set up over SSH — no box login)"
  cfflag=--cf-quick; [ "$PUBLIC_CF_NAMED" = 1 ] && cfflag=--cf-named
  bash "$SELF/add-cloudflare.sh" --key "$KEY" --ip "$BIP" --domain "$DOMAIN" --setup "$SETUP" \
       --method "$PUBLIC_METHOD" $([ "$PUBLIC_METHOD" = cloudflare ] && echo "$cfflag") \
    || echo "${Y}(public-access setup didn't finish — rerun: bash tools/add-cloudflare.sh --key ${KEY/#$HOME/\~} --ip $BIP --method $PUBLIC_METHOD)${X}"
fi
