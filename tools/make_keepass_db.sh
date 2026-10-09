#!/usr/bin/env bash
# make_keepass_db.sh — (re)create a KeePassXC database holding every credential for
# one SelfPrivacy deployment: the deployed URL(s), the target's root/console-recovery
# login, the SSH deploy key, the API token, and the .onion.
#
# Run automatically at the end of an install (see e2e_install_native_ethernet.sh),
# or by hand. The .kdbx is written under the deploy's state/ (git-ignored — never
# pushed), so pushing your config never leaks live credentials.
#
# Inputs (env vars):
#   DOMAIN                 deployed domain, e.g. example.com                 (required)
#   IP                     target LAN IP (to read token/onion + ssh entry)  (optional)
#   KEY                    ssh private key path (deploy key)                 (optional)
#   TOKEN                  API token; if empty, read from the box via SSH    (optional)
#   ONION                  .onion; if empty, read from the box via SSH       (optional)
#   ROOT_USER              default: root
#   ROOT_PW                target console/recovery password                  (optional)
#   HOST                   label for the deployment, default: pcname
#   OUT                    output .kdbx path
#                          default: ${FLAKE:-.}/state/keepass/${HOST}.kdbx
#   SP_KEEPASS_PASSWORD    master password for the .kdbx; if unset, prompt (TTY only)
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN=<your domain>}"
IP="${IP:-}"; KEY="${KEY:-}"; TOKEN="${TOKEN:-}"; ONION="${ONION:-}"
ROOT_USER="${ROOT_USER:-root}"; ROOT_PW="${ROOT_PW:-}"; HOST="${HOST:-pcname}"
OUT="${OUT:-${FLAKE:-.}/state/keepass/${HOST}.kdbx}"

command -v keepassxc-cli >/dev/null || {
  echo "ERROR: keepassxc-cli not found. Install it (e.g. 'sudo apt install keepassxc' or via nix)." >&2
  exit 1
}

SSHO=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8)
[ -n "$KEY" ] && SSHO+=(-i "$KEY")

# Pull live values from the box when not supplied.
if [ -n "$IP" ]; then
  [ -z "$TOKEN" ] && TOKEN=$(ssh "${SSHO[@]}" "root@$IP" 'jq -r .api.token /etc/selfprivacy/secrets.json' 2>/dev/null || true)
  [ -z "$ONION" ] && ONION=$(ssh "${SSHO[@]}" "root@$IP" 'cat /var/lib/tor/hidden_service/hostname 2>/dev/null' 2>/dev/null || true)
fi

# Master password: env, else interactive prompt. Never echoed / logged.
PW="${SP_KEEPASS_PASSWORD:-}"
if [ -z "$PW" ]; then
  [ -t 0 ] || { echo "ERROR: set SP_KEEPASS_PASSWORD (no TTY to prompt for the master password)." >&2; exit 1; }
  # Rule (req 142): re-ask until non-empty AND matching — a typo re-prompts, it never aborts the run.
  while :; do
    read -r -s -p "New master password for $OUT: " PW; echo
    [ -n "$PW" ] || { echo "  password can't be empty — try again." >&2; continue; }
    read -r -s -p "Confirm: " PW2; echo
    [ "$PW" = "$PW2" ] && break
    echo "  passwords don't match — try again." >&2
  done
fi

mkdir -p "$(dirname "$OUT")"
# state/keepass is under the git-ignored state/, but belt-and-suspenders:
echo '*' > "$(dirname "$OUT")/.gitignore"
[ -f "$OUT" ] && mv -f "$OUT" "$OUT.bak-$(date +%s 2>/dev/null || echo prev)"

# helpers — DB password is piped on stdin (KEEPASSXC_PASSWORD is not honored in 2.7).
kp_create() { printf '%s\n%s\n' "$PW" "$PW" | keepassxc-cli db-create -q -p "$OUT"; }
# keepassxc-cli wants:  add [options] DATABASE ENTRY  — so OUT goes before the title.
kp_add()    { local title="${!#}"; printf '%s\n' "$PW" | keepassxc-cli add -q "${@:1:$#-1}" "$OUT" "$title"; }  # <opts...> <title>
kp_add_pw() { printf '%s\n%s\n'  "$PW" "$2"  | keepassxc-cli add -q -p -u "$1" --url "$3" --notes "$4" "$OUT" "$5"; }  # user pw url notes title

kp_create

# API token (the app's bearer credential)
if [ -n "$TOKEN" ]; then
  kp_add_pw "admin" "$TOKEN" "https://api.$DOMAIN" "SelfPrivacy GraphQL API bearer token" "SelfPrivacy API"
else
  kp_add -u admin --url "https://api.$DOMAIN" --notes "API token unavailable at generation time" "SelfPrivacy API"
fi

# Target root / console recovery login
if [ -n "$ROOT_PW" ]; then
  kp_add_pw "$ROOT_USER" "$ROOT_PW" "ssh://$IP" "Console/recovery login. SSH is key-only; this password is for the console." "Target ${ROOT_USER} (console recovery)"
else
  kp_add -u "$ROOT_USER" --url "ssh://$IP" --notes "SSH is key-only (no password auth). No console recovery password captured." "Target ${ROOT_USER} (console recovery)"
fi

# SSH deploy key (private key embedded in notes — encrypted inside the kdbx)
if [ -n "$KEY" ] && [ -r "$KEY" ]; then
  kp_add -u root --url "ssh://$IP" --notes "Deploy key path: $KEY"$'\n\n'"$(cat "$KEY")" "SSH deploy key"
else
  kp_add -u root --url "ssh://$IP" --notes "Deploy key path: ${KEY:-<none>} (key file not readable at generation time)" "SSH deploy key"
fi

# .onion
[ -n "$ONION" ] && kp_add -u admin --url "http://$ONION" --notes "Tor hidden service" ".onion"

# Deployed service URLs
kp_add -u admin --url "https://api.$DOMAIN" \
  --notes "Deployed services:"$'\n'"api.$DOMAIN"$'\n'"cloud.$DOMAIN"$'\n'"git.$DOMAIN"$'\n'"matrix.$DOMAIN"$'\n'"meet.$DOMAIN" \
  "Deployed URLs"

chmod 600 "$OUT"
echo "KeePassXC DB written: $OUT  (git-ignored)"
printf '%s\n' "$PW" | keepassxc-cli ls -q "$OUT" | sed 's/^/  entry: /'
