#!/usr/bin/env bash
# Called by `dash find-target` AFTER a target is confirmed. It fills in the last two blanks of the
# install command — the deploy FLAKE and the DOMAIN — then prints the ready-to-run command and offers
# to run it. Can also be run standalone:  MAC=<mac> IP=<ip> bash tools/resolve_flake.sh
#
# "The flake" = the folder whose flake.nix declares `nixosConfigurations.box` — i.e. the
# selfprivacy-altnet-deployer. Normally there's exactly one, so it's auto-found; otherwise you pick
# from a list or type the path.
set -euo pipefail
MAC=${MAC:?internal: target MAC (set by find-target)}
IP=${IP:?internal: target IP (set by find-target)}
KEY=${KEY:-$HOME/.ssh/pcname_ed25519}
SETUP=${SETUP:-install.lan-setup-0}

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)   # dev-dashboard/tools
DASH_DIR=$(cd "$SELF_DIR/.." && pwd)                      # dev-dashboard
SEARCH=$(cd "$SELF_DIR/../.." && pwd)                     # the selfprivacy repo folder
. "$SELF_DIR/prompt_lib.sh"                               # shared input validators (is_domain, is_wpa_psk, …)

G=$'\e[32m'; C=$'\e[36m'; B=$'\e[1m'; R=$'\e[31m'; Y=$'\e[33m'; GR=$'\e[90m'; X=$'\e[0m'
ask(){ local p="$1" v=""; printf '%s' "$p" >&2; { read -r v </dev/tty; } 2>/dev/null || v=""; printf '%s' "$v"; }
ask_secret(){ local p="$1" v=""; printf '%s' "$p" >&2; { read -rs v </dev/tty; } 2>/dev/null || v=""; printf '\n' >&2; printf '%s' "$v"; }

# Verify the wifi WITHOUT disturbing the laptop's current connection.
#  - SSID in range: always checkable (passive scan).
#  - Password: only checkable non-disruptively if a wifi radio is FREE (you're on ethernet, or a 2nd
#    adapter exists) — we associate on THAT radio (ipv4 disabled, so it's just the handshake), then
#    tear it down. If the only radio is in use, we can't test it without dropping your wifi → warn.
verify_wifi(){
  local ssid="$1" psk="$2" busy spare tmp="sp-verify-$$"
  command -v nmcli >/dev/null 2>&1 || { echo "${Y}  ⚠ wifi not verified: 'nmcli' not available.${X}"; return 0; }
  if nmcli -t -f SSID dev wifi list 2>/dev/null | grep -qxF "$ssid"; then
    echo "${G}  ✓ wifi '$ssid' is in range${X}"
  else
    echo "${Y}  ⚠ wifi '$ssid' is NOT visible in a scan — check the name (it won't connect if wrong/out of range).${X}"
  fi
  busy=$(nmcli -t -f DEVICE,TYPE,STATE dev 2>/dev/null | awk -F: '$2=="wifi"&&$3=="connected"{print $1;exit}')
  spare=$(nmcli -t -f DEVICE,TYPE dev 2>/dev/null | awk -F: -v b="$busy" '$2=="wifi"&&$1!=b{print $1;exit}')
  if [ -z "$spare" ]; then
    echo "${Y}  ⚠ wifi PASSWORD not verified — your only wifi radio is in use, and testing it would drop"
    echo "${Y}    your current wifi. The install still applies it; double-check the password.${X}"
    return 0
  fi
  echo "${GR}  verifying the password on a free wifi radio ($spare) — your current connection is untouched…${X}"
  if nmcli con add type wifi ifname "$spare" con-name "$tmp" ssid "$ssid" \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk" \
        connection.autoconnect no ipv4.method disabled ipv6.method ignore >/dev/null 2>&1 \
     && nmcli --wait 20 con up "$tmp" >/dev/null 2>&1; then
    echo "${G}  ✓ wifi password verified${X}"
  else
    echo "${Y}  ⚠ couldn't connect with that password on $spare — it may be wrong (or the AP is out of reach). Double-check it.${X}"
  fi
  nmcli con down "$tmp" >/dev/null 2>&1 || true
  nmcli con delete "$tmp" >/dev/null 2>&1 || true
}

# ── find candidate deploy flakes: a sibling folder whose flake.nix declares nixosConfigurations.box ──
mapfile -t FLAKES < <(
  for f in "$SEARCH"/*/flake.nix; do
    [ -f "$f" ] || continue
    grep -qE 'nixosConfigurations\.(box|pcname)\b' "$f" && dirname "$f"
  done | sort -u
)

FLAKE=""
if [ "${#FLAKES[@]}" -eq 1 ]; then
  FLAKE="${FLAKES[0]}"
  echo "${GR}deploy flake auto-found: $FLAKE${X}"
elif [ "${#FLAKES[@]}" -gt 1 ]; then
  echo "${B}Which deploy flake?${X}"
  i=1; for f in "${FLAKES[@]}"; do echo "  [$i] $f"; i=$((i+1)); done
  while :; do                                            # rule: a number in range; anything else → re-ask
    sel=$(ask "pick a number 1-${#FLAKES[@]}: ")
    if [[ "$sel" =~ ^[0-9]+$ ]] && [ "$sel" -ge 1 ] && [ "$sel" -le "${#FLAKES[@]}" ]; then FLAKE="${FLAKES[$((sel-1))]}"; break; fi
    echo "${Y}  please choose 1-${#FLAKES[@]}${X}"
  done
fi
if [ -z "$FLAKE" ]; then
  echo "${Y}No deploy flake auto-found.${X} It's the folder with a flake.nix that has"
  echo "  ${GR}nixosConfigurations.box${X} — e.g. selfprivacy-altnet-deployer."
  FLAKE=$(ask "type its path (blank = leave a <flake> placeholder): ")
fi
FLAKE=${FLAKE:-<path-to-selfprivacy-altnet-deployer>}

# ── public access + domain, decided UP-FRONT ──────────────────────────────────────────────────────
# The chosen public-access method DECIDES the domain, and the domain is baked into the box at deploy
# time (vhost routing + LE cert) — so we ask it HERE, right after the device is connected, not at the
# end. add-cloudflare.sh --plan asks the 3 questions (no box needed) and hands back DOMAIN + method;
# the method flows through to the end-of-install apply as PUBLIC_* envs.
DOM_DEFAULT=""
[ -f "$FLAKE/flake.nix" ] && DOM_DEFAULT=$(grep -oE 'selfprivacy-domain *= *"[^"]+"' "$FLAKE/flake.nix" | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
PUBLIC_METHOD=""; PUBLIC_DOMAIN_KIND=""; PUBLIC_CF_NAMED=0; DOMAIN=""
eval "$(bash "$SELF_DIR/add-cloudflare.sh" --plan --default-domain "${DOM_DEFAULT:-}")" || true
DOMAIN=${DOMAIN:-${DOM_DEFAULT:-<your-domain>}}

# ── network setup: how the box gets online AFTER install (reqs 20-23). The install is identical;
#    the choice only decides post-install connectivity + whether wifi credentials are needed. ──
echo
echo "${B}Which network setup?${X}  (how the box connects to the internet after it's installed)"
echo "  ${B}1${X}  lan-setup-0a — you plug the cable into your router afterwards  ${GR}(no wifi)${X}"
echo "  ${B}2${X}  lan-setup-0b — the box joins your home wifi"
echo "  ${B}3${X}  lan-setup-0c — the box joins a different wifi"
echo "  ${B}4${X}  lan-setup-0d — wifi only (you remove the cable afterwards)"
# rule: one of 1-4 (or the labels 0a/0b/0c/0d). empty = 1. anything else → re-ask (never silently default).
while :; do
  sel=$(ask "pick a number 1-4 [1]: ")
  case "${sel,,}" in
    ""|1|0a|a) SETUP=install.lan-setup-0a; WIFI=0; break ;;
    2|0b|b)    SETUP=install.lan-setup-0b; WIFI=1; break ;;
    3|0c|c)    SETUP=install.lan-setup-0c; WIFI=1; break ;;
    4|0d|d)    SETUP=install.lan-setup-0d; WIFI=1; break ;;
    *) echo "${Y}  please choose 1-4 (or 0a/0b/0c/0d)${X}" ;;
  esac
done

WIFI_SSID=""; WIFI_PSK=""
if [ "$WIFI" = 1 ]; then
  while :; do                                            # rule: SSID can't be empty
    WIFI_SSID=$(ask "  wifi name (SSID): ")
    [ -n "$WIFI_SSID" ] && break
    echo "${Y}  the wifi name (SSID) can't be empty${X}"
  done
  while :; do                                            # rule: WPA/WPA2 pass = 8-63 chars (or 64-hex)
    WIFI_PSK=$(ask_secret "  wifi password (hidden): ")
    is_wpa_psk "$WIFI_PSK" && break
    echo "${Y}  a WPA/WPA2 password is 8-63 characters (or a 64-char hex key)${X}"
  done
  verify_wifi "$WIFI_SSID" "$WIFI_PSK"
fi

# the --env list (wifi only when the setup needs it)
ENVS=( "FLAKE=$FLAKE" "MAC=$MAC" "DOMAIN=$DOMAIN" )
[ -n "$PUBLIC_METHOD" ] && ENVS+=( "PUBLIC_METHOD=$PUBLIC_METHOD" "PUBLIC_DOMAIN_KIND=$PUBLIC_DOMAIN_KIND" "PUBLIC_CF_NAMED=$PUBLIC_CF_NAMED" )
[ -n "$WIFI_SSID" ] && ENVS+=( "WIFI_SSID=$WIFI_SSID" )
[ -n "$WIFI_PSK" ]  && ENVS+=( "WIFI_PSK=$WIFI_PSK" )
ENVS+=( "NETBOOT=auto" "TRANSPORT=none" )

KEY_DISP=${KEY/#$HOME/\~}
echo
echo "${G}ready to install${X} — run this:"
printf "%s./dash run %s \\\\\n  --ip %s \\\\\n  --key %s" "$C" "$SETUP" "$IP" "$KEY_DISP"
for e in "${ENVS[@]}"; do
  case "$e" in WIFI_PSK=*) printf " \\\\\n  --env WIFI_PSK=%s" "••••••" ;; *) printf " \\\\\n  --env %s" "$e" ;; esac
done
printf "%s\n" "$X"
[ -n "$WIFI_PSK" ] && echo "${GR}(the wifi password is hidden above — it's included if you choose 'run it now'; re-type it if you copy-paste)${X}"

# ── offer to run it (the install itself confirms the disk wipe) ──
case "$FLAKE" in *'<'*) echo "${GR}(fill in the flake, then run the command above.)${X}"; exit 0;; esac
# rule: y/yes or n/no (empty = no). anything else → re-ask (don't guess on an install trigger).
RUN=0
while :; do
  go=$(ask $'\nrun it now? [y/N]: ')
  case "${go,,}" in
    y|yes)   RUN=1; break ;;
    ""|n|no) RUN=0; break ;;
    *) echo "${Y}  please answer y or n${X}" ;;
  esac
done
if [ "$RUN" = 1 ]; then
  RUN_ARGS=( run "$SETUP" --ip "$IP" --key "$KEY" )
  for e in "${ENVS[@]}"; do RUN_ARGS+=( --env "$e" ); done
  ( cd "$DASH_DIR" && ./dash "${RUN_ARGS[@]}" )
else
  echo "not run — copy the command above when you're ready."
fi
