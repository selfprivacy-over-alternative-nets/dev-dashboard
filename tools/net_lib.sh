#!/usr/bin/env bash
# Shared network probes for the installer tooling (sourced by finish_box_setup.sh, add-cloudflare.sh).

# Echo the box's ROUTABLE public IPv6, or "" if it has none. "Routable" = a global-unicast address
# (2000::/3 — excludes link-local fe80:: and ULA fd00::) on ANY interface, AND working v6 egress to
# the internet. IMPORTANT: this reflects the network the box is CURRENTLY on, so only run it after the
# box has rebooted onto its FINAL network (a different wifi/router gives a different answer).
#   box_global_ipv6 <box-ip> <ssh-key>
box_global_ipv6(){
  local ip="$1" key="${2/#\~/$HOME}"
  ssh -i "$key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o BatchMode=yes "root@$ip" "
    v=\$(ip -6 addr show scope global 2>/dev/null | awk '{print \$2}' | cut -d/ -f1 | grep -E '^[23]' | head -1)
    [ -n \"\$v\" ] && curl -6 -s --max-time 6 https://api64.ipify.org >/dev/null 2>&1 && printf '%s' \"\$v\"
  " 2>/dev/null
}

# The setup diagram's Reach (+ Name) for a public-access method → the `./dash run L3.…` args that select
# that matrix row (--reach [--name] --net). Args: method (tailscale|cloudflare|ipv6|router|none|''),
# cloudflare named? (1|0), domain (a *.duckdns.org name ⇒ --name duckdns, else a bought domain ⇒ buy).
#   reach_args <method> <cf-named> <domain>
reach_args(){
  local r=onion
  case "$1" in
    ngrok|pinggy|localtunnel) return 1;;   # no setup-diagram view → no matrix row
    tailscale)   echo "--reach tailscale --net https"; return;;
    cloudflare)  if [ "$2" = 1 ]; then echo "--reach cloudflare --name buy --net https"; else echo "--reach cloudflare --name trycf --net https"; fi; return;;
    ipv6)        r=ipv6;;
    router)      r=portfwd;;
    *)           echo "--reach onion --net tor"; return;;
  esac
  case "$3" in *.duckdns.org) echo "--reach $r --name duckdns --net https";; *) echo "--reach $r --name buy --net https";; esac
}
# One-hostname tunnels (Tailscale Funnel, Cloudflare quick) serve the API at the apex only; `dash` has no
# automated L3 over them yet (catalog reach_rows[].l3_wired) — use `./dash app … --apex` + `./dash report`.
# ngrok / pinggy / localtunnel have no setup-diagram view at all, so no matrix row either.
reach_l3_wired(){ case "$1" in tailscale|ngrok|pinggy|localtunnel) return 1;; cloudflare) [ "$2" = 1 ];; *) return 0;; esac; }
reach_in_diagram(){ case "$1" in ngrok|pinggy|localtunnel) return 1;; *) return 0;; esac; }

# The text of a command that READS the box API token over SSH — printed in hints instead of the token itself,
# so the secret never lands in a terminal transcript or a dash run log.   token_cmd <ssh-key> <box-ip>
token_cmd(){ printf '"$(ssh -i %s -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@%s %s)"' \
  "$1" "$2" "\"python3 -c 'import json;print(json.load(open(\\\"/etc/selfprivacy/secrets.json\\\"))[\\\"api\\\"][\\\"token\\\"])'\""; }
