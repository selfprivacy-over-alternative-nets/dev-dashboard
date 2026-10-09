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
