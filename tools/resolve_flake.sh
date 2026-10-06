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

G=$'\e[32m'; C=$'\e[36m'; B=$'\e[1m'; R=$'\e[31m'; Y=$'\e[33m'; GR=$'\e[90m'; X=$'\e[0m'
ask(){ local p="$1" v=""; printf '%s' "$p" >&2; { read -r v </dev/tty; } 2>/dev/null || v=""; printf '%s' "$v"; }

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
  sel=$(ask "pick a number: ")
  [[ "$sel" =~ ^[0-9]+$ ]] && [ "$sel" -ge 1 ] && [ "$sel" -le "${#FLAKES[@]}" ] && FLAKE="${FLAKES[$((sel-1))]}"
fi
if [ -z "$FLAKE" ]; then
  echo "${Y}No deploy flake auto-found.${X} It's the folder with a flake.nix that has"
  echo "  ${GR}nixosConfigurations.box${X} — e.g. selfprivacy-altnet-deployer."
  FLAKE=$(ask "type its path (blank = leave a <flake> placeholder): ")
fi
FLAKE=${FLAKE:-<path-to-selfprivacy-altnet-deployer>}

# ── domain: suggest the one baked into the flake, let the user override ──
DOM_DEFAULT=""
[ -f "$FLAKE/flake.nix" ] && DOM_DEFAULT=$(grep -oE 'selfprivacy-domain *= *"[^"]+"' "$FLAKE/flake.nix" | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
DOMAIN=$(ask "your web address (domain)${DOM_DEFAULT:+ [$DOM_DEFAULT]}: ")
DOMAIN=${DOMAIN:-${DOM_DEFAULT:-<your-domain>}}

KEY_DISP=${KEY/#$HOME/\~}
echo
echo "${G}ready to install${X} — run this (for a wifi-only setup use ${B}install.lan-setup-0d${X} and add ${B}--env WIFI_SSID=… --env WIFI_PSK=…${X}):"
printf "%s./dash run %s \\\\\n  --ip %s \\\\\n  --key %s \\\\\n  --env FLAKE=%s \\\\\n  --env MAC=%s \\\\\n  --env DOMAIN=%s \\\\\n  --env NETBOOT=auto \\\\\n  --env TRANSPORT=none%s\n" \
  "$C" "$SETUP" "$IP" "$KEY_DISP" "$FLAKE" "$MAC" "$DOMAIN" "$X"

# ── offer to run it (the install itself confirms the disk wipe) ──
case "$FLAKE" in *'<'*) echo "${GR}(fill in the flake/domain, then run the command above.)${X}"; exit 0;; esac
go=$(ask $'\nrun it now? [y/N]: ')
case "$go" in
  y|Y|yes|YES) ( cd "$DASH_DIR" && ./dash run "$SETUP" --ip "$IP" --key "$KEY" \
      --env "FLAKE=$FLAKE" --env "MAC=$MAC" --env "DOMAIN=$DOMAIN" --env NETBOOT=auto --env TRANSPORT=none ) ;;
  *) echo "not run — copy the command above when you're ready." ;;
esac
