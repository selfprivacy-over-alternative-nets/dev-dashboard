#!/usr/bin/env bash
# Tests tools/install_lib.sh without a stick or a box: a re-mastered image carries /sp/authorized_keys and (the real installer ISO)
# keeps its boot images; the read-back verify passes on a matching image and fails on one differing byte (on files, no sudo);
# discovery finds the one host that accepts the key (ssh faked, neighbours faked); the stamp pins come from a directory's lock and
# from the public repo (network).   bash tools/test_install_lib.sh [path-to-the-installer-iso]
set -u
HERE=$(cd "$(dirname "$0")" && pwd); . "$HERE/install_lib.sh"
bad=0; ok(){ echo "ok   $1"; }; fail(){ echo "FAIL $1"; bad=$((bad+1)); }
T=$(mktemp -d "${TMPDIR:-/tmp}/sp-lib-test.XXXX"); trap 'rm -rf "$T"' EXIT
# 1. the re-mastered image carries the key
echo "hello" > "$T/f"; printf 'ssh-ed25519 AAAATEST test@example\n' > "$T/key.pub"
sp_xorriso -outdev "$T/small.iso" -map "$T/f" /f >/dev/null 2>&1
if sp_remaster_iso "$T/small.iso" "$T/key.pub" "$T/small2.iso" >/dev/null && sp_xorriso -indev "$T/small2.iso" -osirrox on -extract /sp/authorized_keys "$T/got.pub" >/dev/null 2>&1 && cmp -s "$T/key.pub" "$T/got.pub"; then
  ok "re-mastering puts the public key at /sp/authorized_keys"; else fail "re-master a small iso"; fi
ISO=${1:-}
if [ -n "$ISO" ] && [ -f "$ISO" ]; then
  if sp_remaster_iso "$ISO" "$T/key.pub" "$T/real.iso" >/dev/null; then
    b1=$(sp_xorriso -indev "$ISO" -report_el_torito plain 2>/dev/null | grep -c 'El Torito boot img')
    b2=$(sp_xorriso -indev "$T/real.iso" -report_el_torito plain 2>/dev/null | grep -c 'El Torito boot img')
    if [ "$b1" -gt 0 ] && [ "$b1" = "$b2" ]; then ok "the real installer ISO keeps its $b1 boot image(s) after re-mastering"; else fail "boot images $b1 → $b2"; fi
    rm -f "$T/real.iso"
  else fail "re-master the real iso"; fi
else echo "skip  the real-ISO test (no ISO given)"; fi
# 2. the read-back verify, on files
cp "$T/small2.iso" "$T/dev"; printf 'tail' >> "$T/dev"
if SP_SUDO= sp_verify_written "$T/small2.iso" "$T/dev" >/dev/null; then ok "verify: a device that starts with the image passes"; else fail "verify pass"; fi
printf 'x' | dd of="$T/dev" bs=1 seek=100 conv=notrunc 2>/dev/null
if SP_SUDO= sp_verify_written "$T/small2.iso" "$T/dev" >/dev/null 2>&1; then fail "verify should fail on a differing byte"; else ok "verify: one differing byte fails"; fi
# 3. discovery: a fake ssh that accepts the key only from root@10.9.9.9, fake neighbours, no sweep
mkdir -p "$T/bin"; printf '#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = "root@10.9.9.9" ] && exit 0; done; exit 255\n' > "$T/bin/ssh"; chmod +x "$T/bin/ssh"
hit=$(PATH="$T/bin:$PATH" SP_SWEEP=0 SP_NEIGH_CMD="printf '10.9.9.8 dev eth0 lladdr aa:aa:aa:aa:aa:08 STALE\n10.9.9.9 dev eth0 lladdr aa:aa:aa:aa:aa:09 REACHABLE\n10.9.9.7 dev eth0  FAILED\n'" sp_discover_by_key "$T/key" 5)
if [ "$hit" = "10.9.9.9 aa:aa:aa:aa:aa:09" ]; then ok "discovery: the one host that accepts the key, with its MAC"; else fail "discovery got '$hit'"; fi
hit=$(PATH="$T/bin:$PATH" SP_SWEEP=0 SP_NEIGH_CMD="printf '10.9.9.8 dev eth0 lladdr aa:aa:aa:aa:aa:08 STALE\n'" sp_discover_by_key "$T/key" 1) && fail "discovery should give up" || ok "discovery: gives up after its time when no host accepts the key"
# 4. the pins for the stamp
p=$(sp_pins_from_flake "$HERE/../../Manager-Ubuntu-SelfPrivacy-Over-Tor/backend")
if echo "$p" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert set(d["pins"])=={"selfprivacy-api","nixpkgs"} and all(len(v)>=12 for v in d["pins"].values())' 2>/dev/null; then ok "pins from a directory's flake.lock"; else fail "pins dir: $p"; fi
p=$(sp_pins_from_flake "github:selfprivacy-over-tor/Manager-Ubuntu-SelfPrivacy-Over-Tor?dir=backend#packages.x86_64-linux.default")
if echo "$p" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["revision"] and set(d["pins"])=={"selfprivacy-api","nixpkgs"}' 2>/dev/null; then ok "pins from the public repo (git), with its revision"; else fail "pins git: $p"; fi
echo; if [ "$bad" = 0 ]; then echo "all good"; else echo "$bad problem(s)"; fi; exit $(( bad > 0 ))
