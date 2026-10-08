#!/usr/bin/env bash
# Shared input VALIDATORS for the interactive installers (add-cloudflare.sh, resolve_flake.sh, …).
# The reusable rules live here; each PROMPT still declares its own allowed set inline — validation is
# per-question, but the building blocks are shared (sourced by both scripts). All return 0 = valid.

# A syntactically plausible DNS domain: 2+ dot-separated labels, a 2+ letter TLD, labels alnum/hyphen.
is_domain(){ [[ "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?[.])+[a-zA-Z]{2,}$ ]]; }

# A single DNS label (e.g. a localtunnel/pinggy subdomain prefix): alnum + hyphen, not edge-hyphen.
is_label(){ [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]]; }

# A WPA/WPA2 pre-shared key: an 8–63 char passphrase, or a 64-hex raw PSK.
is_wpa_psk(){ local p="$1" n=${#1}
  { [ "$n" -ge 8 ] && [ "$n" -le 63 ]; } && return 0
  [ "$n" -eq 64 ] && [[ "$p" =~ ^[0-9a-fA-F]{64}$ ]]; }

# Normalise a yes/no answer: echoes "yes" / "no", or "" if the input is neither (caller re-asks).
yesno(){ case "${1,,}" in y|yes) echo yes;; ""|n|no) echo no;; *) echo "";; esac; }
