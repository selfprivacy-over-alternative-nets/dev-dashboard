#!/usr/bin/env bash
# retarget_device.sh — point the direct-cable netboot + deploy rig at a NEW target device,
# with no AI/manual guesswork. It discovers the target's NIC MAC + disks from the running
# netboot installer over SSH, then rewrites the two hardware-specific files:
#   1) the netboot DHCP pin   (~/netboot/dnsmasq.conf : dhcp-host=<MAC>,<PIN_IP>)
#   2) the deploy disk layout (selfprivacy-altnet-deployer/disko.nix : OS disk, optional storage disk, by-id)
#
# Why this exists: the rig is hardwired to one machine (a MAC pin + specific disk serials). A
# different target won't get the pinned installer IP and disko fails on missing disks. This makes
# retargeting a single written command instead of a hand-edit.
#
# PREREQUISITE: the new target must have netbooted ONCE already (so the installer is up + SSH-
# reachable and it has a DHCP lease). Flow: cable it to this laptop's netboot NIC, start the
# netboot server, boot the target into UEFI IPv4 network boot, wait for the installer, then run this.
#
# All inputs are explicit (reproducibility): required vars fail fast telling you what to set.
#
# Required:
#   TARGET_IP   the netbooted installer's current IP, or `auto` to read the newest non-pinned
#               lease from $LEASES (e.g. TARGET_IP=auto  or  TARGET_IP=192.168.100.37)
#   KEY         ssh key that the installer authorizes (e.g. KEY=$HOME/.ssh/pcname_ed25519)
# Optional (sane, explicit defaults):
#   OS_DISK      which disk gets the OS — a serial, a /dev/disk/by-id/NAME, or a disk name (sda,
#                nvme0n1). Default: auto = the largest INTERNAL (non-USB, non-removable) disk.
#   STORAGE_DISK a 2nd disk mounted at /mnt/storage (nofail). Default: none → single-disk layout.
#   PIN_IP       the fixed installer IP to pin the MAC to (default 192.168.100.50).
#   DNSMASQ      path to the netboot dnsmasq.conf (default ~/netboot/dnsmasq.conf).
#   DISKO        path to the deploy disko.nix     (default <repo>/selfprivacy-altnet-deployer/disko.nix).
#   LEASES       dnsmasq lease file for TARGET_IP=auto (default /tmp/netboot-leases).
#   NETBOOT_SCRIPT path to the netboot server launcher (default ~/netboot/start-netboot-server.sh).
#   ASSUME_YES=1 skip the "about to WIPE disk X" confirmation (default: ask).
#   RESTART_NETBOOT=1 restart the netboot server so the new MAC pin loads now (default: just tell you).
set -euo pipefail

TARGET_IP=${TARGET_IP:?required: netbooted installer IP, or 'auto' (e.g. TARGET_IP=auto or TARGET_IP=192.168.100.37)}
KEY=${KEY:?required: ssh key the installer authorizes, e.g. KEY=$HOME/.ssh/pcname_ed25519}
PIN_IP=${PIN_IP:-192.168.100.50}
OS_DISK=${OS_DISK:-auto}
STORAGE_DISK=${STORAGE_DISK:-}
DNSMASQ=${DNSMASQ:-$HOME/netboot/dnsmasq.conf}
LEASES=${LEASES:-/tmp/netboot-leases}
NETBOOT_SCRIPT=${NETBOOT_SCRIPT:-$HOME/netboot/start-netboot-server.sh}
ASSUME_YES=${ASSUME_YES:-}
RESTART_NETBOOT=${RESTART_NETBOOT:-}

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DISKO=${DISKO:-$(cd "$SELF_DIR/../.." && pwd)/selfprivacy-altnet-deployer/disko.nix}

say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
die(){ printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$DNSMASQ" ] || die "dnsmasq.conf not found: $DNSMASQ (set DNSMASQ=)"
[ -f "$DISKO" ]   || die "disko.nix not found: $DISKO (set DISKO=)"
KEY=${KEY/#\~/$HOME}
[ -f "$KEY" ] || die "ssh key not found: $KEY"

# ── Resolve the installer IP ─────────────────────────────────────────────────
if [ "$TARGET_IP" = auto ]; then
  [ -f "$LEASES" ] || die "no lease file $LEASES — boot the target into netboot first (TARGET_IP=auto reads it)."
  TARGET_IP=$(awk -v pin="$PIN_IP" '$3!=pin && $3 ~ /\./ {print $1, $3}' "$LEASES" | sort -n | tail -1 | awk '{print $2}')
  [ -n "$TARGET_IP" ] || die "no non-pinned lease in $LEASES — is the target netbooted? (only the pinned $PIN_IP is present)"
  echo "auto-selected newest netboot lease: $TARGET_IP"
fi

SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o BatchMode=yes "root@$TARGET_IP")
"${SSH[@]}" true 2>/dev/null || die "cannot SSH root@$TARGET_IP with $KEY — is the installer up and is this the right key? (the netboot installer authorizes the deploy key)"

# ── Discover MAC + disks from the live installer ─────────────────────────────
say "discovering target hardware over SSH (root@$TARGET_IP)"
SUB=${PIN_IP%.*}   # e.g. 192.168.100
REMOTE='
set -e
sub="$1"
ifc=$(ip -o -4 addr show | awk -v s="${sub}." "\$4 ~ s {print \$2; exit}")
[ -n "$ifc" ] || { echo "ERR no NIC on ${sub}.0/24 (the netboot link)"; exit 3; }
echo "MAC $(cat /sys/class/net/$ifc/address) $ifc"
echo "DISKS_BEGIN"
for d in $(lsblk -dn -o NAME,TYPE | awk "\$2==\"disk\"{print \$1}"); do
  size=$(lsblk -dn -b -o SIZE /dev/$d)
  tran=$(lsblk -dn -o TRAN /dev/$d | tr -d " ")
  rmv=$(lsblk -dn -o RM /dev/$d | tr -d " ")
  model=$(lsblk -dn -o MODEL /dev/$d | sed "s/ *$//; s/ /_/g")
  serial=$(lsblk -dn -o SERIAL /dev/$d | tr -d " ")
  byid=""
  for pref in nvme- ata- wwn- scsi-; do
    for l in /dev/disk/by-id/${pref}*; do
      [ -e "$l" ] || continue
      case "$l" in *-part*) continue;; esac
      [ "$(readlink -f "$l")" = "/dev/$d" ] && { byid="$l"; break 2; }
    done
  done
  echo "DISK $d|$size|$tran|$rmv|$model|$serial|$byid"
done
echo "DISKS_END"
'
OUT=$(printf '%s' "$REMOTE" | "${SSH[@]}" "bash -s -- '$SUB'") || die "hardware discovery failed on the target"

MAC=$(awk '/^MAC /{print $2; exit}' <<<"$OUT")
NICIF=$(awk '/^MAC /{print $3; exit}' <<<"$OUT")
[ -n "$MAC" ] || die "could not read the target's NIC MAC on the $SUB.0/24 link"
mapfile -t DISKLINES < <(awk '/^DISK /{sub(/^DISK /,""); print}' <<<"$OUT")
[ "${#DISKLINES[@]}" -gt 0 ] || die "no disks found on the target"

echo "target NIC: $NICIF  MAC $MAC"
echo "disks on the target:"
printf '   %-12s %-10s %-6s %-4s %-24s %-20s %s\n' NAME SIZE TRAN RM MODEL SERIAL BY-ID
for l in "${DISKLINES[@]}"; do
  IFS='|' read -r name size tran rmv model serial byid <<<"$l"
  printf '   %-12s %-10s %-6s %-4s %-24s %-20s %s\n' "$name" "$(numfmt --to=iec "$size" 2>/dev/null || echo "$size")" "${tran:--}" "$rmv" "${model:--}" "${serial:--}" "${byid:--}"
done

# ── Pick the OS disk (and optional storage disk) ─────────────────────────────
# match a selector ("auto" | serial | by-id | name) against the discovered table → prints byid.
pick_disk(){
  local sel="$1" want_internal="$2" exclude_byid="${3:-}"
  local best_byid="" best_size=-1
  for l in "${DISKLINES[@]}"; do
    IFS='|' read -r name size tran rmv model serial byid <<<"$l"
    [ -n "$byid" ] || continue
    [ "$byid" = "$exclude_byid" ] && continue
    if [ "$sel" = auto ]; then
      [ "$want_internal" = 1 ] && { [ "$rmv" = 1 ] && continue; [ "$tran" = usb ] && continue; }
      if [ "$size" -gt "$best_size" ]; then best_size=$size; best_byid=$byid; fi
    else
      case "$sel" in
        /dev/disk/by-id/*) [ "$byid" = "$sel" ] && { echo "$byid"; return 0; } ;;
        *) { [ "$serial" = "$sel" ] || [ "$name" = "$sel" ] || [ "$(basename "$byid")" = "$sel" ]; } && { echo "$byid"; return 0; } ;;
      esac
    fi
  done
  [ -n "$best_byid" ] && { echo "$best_byid"; return 0; }
  return 1
}

OS_BYID=$(pick_disk "$OS_DISK" 1 "") || die "could not resolve OS_DISK='$OS_DISK' to a disk with a stable by-id (see the table above; pass OS_DISK=<serial|by-id|name>)."
STORAGE_BYID=""
if [ -n "$STORAGE_DISK" ]; then
  STORAGE_BYID=$(pick_disk "$STORAGE_DISK" 0 "$OS_BYID") || die "could not resolve STORAGE_DISK='$STORAGE_DISK' (see table)."
fi

OS_MODEL=$(for l in "${DISKLINES[@]}"; do IFS='|' read -r n s t r m se b <<<"$l"; [ "$b" = "$OS_BYID" ] && echo "${m:--}_${se:--}"; done)

say "plan"
echo "  netboot pin : MAC $MAC  ->  $PIN_IP      (in $DNSMASQ)"
echo "  OS disk     : $OS_BYID   ($OS_MODEL)   ← WILL BE WIPED   (in $DISKO)"
[ -n "$STORAGE_BYID" ] && echo "  storage disk: $STORAGE_BYID  ← WILL BE WIPED (mounted /mnt/storage, nofail)" || echo "  storage disk: none (single-disk layout)"

if [ -z "$ASSUME_YES" ]; then
  printf '\nProceed — rewrite the two files and WIPE-target the disk(s) above? [y/N] '
  read -r ans </dev/tty || ans=""
  case "$ans" in y|Y|yes|YES) ;; *) die "aborted (nothing changed)";; esac
fi

# ── 1) dnsmasq.conf: replace the MAC on the ,<PIN_IP> pin line (append if absent) ────
cp -a "$DNSMASQ" "$DNSMASQ.bak"
awk -v mac="$MAC" -v ip="$PIN_IP" '
  $0 ~ ("^dhcp-host=.*," ip "$") { print "dhcp-host=" mac "," ip; done=1; next }
  { print }
  END { if (!done) print "dhcp-host=" mac "," ip }
' "$DNSMASQ.bak" > "$DNSMASQ"
grep -qxF "dhcp-host=$MAC,$PIN_IP" "$DNSMASQ" || die "failed to write the dhcp-host pin into $DNSMASQ"
echo "updated $DNSMASQ  (backup: $DNSMASQ.bak)"

# ── 2) disko.nix: regenerate from a known-good template (single or dual disk, by-id) ──
cp -a "$DISKO" "$DISKO.bak"
{
  echo '{'
  echo "  # GENERATED by tools/retarget_device.sh for target MAC $MAC."
  echo '  # Disks addressed by STABLE by-id (never /dev/sdX — letters reorder between boots).'
  echo '  # WIPED on install. Re-run retarget_device.sh to change the target.'
  echo '  disko.devices.disk = {'
  echo '    main = {'
  echo '      type = "disk";'
  echo "      device = \"$OS_BYID\";"
  echo '      content = {'
  echo '        type = "gpt";'
  echo '        partitions = {'
  echo '          ESP = {'
  echo '            size = "512M";'
  echo '            type = "EF00";'
  echo '            content = {'
  echo '              type = "filesystem";'
  echo '              format = "vfat";'
  echo '              mountpoint = "/boot";'
  echo '              mountOptions = [ "umask=0077" ];'
  echo '            };'
  echo '          };'
  echo '          root = {'
  echo '            size = "100%";'
  echo '            content = {'
  echo '              type = "filesystem";'
  echo '              format = "ext4";'
  echo '              mountpoint = "/";'
  echo '            };'
  echo '          };'
  echo '        };'
  echo '      };'
  echo '    };'
  if [ -n "$STORAGE_BYID" ]; then
  echo ''
  echo '    # Extra storage. nofail so a bad/absent disk can never block boot of a headless box.'
  echo '    storage = {'
  echo '      type = "disk";'
  echo "      device = \"$STORAGE_BYID\";"
  echo '      content = {'
  echo '        type = "gpt";'
  echo '        partitions = {'
  echo '          data = {'
  echo '            size = "100%";'
  echo '            content = {'
  echo '              type = "filesystem";'
  echo '              format = "ext4";'
  echo '              mountpoint = "/mnt/storage";'
  echo '              mountOptions = [ "nofail" "x-systemd.device-timeout=5" ];'
  echo '            };'
  echo '          };'
  echo '        };'
  echo '      };'
  echo '    };'
  fi
  echo '  };'
  echo '}'
} > "$DISKO"
grep -qF "$OS_BYID" "$DISKO" || die "failed to write the OS disk into $DISKO"
echo "updated $DISKO  (backup: $DISKO.bak)"

# ── Restart the netboot server so the new MAC pin is served (or tell the user) ───────
if [ -n "$RESTART_NETBOOT" ]; then
  say "restarting the netboot server (sudo) so the new MAC pin loads"
  sudo pkill -x dnsmasq 2>/dev/null || true
  if [ -f "$NETBOOT_SCRIPT" ]; then
    sudo bash "$NETBOOT_SCRIPT" >/tmp/netboot-server.log 2>&1 &
    sleep 2; echo "netboot server restarted (log: /tmp/netboot-server.log)"
  else
    echo "NETBOOT_SCRIPT not found ($NETBOOT_SCRIPT) — restart it yourself."
  fi
fi

say "done — next steps"
cat <<EOF
  1) ${RESTART_NETBOOT:+(netboot server already restarted)}${RESTART_NETBOOT:-Restart the netboot server so the new MAC pin loads:}
     ${RESTART_NETBOOT:+}${RESTART_NETBOOT:-sudo pkill -x dnsmasq; sudo bash $NETBOOT_SCRIPT}
  2) Reboot the target into UEFI network boot again — it now leases the pinned $PIN_IP.
  3) Install (box token/cert are seeded from the flake's state/extra):
     ./dash run install.lan-setup-0 --ip $PIN_IP --key $KEY \\
       --env FLAKE=\$(cd "$(dirname "$DISKO")" && pwd) --env MAC=$MAC \\
       --env DOMAIN=weersurf.nl --env NETBOOT=auto --env TRANSPORT=none
EOF
