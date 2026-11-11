#!/usr/bin/env bash
# install_lib.sh — the pieces of the USB-stick install chain that can be tested on their own (tools/test_install_lib.sh):
#   sp_remaster_iso    <in.iso> <pubkey> <out.iso>  put THIS install's public key into the installer image (/sp/authorized_keys)
#   sp_unmount_all     <disk>                       unmount every mounted partition of the stick before it is written
#   sp_verify_written  <iso> <disk>                 read the stick back: it must hold the image byte for byte
#   sp_discover_by_key <key> [seconds]              the one host on the LAN that accepts this install's key → "IP MAC" (req 190)
#   sp_pins_from_flake <flake url | dir>            {"flake","revision","pins":{…}} for the box's build stamp — from git, or a dir's lock
# Sourced by tools/e2e_install_usb.sh. Every function prints what it did; none asks a question. SP_SUDO (default sudo) runs what
# needs root; the test sets it empty and works on files.
sp_xorriso(){ if command -v xorriso >/dev/null 2>&1; then xorriso "$@"; else nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#xorriso -c xorriso "$@"; fi; }

sp_remaster_iso(){   # the image from the public repo + this install's public key = the stick's image: the live installer and the
  local in="$1" pub="$2" out="$3"   # installed server trust only that key (backend/nixos/sp-install-key.nix reads /iso/sp/authorized_keys)
  [ -f "$in" ] && [ -f "$pub" ] || { echo "remaster: missing $in or $pub"; return 1; }
  rm -f "$out"
  sp_xorriso -indev "$in" -outdev "$out" -boot_image any replay -map "$pub" /sp/authorized_keys >/dev/null 2>&1 || { echo "remaster: xorriso failed"; return 1; }
  sp_xorriso -indev "$out" -find /sp/authorized_keys 2>/dev/null | grep -q authorized_keys || { echo "remaster: /sp/authorized_keys not in $out"; return 1; }
  echo "   installer image with this install's key: $out"
}

sp_unmount_all(){   # a stick that is opened on this computer has mounted partitions; dd needs them unmounted
  local disk="$1" p
  for p in $(findmnt -rn -o SOURCE 2>/dev/null | grep -E "^${disk}(p?[0-9]+)?$" | sort -u); do
    udisksctl unmount -b "$p" >/dev/null 2>&1 || ${SP_SUDO-sudo} umount "$p" || { echo "could not unmount $p"; return 1; }
    echo "   unmounted $p"
  done
}

sp_verify_written(){   # after dd: the first <image size> bytes of the stick are the image
  local iso="$1" dev="$2" n
  n=$(stat -c %s "$iso")
  if ${SP_SUDO-sudo} cmp -n "$n" "$iso" "$dev" >/dev/null 2>&1; then echo "   verified: $dev holds the image byte for byte ($n bytes)"; return 0; fi
  echo "VERIFY FAILED: $dev does not hold $iso — do not boot from it"; return 1
}

sp_discover_by_key(){   # the server is the ONE host on the LAN that accepts this install's key (nothing else has it): sweep every local
  local key="$1" secs="${2:-600}" t0 p n hit   # /24 so the neighbours are known, then try the key on each in parallel; "IP MAC" on stdout
  t0=$(date +%s)
  while :; do
    if [ "${SP_SWEEP:-1}" = 1 ]; then
      for p in $(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | awk -F/ '{print $1}' | awk -F. '/^10\.|^192\.168\.|^172\./{print $1"."$2"."$3}' | sort -u); do
        for n in $(seq 1 254); do ping -c1 -W1 "$p.$n" >/dev/null 2>&1 & done; wait 2>/dev/null || true
      done
    fi
    hit=$(eval "${SP_NEIGH_CMD:-ip neigh}" 2>/dev/null | awk '$4=="lladdr"{print $1" "$5}' | sort -u |
      xargs -r -P 32 -n 2 sh -c 'ssh -i "$0" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "root@$1" true >/dev/null 2>&1 && echo "$1 $2"' "$key" 2>/dev/null | head -1)
    [ -n "$hit" ] && { echo "$hit"; return 0; }
    [ $(( $(date +%s) - t0 )) -ge "$secs" ] && return 1
    sleep 5
  done
}

sp_pins_from_flake(){   # the build identity for the stamp: the lock of the flake the image came from — a git URL (nix flake metadata
  local f="${1%%#*}"      # needs no checkout) or a directory's flake.lock
  if [ -d "$f" ] && [ -f "$f/flake.lock" ]; then
    python3 - "$f" <<'PY'
import json, sys
f = sys.argv[1]; n = json.load(open(f + "/flake.lock")).get("nodes", {})
print(json.dumps({"flake": f, "revision": "", "pins": {k: (n.get(k, {}).get("locked") or {}).get("rev", "unknown") for k in ("selfprivacy-api", "nixpkgs")}}))
PY
  else
    nix --extra-experimental-features 'nix-command flakes' flake metadata --json "$f" 2>/dev/null | python3 -c '
import json, sys
m = json.load(sys.stdin); n = m.get("locks", {}).get("nodes", {})
print(json.dumps({"flake": m.get("resolvedUrl") or m.get("url", ""), "revision": m.get("revision", ""), "pins": {k: (n.get(k, {}).get("locked") or {}).get("rev", "unknown") for k in ("selfprivacy-api", "nixpkgs")}}))'
  fi
}
