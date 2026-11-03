#!/bin/bash
# shot.sh <out-dir> <name> '<state json>'  → static SVG + full-size PNG of that view in <out-dir> (every argument required)
# e.g.  checks/shot.sh /tmp/shots cable0a '{"method":"cable","net":"0a","reach":"tailscale"}'
[ $# -eq 3 ] || { sed -n '2,3p' "$0"; exit 2; }
S=$1; mkdir -p "$S"
cd "$(dirname "$0")/.." || exit 1   # dev-dashboard
python3 checks/render_state.py . "$3" "$S/$2.svg" || exit 1
read W H < <(python3 -c "import re;s=open('$S/$2.svg').read(400);m=re.search(r'width=\"([\d.]+)\" height=\"([\d.]+)\"',s);print(int(float(m.group(1)))+1,int(float(m.group(2)))+1)")
timeout 60 nix shell nixpkgs#chromium -c chromium --headless=new --no-sandbox --disable-gpu --user-data-dir="$S/chr" --window-size=$W,$H --screenshot="$S/$2.png" "file://$S/$2.svg" >/dev/null 2>&1
echo "$S/$2.png ${W}x${H}"
