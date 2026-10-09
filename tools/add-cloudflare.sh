#!/usr/bin/env bash
# add-cloudflare.sh — give a SelfPrivacy box PUBLIC https reachability WITHOUT needing admin on the
# upstream router (the box dials OUT, nothing is forwarded IN — this is what beats double-NAT /
# third-party gateways).
#
# TWO phases, because the public-access method DECIDES THE DOMAIN, and the domain is baked into the
# box at deploy time (vhost routing + LE cert) — so the choice must be made UP-FRONT, not at the end:
#
#   --plan   (early, no box)  Ask the 3 questions, decide METHOD + DOMAIN, print them as KEY=VALUE on
#                             stdout for the installer to consume. Run by resolve_flake.sh at the
#                             "your web address" prompt, right after the device is connected.
#   (apply)  (end, box up)    Actually configure the chosen tunnel/route ON THE BOX over SSH.
#
# The 3 questions (reqs 125-131):
#   Q1 paid domain?   -> we print the exact DNS records to set.
#   Q2 free domain?   -> a quick/pinggy/localtunnel tunnel needs NONE (random *.trycloudflare.com /
#                        *.pinggy.link / *.loca.lt); a free CUSTOM domain comes from a source you pick
#                        (nic.eu.org = delegable to Cloudflare; DuckDNS/afraid = router method only).
#   Q3 transport?     -> cloudflare | tailscale | ipv6 | ngrok | pinggy | localtunnel | router | none (free).
#
# Standalone / non-interactive apply (every choice explicit, no silent defaults):
#   bash tools/add-cloudflare.sh --key ~/.ssh/pcname_ed25519 --ip 192.168.1.167 \
#        --method cloudflare --domain-kind free [--cf-named|--cf-quick] [--domain example.com] \
#        [--ngrok-token <tok>] [--setup lan-setup-0a]
#   bash tools/add-cloudflare.sh --plan --default-domain example.com      # decide early, no box
#
# --key/--ip are required to APPLY; --plan needs neither.
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prompt_lib.sh"   # shared input validators (is_domain, …)
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/net_lib.sh"      # box_global_ipv6 (routable-IPv6 autodetect)

PLAN=0; KEY=""; IP=""; METHOD=""; DOMAIN_KIND=""; DOMAIN=""; CF_MODE=""; NGROK_TOKEN=""; CF_TUNNEL_TOKEN=""
PINGGY_TOKEN=""; LT_SUBDOMAIN=""; DOMAIN_SOURCE=""; DUCKDNS_TOKEN=""; TAILSCALE_AUTHKEY=""
DEFAULT_DOMAIN=""; SETUP="${SP_SETUP:-lan-setup-0a}"
while [ $# -gt 0 ]; do
  case "$1" in
    --plan)           PLAN=1;            shift 1;;
    --key)            KEY="$2";          shift 2;;
    --ip)             IP="$2";           shift 2;;
    --method)         METHOD="$2";       shift 2;;   # cloudflare | ngrok | router | none
    --domain-kind)    DOMAIN_KIND="$2";  shift 2;;   # paid | free | none
    --domain)         DOMAIN="$2";       shift 2;;
    --cf-named)       CF_MODE=named;     shift 1;;    # Cloudflare NAMED tunnel (custom domain, all subs)
    --cf-quick)       CF_MODE=quick;     shift 1;;    # Cloudflare QUICK tunnel (free *.trycloudflare.com)
    --ngrok-token)    NGROK_TOKEN="$2";  shift 2;;
    --cf-tunnel-token) CF_TUNNEL_TOKEN="$2"; shift 2;; # Cloudflare tunnel connector token (headless named tunnel)
    --pinggy-token)   PINGGY_TOKEN="$2";  shift 2;;   # pinggy.io token (persistent + custom *.pinggy.link)
    --lt-subdomain)   LT_SUBDOMAIN="$2";  shift 2;;   # localtunnel requested subdomain prefix
    --domain-source)  DOMAIN_SOURCE="$2"; shift 2;;   # eu-org | duckdns | afraid | other (free-domain source)
    --duckdns-token)  DUCKDNS_TOKEN="$2"; shift 2;;   # DuckDNS token (auto-update the A/AAAA record)
    --tailscale-authkey) TAILSCALE_AUTHKEY="$2"; shift 2;;  # Tailscale auth key (tskey-auth-…) for Funnel
    --default-domain) DEFAULT_DOMAIN="$2"; shift 2;;  # suggested domain (plan only)
    --setup)          SETUP="$2";        shift 2;;
    -h|--help)        sed -n '2,38p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
if [ "$PLAN" = 0 ]; then
  [ -n "$KEY" ] || { echo "required to apply: --key <ssh deploy key>" >&2; exit 2; }
  [ -n "$IP"  ] || { echo "required to apply: --ip <box LAN IP> (its 192.168.x.x address, to SSH in — not a public IP)" >&2; exit 2; }
  KEY=${KEY/#\~/$HOME}
fi

# interactive = is a terminal attached at all (stdout may be captured in --plan, so test /dev/tty)
INTERACTIVE=0; if { true >/dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

G=$'\e[32m'; C=$'\e[36m'; B=$'\e[1m'; R=$'\e[31m'; Y=$'\e[33m'; GR=$'\e[90m'; X=$'\e[0m'
msg(){ printf '%s\n' "$*" >&2; }                                   # human output -> stderr (safe in --plan)
say(){ printf '\n%s== %s ==%s\n' "$B" "$*" "$X" >&2; }
ask(){ local p="$1" v=""; printf '%s' "$p" >&2; { read -r v </dev/tty; } 2>/dev/null || v=""; printf '%s' "$v"; }
need(){ local val="$1" flag="$2" prompt="$3"
  if [ -z "$val" ]; then
    if [ "$INTERACTIVE" = 1 ]; then val=$(ask "$prompt"); else
      msg "${R}non-interactive: missing required choice '$flag' (no default — pass it explicitly)${X}"; exit 2; fi
  fi; printf '%s' "$val"; }
SSHO="-i ${KEY:-/dev/null} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o BatchMode=yes"
box(){ ssh $SSHO "root@$IP" "$@"; }
box_tty(){ ssh -t $SSHO "root@$IP" "$@"; }
putfile(){ ssh $SSHO "root@$IP" "cat > '$1'"; }
NIXX="nix --extra-experimental-features 'nix-command flakes'"
SUBS=(api cloud git matrix meet)

# Free-domain SOURCE menu (used when a free CUSTOM domain is wanted). Sets DOMAIN_SOURCE.
pick_domain_source(){ local ctx="$1" a   # ctx: tunnel (needs NS delegation) | router (A-record only)
  [ -n "$DOMAIN_SOURCE" ] && return 0
  [ "$INTERACTIVE" = 1 ] || { DOMAIN_SOURCE=eu-org; return 0; }
  msg "    Free-domain source:"
  msg "      ${B}1) nic.eu.org${X}  a real DELEGABLE domain (NS → Cloudflare) — works with tunnels AND router; SLOW manual approval (days)."
  msg "      ${B}2) duckdns${X}     *.duckdns.org — INSTANT, but A/TXT only (no NS delegation): ${Y}router method only, not a Cloudflare tunnel${X}."
  msg "      ${B}3) afraid${X}      freedns.afraid.org — instant free subdomains; like DuckDNS, router-method only."
  msg "      ${B}4) other${X}       a domain you already control somewhere else."
  a=$(ask "      choose 1-4 [1]: ")
  case "$a" in 2|duckdns) DOMAIN_SOURCE=duckdns;; 3|afraid) DOMAIN_SOURCE=afraid;; 4|other) DOMAIN_SOURCE=other;; *) DOMAIN_SOURCE=eu-org;; esac
  if [ "$ctx" = tunnel ] && [ "$DOMAIN_SOURCE" != eu-org ] && [ "$DOMAIN_SOURCE" != other ]; then
    msg "      ${Y}$DOMAIN_SOURCE can't host a Cloudflare tunnel (no NS delegation) — use nic.eu.org for a tunnel, or pick the router method.${X}"
  fi; }

# ── interactive wizard with single-step BACK navigation ──────────────────────────────────────────
# Type  <  (or 'back') at any decision to step back one question. (A literal Backspace key can't be
# caught in a line-based shell read, so '<' is the back key.) Runs ONLY in a from-scratch interactive
# session; non-interactive / flag-driven runs use the plain logic below (unchanged). Never covers the
# install/deploy itself — those are the irreversible steps and happen later, outside this wizard.
BACK=$'\x02BACK'
askb(){ local v; v=$(ask "$1"); case "$v" in '<'|back|Back|BACK) printf '%s' "$BACK";; *) printf '%s' "$v";; esac; }
run_wizard(){
  local st=method a d bk="${GR}[ < = back ]${X}"
  while :; do
    case "$st" in
      method)   # rule: one of 1-8 / a transport name. empty or anything else → re-ask.
        msg "  ${B}1) cloudflare${X}   Cloudflare Tunnel — FREE, outbound, works behind CGNAT (centralised)"
        msg "  ${B}2) tailscale${X}    Tailscale Funnel — FREE stable https://<name>.ts.net, valid cert, no port-forward, CGNAT-proof (recommended)"
        msg "  ${B}3) ipv6${X}         Direct IPv6 — DECENTRALISED, free, no relay/port-forward (needs ISP IPv6)"
        msg "  ${B}4) ngrok${X}        ngrok — free tier = 1 static *.ngrok-free.app (browser interstitial)"
        msg "  ${B}5) pinggy${X}       Pinggy — SSH-based, nothing to install; free random *.pinggy.link (~60 min)"
        msg "  ${B}6) localtunnel${X}  LocalTunnel — free *.loca.lt with a custom prefix"
        msg "  ${B}7) router${X}       forward :443 on your own router (needs router admin)"
        msg "  ${B}8) none${X}         LAN / .onion only — just set my domain"
        a=$(askb "    choose 1-8 (or name): ")
        [ "$a" = "$BACK" ] && { msg "${GR}  (already at the first question)${X}"; continue; }
        case "${a,,}" in 1|cloudflare|c) METHOD=cloudflare;; 2|tailscale|ts|t) METHOD=tailscale;; 3|ipv6|v6) METHOD=ipv6;; 4|ngrok|n) METHOD=ngrok;; 5|pinggy|p) METHOD=pinggy;; 6|localtunnel|lt|l) METHOD=localtunnel;; 7|router|r) METHOD=router;; 8|none|skip) METHOD=none;; *) msg "${Y}  please choose 1-8 (or a name from the list)${X}"; continue;; esac
        CF_MODE=""; DOMAIN=""; DOMAIN_KIND=""; DOMAIN_SOURCE=""; LT_SUBDOMAIN=""   # fresh start for this method
        case "$METHOD" in cloudflare) st=cfmode;; ipv6|router) st=dkind;; ngrok) st=ngd;; localtunnel) st=lts;; pinggy|tailscale) DOMAIN_KIND=none; st=done;; none) st=noned;; esac ;;
      cfmode)   # rule: A or B (empty = A, the shown default). anything else → re-ask.
        msg ""
        msg "  ${B}A)${X} free throwaway ${C}*.trycloudflare.com${X} — no domain, ONE service, temporary"
        msg "  ${B}B)${X} a stable ${B}custom domain${X} — all 5 services, survives restarts"
        a=$(askb "    choose A or B [A]  $bk: ")
        [ "$a" = "$BACK" ] && { st=method; continue; }
        case "${a,,}" in ""|a) CF_MODE=quick; DOMAIN=""; st=done;; b) CF_MODE=named; st=dkind;; *) msg "${Y}    please type A or B${X}"; continue;; esac ;;
      dkind)    # rule: exactly 'paid' or 'free'. no silent default — anything else → re-ask.
        a=$(askb "    Do you OWN the domain (paid), or want a FREE one? [paid/free]  $bk: ")
        [ "$a" = "$BACK" ] && { [ "$METHOD" = cloudflare ] && st=cfmode || st=method; continue; }
        case "${a,,}" in free|f) DOMAIN_KIND=free; st=dsrc;; paid|p) DOMAIN_KIND=paid; st=dval;; *) msg "${Y}    please type 'paid' or 'free'${X}"; continue;; esac ;;
      dsrc)     # rule: 1-4 / a source name (empty = 1, the shown default). anything else → re-ask.
        msg "    Free-domain source:"
        msg "      ${B}1) nic.eu.org${X}  delegable NS → works with tunnels AND router; SLOW approval (days)"
        msg "      ${B}2) duckdns${X}     *.duckdns.org — instant, A/AAAA only (no NS): router/IPv6, NOT a CF tunnel"
        msg "      ${B}3) afraid${X}      freedns.afraid.org — instant; like DuckDNS, no NS"
        msg "      ${B}4) other${X}       a domain you already control"
        a=$(askb "      choose 1-4 [1]  $bk: ")
        [ "$a" = "$BACK" ] && { st=dkind; continue; }
        case "${a,,}" in ""|1|eu-org|euorg) DOMAIN_SOURCE=eu-org;; 2|duckdns) DOMAIN_SOURCE=duckdns;; 3|afraid) DOMAIN_SOURCE=afraid;; 4|other) DOMAIN_SOURCE=other;; *) msg "${Y}      please choose 1-4${X}"; continue;; esac
        [ "$METHOD" = cloudflare ] && [ "$DOMAIN_SOURCE" != eu-org ] && [ "$DOMAIN_SOURCE" != other ] && \
          msg "      ${Y}$DOMAIN_SOURCE can't host a Cloudflare tunnel — use nic.eu.org, or switch to router/ipv6.${X}"
        st=dval ;;
      dval)     # rule: a valid domain; for a DuckDNS source it must end in .duckdns.org. empty/invalid → re-ask.
        a=$(askb "    the domain (e.g. grandma-1.duckdns.org)  $bk: ")
        [ "$a" = "$BACK" ] && { [ "$DOMAIN_KIND" = free ] && st=dsrc || st=dkind; continue; }
        if [ -z "$a" ]; then msg "${Y}    a domain is required here${X}"; continue; fi
        if ! is_domain "$a"; then msg "${Y}    '$a' is not a valid domain (e.g. name.duckdns.org)${X}"; continue; fi
        if [ "$DOMAIN_SOURCE" = duckdns ] && [[ "$a" != *.duckdns.org ]]; then msg "${Y}    a DuckDNS name must end in .duckdns.org${X}"; continue; fi
        DOMAIN="$a"; st=done ;;
      ngd)      # rule: blank (free random) OR a valid domain. invalid non-blank → re-ask.
        a=$(askb "    paid ngrok custom domain (blank = free random *.ngrok-free.app)  $bk: ")
        [ "$a" = "$BACK" ] && { st=method; continue; }
        if [ -n "$a" ] && ! is_domain "$a"; then msg "${Y}    '$a' is not a valid domain${X}"; continue; fi
        DOMAIN="$a"; [ -n "$DOMAIN" ] && DOMAIN_KIND=paid || DOMAIN_KIND=free; st=done ;;
      lts)      # rule: blank (random) OR a single DNS label (letters/digits/hyphens). invalid → re-ask.
        a=$(askb "    localtunnel subdomain prefix (blank = random *.loca.lt)  $bk: ")
        [ "$a" = "$BACK" ] && { st=method; continue; }
        if [ -n "$a" ] && ! is_label "$a"; then msg "${Y}    letters, digits and hyphens only (no dots)${X}"; continue; fi
        LT_SUBDOMAIN="$a"; DOMAIN=""; DOMAIN_KIND=none; st=done ;;
      noned)    # rule: a valid domain (empty = the flake default if there is one). invalid → re-ask.
        a=$(askb "    your web address (domain)${DEFAULT_DOMAIN:+ [$DEFAULT_DOMAIN]}  $bk: ")
        [ "$a" = "$BACK" ] && { st=method; continue; }
        d="${a:-$DEFAULT_DOMAIN}"
        if [ -z "$d" ]; then msg "${Y}    a domain is required${X}"; continue; fi
        if ! is_domain "$d"; then msg "${Y}    '$d' is not a valid domain${X}"; continue; fi
        DOMAIN="$d"; DOMAIN_KIND=none; st=done ;;
      done) return 0 ;;
    esac
  done
}

# ══ shared question phase (Q3 transport first — it governs how the domain is handled) ══════════════
say "public reachability — how will the box be reached from the internet?"
WIZARD_DONE=0
if [ -z "$METHOD" ] && [ "$INTERACTIVE" = 1 ]; then run_wizard; WIZARD_DONE=1; fi
METHOD=$(need "$METHOD" --method "transport (cloudflare|tailscale|ipv6|ngrok|pinggy|localtunnel|router|none): ")

# domain, TAILORED to the method (non-interactive / flag-driven path; the interactive wizard above
# already set these with back-navigation, so skip it then).
if [ "$WIZARD_DONE" = 0 ]; then
case "$METHOD" in
  cloudflare)
    if [ -z "$CF_MODE" ] && [ "$INTERACTIVE" = 1 ]; then
      msg ""
      msg "  ${B}A)${X} free throwaway  ${C}*.trycloudflare.com${X}  — no domain, no account, ONE service, temporary URL"
      msg "  ${B}B)${X} a stable ${B}custom domain${X} — all 5 services (api/cloud/git/matrix/meet), survives restarts"
      a=$(ask "    choose A or B [A]: "); case "$a" in b|B) CF_MODE=named;; *) CF_MODE=quick;; esac
    fi
    [ -z "$CF_MODE" ] && { [ -n "$DOMAIN" ] && CF_MODE=named || CF_MODE=quick; }
    if [ "$CF_MODE" = named ]; then
      if [ -z "$DOMAIN_KIND" ] && [ "$INTERACTIVE" = 1 ]; then
        a=$(ask "    Do you already OWN this domain (paid), or want a FREE one? [paid/free]: ")
        case "$a" in free|f) DOMAIN_KIND=free;; *) DOMAIN_KIND=paid;; esac
      fi
      if [ "${DOMAIN_KIND:-paid}" = free ] && [ -z "$DOMAIN" ]; then
        pick_domain_source tunnel
        case "$DOMAIN_SOURCE" in
          eu-org) msg "    Register free at ${C}https://nic.eu.org${X}, add it as a Cloudflare zone + delegate NS, then:";;
          *)      msg "    Add that domain as a Cloudflare zone (NS delegation required) first, then:";;
        esac
      fi
      DOMAIN=$(need "$DOMAIN" --domain "    the custom domain to use (e.g. example.com): ")
    else
      DOMAIN=""   # quick tunnel: the box keeps its baked DEFAULT domain internally; public URL is random
    fi ;;
  ngrok)
    if [ -z "$DOMAIN" ] && [ "$INTERACTIVE" = 1 ]; then
      DOMAIN=$(ask "    paid ngrok custom domain (blank = free random *.ngrok-free.app): ")
    fi
    [ -n "$DOMAIN" ] && DOMAIN_KIND=paid || DOMAIN_KIND=free ;;
  pinggy)
    DOMAIN=""; DOMAIN_KIND=none ;;   # pinggy serves its own *.pinggy.link hostname
  tailscale)
    DOMAIN=""; DOMAIN_KIND=none ;;   # Tailscale Funnel serves its own *.ts.net hostname
  localtunnel)
    if [ -z "$LT_SUBDOMAIN" ] && [ "$INTERACTIVE" = 1 ]; then
      LT_SUBDOMAIN=$(ask "    localtunnel subdomain prefix (blank = random *.loca.lt): ")
    fi
    DOMAIN=""; DOMAIN_KIND=none ;;
  ipv6)
    msg "    Direct IPv6 needs a domain with an AAAA record (DuckDNS is ideal — free, token API)."
    if [ -z "$DOMAIN_KIND" ] && [ "$INTERACTIVE" = 1 ]; then
      a=$(ask "    OWN the domain (paid) or a FREE one? [paid/free]: "); case "$a" in free|f) DOMAIN_KIND=free;; *) DOMAIN_KIND=paid;; esac
    fi
    [ "${DOMAIN_KIND:-paid}" = free ] && pick_domain_source router
    DOMAIN=$(need "$DOMAIN" --domain "    the domain (e.g. grandma-1.duckdns.org): ") ;;
  router)
    msg "    A router forward needs a domain with public A-records."
    if [ -z "$DOMAIN_KIND" ] && [ "$INTERACTIVE" = 1 ]; then
      a=$(ask "    Do you OWN the domain (paid) or want a FREE one? [paid/free]: ")
      case "$a" in free|f) DOMAIN_KIND=free;; *) DOMAIN_KIND=paid;; esac
    fi
    [ "${DOMAIN_KIND:-paid}" = free ] && pick_domain_source router
    DOMAIN=$(need "$DOMAIN" --domain "    the domain (e.g. myserver.duckdns.org): ") ;;
  none)
    if [ -z "$DOMAIN" ] && [ "$INTERACTIVE" = 1 ]; then
      DOMAIN=$(ask "    your web address (domain)${DEFAULT_DOMAIN:+ [$DEFAULT_DOMAIN]}: ")
    fi
    DOMAIN_KIND=none ;;
  *) msg "${R}--method must be cloudflare | tailscale | ipv6 | ngrok | pinggy | localtunnel | router | none${X}"; exit 2;;
esac
fi

# Validate the gathered domain on EVERY path (the wizard already checked; this also catches a bad
# --domain flag in a non-interactive run) — a method that needs a name must get a real one.
if [ -n "$DOMAIN" ] && ! is_domain "$DOMAIN"; then
  msg "${R}'$DOMAIN' is not a valid domain (expected e.g. name.duckdns.org)${X}"; exit 2
fi

# ══ --plan: emit the decision for the installer, touch nothing ══════════════════════════════════
if [ "$PLAN" = 1 ]; then
  BAKED="${DOMAIN:-${DEFAULT_DOMAIN:-selfprivacy.box}}"   # what gets baked into the box (flake default; a single-hostname tunnel supplies the PUBLIC name separately, so no real domain is needed)
  cfn=0; [ "$CF_MODE" = named ] && cfn=1
  msg ""
  _prov=0; case "$METHOD" in pinggy|localtunnel|tailscale) _prov=1;; ngrok) [ -z "$DOMAIN" ] && _prov=1;; cloudflare) [ "$CF_MODE" = quick ] && _prov=1;; esac
  if [ "$_prov" = 1 ]; then
    msg "${G}planned:${X} method=${B}$METHOD${X} — you'll get a ${B}FREE public URL from the provider${X}."
    msg "         ${GR}A provider-assigned address (e.g. https://<name>.ts.net / *.trycloudflare.com / *.ngrok-free.app / *.pinggy.link / *.loca.lt), set up right after install. Nothing to register, no domain to choose.${X}"
  else
    msg "${G}planned:${X} method=${B}$METHOD${X} domain=${B}$BAKED${X}$([ "$METHOD" = cloudflare ] && echo " (cloudflare: ${CF_MODE})")"
  fi
  printf 'DOMAIN=%q\n'             "$BAKED"
  printf 'PUBLIC_METHOD=%q\n'      "$METHOD"
  printf 'PUBLIC_DOMAIN_KIND=%q\n' "${DOMAIN_KIND:-none}"
  printf 'PUBLIC_CF_NAMED=%q\n'    "$cfn"
  exit 0
fi

# ══ apply: configure on the box ═════════════════════════════════════════════════════════════════
[ "$CF_MODE" = "" ] && [ "$METHOD" = cloudflare ] && { [ -n "$DOMAIN" ] && CF_MODE=named || CF_MODE=quick; }

say "0/4  checking the box @ $IP"
box true 2>/dev/null || { msg "${R}can't ssh root@$IP with $KEY — is the box up and on this network?${X}"; exit 1; }
box 'test -f /etc/selfprivacy/secrets.json' || { msg "${R}no /etc/selfprivacy/secrets.json — this isn't the installed system (maybe still the installer). Reboot into disk first.${X}"; exit 1; }
BOX_DOMAIN=$(box "python3 -c \"import json;print(json.load(open('/etc/nixos/userdata.json'))['domain'])\" 2>/dev/null" | tr -d '\r'); [ -n "$BOX_DOMAIN" ] || BOX_DOMAIN="${DOMAIN:-selfprivacy.local}"
TOKEN=$(box "python3 -c \"import json;print(json.load(open('/etc/selfprivacy/secrets.json'))['api']['token'])\" 2>/dev/null" | tr -d '\r')
msg "${G}box ok${X} — internal domain ${B}$BOX_DOMAIN${X}"

ensure_on_box(){ local attr="$1" bin="$2" unfree="$3"
  box "test -x /root/.nix-profile/bin/$bin" && { echo "/root/.nix-profile/bin/$bin"; return; }
  msg "installing $attr on the box (nix profile) …"
  if [ "$unfree" = 1 ]; then box "NIXPKGS_ALLOW_UNFREE=1 $NIXX profile install --impure nixpkgs#$attr" >&2
  else box "$NIXX profile install nixpkgs#$attr" >&2; fi
  box "test -x /root/.nix-profile/bin/$bin" || { msg "${R}failed to install $attr on the box${X}"; exit 1; }
  echo "/root/.nix-profile/bin/$bin"; }
install_service(){ local unit="$1" exec="$2"
  # NixOS: /etc/systemd/system is a READ-ONLY symlink into the Nix store, so we can neither write a
  # unit there nor `systemctl enable` (its WantedBy symlink target is read-only too). Units in the
  # writable tmpfs /run/systemd/system ARE loaded by systemd, so write there and `start` directly.
  # Caveat: /run is cleared on reboot — this tunnel does NOT survive a box reboot yet (see notes).
  printf '%s\n' "[Unit]" "Description=SelfPrivacy public tunnel ($unit)" \
    "After=network-online.target selfprivacy-api.service" "Wants=network-online.target" \
    "[Service]" "ExecStart=$exec" "Restart=always" "RestartSec=5" \
    "[Install]" "WantedBy=multi-user.target" | putfile "/run/systemd/system/$unit.service"
  box "systemctl daemon-reload && systemctl restart $unit.service"
  if box "systemctl is-active --quiet $unit.service"; then msg "${G}✓ service $unit started on the box.${X}"
  else msg "${R}service $unit failed to start — ssh root@$IP journalctl -u $unit${X}"; fi; }
print_app_cmd(){ local host="$1"
  msg ""; msg "${GR}Point the app at it:${X}"
  msg "   ${B}flutter run -d linux --dart-define=HTTPS_DOMAIN=$host --dart-define=HTTPS_APEX=1 --dart-define=API_TOKEN=${TOKEN:-<box-api-token>}${X}"
  msg "${GR}Integration test:${X}"
  msg "   ${B}./dash run L3.connect.desktop --net https --on $SETUP --ip $IP --key ${KEY/#$HOME/\~} --token ${TOKEN:-<token>}${X}"; }

say "3/4  configuring: $METHOD"
case "$METHOD" in
  cloudflare)
    CF=$(ensure_on_box cloudflared cloudflared 0)
    if [ "$CF_MODE" = named ]; then
      DOMAIN=$(need "$DOMAIN" --domain "custom domain (its zone must be on Cloudflare): ")
      # HEADLESS / remotely-managed — NOTHING is typed on the box, no browser login on the box. You make
      # the tunnel once in the Cloudflare Zero Trust dashboard (on your laptop) and paste its connector
      # TOKEN here; we install cloudflared on the box and run it with that token, all over SSH.
      CF_TUNNEL_TOKEN=$(need "$CF_TUNNEL_TOKEN" --cf-tunnel-token \
        "Cloudflare tunnel token (Zero Trust ▸ Networks ▸ Tunnels ▸ Create ▸ copy the token): ")
      install_service cloudflared-sp "$CF tunnel --no-autoupdate run --token $CF_TUNNEL_TOKEN"
      if box "systemctl is-active --quiet cloudflared-sp"; then msg "${G}✓ connector running on the box (headless — no box login).${X}"
      else msg "${Y}connector installed but not active yet — ssh root@$IP journalctl -u cloudflared-sp${X}"; fi
      msg "In the Cloudflare dashboard add these ${B}Public Hostnames${X} to that tunnel, each → ${B}https://localhost:443${X} (origin: TLS ▸ No TLS Verify):"
      for s in "${SUBS[@]}"; do msg "   ${B}$s.$DOMAIN${X}"; done
      msg "${GR}(Adding a public hostname auto-creates its DNS CNAME in the zone — still no box access.)${X}"
      print_app_cmd "api.$DOMAIN"
    else
      msg "Minting a free ${B}quick tunnel${X} (no account) — Cloudflare assigns you a random public URL (printed below)."
      install_service cloudflared-sp "$CF tunnel --no-autoupdate --no-tls-verify --http-host-header api.$BOX_DOMAIN --url https://localhost:443"
      URL=""; for _ in $(seq 1 12); do URL=$(box "journalctl -u cloudflared-sp --no-pager -n 120 2>/dev/null" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1); [ -n "$URL" ] && break; sleep 3; done
      if [ -n "$URL" ]; then msg "${G}✓ quick tunnel up:${X} ${B}$URL${X}"; msg "${Y}NOTE: temporary URL (changes on restart), API vhost only. Rerun with a --domain for a stable, all-subdomain setup.${X}"; print_app_cmd "${URL#https://}"
      else msg "${R}started but no trycloudflare URL yet — ssh root@$IP journalctl -u cloudflared-sp${X}"; fi
    fi ;;
  ngrok)
    NG=$(ensure_on_box ngrok ngrok 1)
    NGROK_TOKEN=$(need "$NGROK_TOKEN" --ngrok-token "ngrok authtoken (free at https://dashboard.ngrok.com): ")
    box "$NG config add-authtoken '$NGROK_TOKEN'"
    DOMARG=""; [ -n "$DOMAIN" ] && DOMARG="--domain api.$DOMAIN"
    install_service ngrok-sp "$NG http https://localhost:443 --host-header=api.$BOX_DOMAIN $DOMARG"
    URL=""; for _ in $(seq 1 12); do URL=$(box "curl -s --max-time 3 http://localhost:4040/api/tunnels 2>/dev/null" | grep -oE 'https://[a-z0-9.-]+\.ngrok[a-z.-]*' | head -1); [ -n "$URL" ] && break; sleep 3; done
    if [ -n "$URL" ]; then msg "${G}✓ ngrok tunnel up:${X} ${B}$URL${X}"; [ -z "$DOMARG" ] && msg "${Y}NOTE: free ngrok = random *.ngrok-free.app, single endpoint. Custom domain is paid.${X}"; print_app_cmd "${URL#https://}"
    else msg "${R}ngrok started but no URL yet — ssh root@$IP journalctl -u ngrok-sp${X}"; fi ;;
  pinggy)
    # SSH-based: the box dials OUT over ssh — NOTHING to install (ssh is already there), no router changes.
    # Free = random *.pinggy.link, ~60-min sessions; a pinggy.io token = persistent + custom subdomain.
    msg "Starting a ${B}Pinggy${X} SSH tunnel from the box."
    PT="${PINGGY_TOKEN:-}"
    install_service pinggy-sp "ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -tt -R0:localhost:443 ${PT:+$PT@}a.pinggy.io x:https"
    URL=""; for _ in $(seq 1 12); do URL=$(box "journalctl -u pinggy-sp --no-pager -n 160 2>/dev/null" | grep -oE 'https://[a-z0-9-]+\.(pinggy\.link|pinggy\.online|free\.pinggy\.link)' | tail -1); [ -n "$URL" ] && break; sleep 3; done
    if [ -n "$URL" ]; then msg "${G}✓ pinggy tunnel up:${X} ${B}$URL${X}"
      [ -z "$PT" ] && msg "${Y}NOTE: free pinggy = random hostname + ~60-min sessions. A pinggy.io token (--pinggy-token) makes it persistent/custom.${X}"
      msg "${GR}SelfPrivacy vhosts are Host-routed on :443 — if the api vhost 404s, add Pinggy's Host-header rewrite (pinggy.io docs).${X}"
      print_app_cmd "${URL#https://}"
    else msg "${R}pinggy started but no URL yet — ssh root@$IP journalctl -u pinggy-sp${X}"; fi ;;
  localtunnel)
    LT=$(ensure_on_box nodePackages.localtunnel lt 0)
    install_service localtunnel-sp "$LT --port 443 --local-host localhost --local-https --allow-invalid-cert --host https://localtunnel.me ${LT_SUBDOMAIN:+--subdomain $LT_SUBDOMAIN}"
    URL=""; for _ in $(seq 1 12); do URL=$(box "journalctl -u localtunnel-sp --no-pager -n 160 2>/dev/null" | grep -oE 'https://[a-z0-9-]+\.loca\.lt' | tail -1); [ -n "$URL" ] && break; sleep 3; done
    if [ -n "$URL" ]; then msg "${G}✓ localtunnel up:${X} ${B}$URL${X}"
      msg "${Y}NOTE: loca.lt adds a one-time browser interstitial (API/app clients must send header 'Bypass-Tunnel-Reminder: true'). It fronts ONE endpoint; Host-routed cloud/git/… need separate tunnels.${X}"
      print_app_cmd "${URL#https://}"
    else msg "${R}localtunnel started but no URL yet — ssh root@$IP journalctl -u localtunnel-sp${X}"; fi ;;
  tailscale)
    # Tailscale Funnel: FREE, STABLE https://<host>.<tailnet>.ts.net with a valid cert, outbound (no
    # port-forward, CGNAT-proof). tailscaled runs in USERSPACE networking (no kernel TUN needed).
    TS=$(ensure_on_box tailscale tailscale 0)
    TSD="$(dirname "$TS")/tailscaled"; SOCK=/run/tailscale/tailscaled.sock
    box "mkdir -p /var/lib/tailscale /run/tailscale"
    install_service tailscaled-sp "$TSD --tun=userspace-networking --state=/var/lib/tailscale/tailscaled.state --socket=$SOCK"
    for _ in $(seq 1 12); do box "test -S $SOCK" && break; sleep 1; done
    ts_state(){ box "$TS --socket=$SOCK status --json 2>/dev/null" | tr ',' '\n' | grep -oE '"BackendState":"[^"]+"' | head -1 | sed -E 's/.*:"([^"]+)"/\1/'; }
    # Authenticate ONLY if the box isn't already on the tailnet. Re-running the apply (e.g. to finish
    # Funnel) must NOT log the box out — which an already-used single-use key would, especially with
    # --reset. So: if it's already Running, keep the session; otherwise prompt for a key and join.
    if [ "$(ts_state)" = Running ]; then
      msg "${G}box is already on your tailnet${X} — keeping the existing session (no new auth key needed)."
    else
      # A FRESH auth key is needed for EVERY setup: Tailscale keys are SINGLE-USE by default — consumed
      # the instant a box joins. There's no offline way to tell a spent key from a good one, so we VERIFY
      # it the only real way — by trying to join and checking the box reaches Running — and re-ask if not.
      if [ -z "$TAILSCALE_AUTHKEY" ] && [ "$INTERACTIVE" = 1 ]; then
        msg ""
        msg "${B}── one thing left: a Tailscale auth key ──${X}  ${GR}(a one-time code that lets this box join Tailscale; free, ~2 min)${X}"
        msg "  ${B}1.${X} On ${B}this laptop${X} open ${C}https://login.tailscale.com/admin/settings/keys${X}"
        msg "     ${GR}No account yet? Click ${X}${B}Get started${X}${GR} / ${X}${B}Sign up${X}${GR} first — it's free, log in with Google / GitHub / Microsoft / email, then you land on this page.${X}"
        msg "  ${B}2.${X} Click ${B}Generate auth key…${X} — leave every option at its default — then ${B}Generate key${X}."
        msg "  ${B}3.${X} ${B}Copy${X} the key it shows you (it starts with ${B}tskey-auth-${X} and is shown ${B}only once${X})."
        msg "  ${B}4.${X} ${B}Paste${X} it at the prompt below (${GR}right-click, or Ctrl+Shift+V${X}) and press ${B}Enter${X}."
        msg "     ${Y}A key works ONLY ONCE — generate a NEW one for every box you set up.${X} ${GR}(Tick ${X}${B}Reusable${X}${GR} when generating if you'll set up several.)${X}"
        msg ""
      fi
      while :; do
        TAILSCALE_AUTHKEY=$(need "$TAILSCALE_AUTHKEY" --tailscale-authkey "  ▸ paste the Tailscale auth key (tskey-auth-…) and press Enter: ")
        if [ "${TAILSCALE_AUTHKEY#tskey-}" = "$TAILSCALE_AUTHKEY" ]; then
          msg "${Y}  That isn't a Tailscale auth key — it must start with ${B}tskey-auth-${X}${Y}. Copy it again from the Keys page.${X}"
          [ "$INTERACTIVE" = 1 ] && { TAILSCALE_AUTHKEY=""; continue; }
          exit 2
        fi
        # VERIFY the key the only way there is: use it. `up` with a spent/expired key returns promptly; a
        # good one drives the node to Running. --timeout + outer `timeout` guarantee it can't hang.
        msg "checking your auth key (joining the tailnet) …"
        box "timeout 45 $TS --socket=$SOCK up --authkey='$TAILSCALE_AUTHKEY' --hostname=selfprivacy --accept-dns=false --timeout=30s" 2>&1 | sed 's/^/  /' >&2 || true
        [ "$(ts_state)" = Running ] && { msg "${G}✓ auth key accepted — the box is on your tailnet.${X}"; break; }
        msg ""
        msg "${R}✗ That auth key did NOT work.${X}"
        msg "${Y}${B}Tailscale auth keys are SINGLE-USE — you need a NEW key for EVERY setup${X} ${GR}(this is the #1 gotcha: a key is spent the moment any box joins with it).${X}"
        msg "  ${GR}Generate a fresh one at ${X}${C}https://login.tailscale.com/admin/settings/keys${X}${GR} → ${X}${B}Generate auth key…${X}${GR}.${X}"
        msg "  ${GR}Setting up several boxes? Tick ${X}${B}Reusable${X}${GR} when generating so one key works for all of them.${X}"
        msg "  ${GR}If you're certain the key is brand-new, the box may have no internet — check its connection.${X}"
        if [ "$INTERACTIVE" != 1 ]; then
          msg "${Y}non-interactive: pass a fresh ${X}${B}--tailscale-authkey${X}${Y} and re-run.${X}"; exit 1
        fi
        msg ""
        TAILSCALE_AUTHKEY=""   # wipe the bad key and re-prompt for a new one, in place
      done
    fi
    # Stable public name — exists the moment the box joins, but is only REACHABLE once Funnel is on.
    TSHOST=$(box "$TS --socket=$SOCK status --json 2>/dev/null" | tr ',' '\n' | grep -oE '"DNSName":"selfprivacy\.[^"]+"' | head -1 | sed -E 's/.*"DNSName":"([^"]+)"/\1/; s/\.$//')
    # Turn Funnel on. Enabling Funnel is a ONE-TIME, browser-based approval that ONLY the tailnet owner
    # can give — it can't be done with the auth key or any CLI flag. So: try to start Funnel; if the
    # tailnet doesn't have it on yet, `tailscale funnel` prints the EXACT pre-filled enable URL for THIS
    # node — capture it, show the operator precisely what to click, wait, and retry until Funnel serves.
    msg "turning on Funnel :443 (Tailscale terminates TLS with a valid cert) …"
    # `funnel --bg` prints the enable notice then BLOCKS when Funnel isn't enabled on the tailnet (and
    # can block on cert provisioning even when it is), so cap it with `timeout` — the notice (incl. the
    # enable URL) is already on stdout by then; when Funnel IS on, the serve config is set before the
    # cap fires and `funnel status` below confirms the live URL.
    FUNNEL="timeout 25 $TS --socket=$SOCK funnel --bg https+insecure://localhost:443"
    _fout=$(box "$FUNNEL" 2>&1)
    while printf '%s' "$_fout" | grep -qiE 'not enabled|to enable'; do
      _enurl=$(printf '%s' "$_fout" | grep -oE 'https://login\.tailscale\.com/[^[:space:]]+' | head -1)
      msg ""
      msg "${B}── one more one-time step: switch Funnel ON for your tailnet ──${X}  ${GR}(only you, the account owner, can approve this — the box cannot)${X}"
      msg "  ${B}1.${X} On ${B}this laptop${X}, open the link below — it is pre-filled for THIS box:"
      msg "     ${C}${_enurl:-https://login.tailscale.com/admin/settings/feature-previews}${X}"
      msg "  ${B}2.${X} On that page click ${B}Enable Funnel${X} (approve any 'funnel' attribute it asks about)."
      msg "     ${GR}If the page has nothing to click, first open ${X}${C}https://login.tailscale.com/admin/dns${X}${GR}, turn on ${X}${B}HTTPS Certificates${X}${GR}, then reopen the link above.${X}"
      msg ""
      if [ "$INTERACTIVE" != 1 ]; then
        msg "${Y}non-interactive: enable Funnel at the URL above, then re-run this exact command.${X}"; break
      fi
      _ans=$(ask "  ▸ press ENTER once you've clicked Enable Funnel (or type s then ENTER to skip): ")
      [ "${_ans,,}" = s ] && { msg "${Y}skipped — once Funnel is enabled, finish by running this ${B}on THIS laptop${X}${Y}:${X} ${GR}ssh root@$IP $FUNNEL${X}"; break; }
      _fout=$(box "$FUNNEL" 2>&1)
    done
    # Poll for the live Funnel URL. First-ever HTTPS cert issuance can take ~30-40s, so give it room.
    msg "${GR}waiting for Funnel to come up (first HTTPS cert can take ~30s) …${X}"
    URL=""; for _ in $(seq 1 15); do URL=$(box "$TS --socket=$SOCK funnel status 2>/dev/null" | grep -oE 'https://[a-zA-Z0-9.-]+\.ts\.net' | head -1 | sed 's#https://##'); [ -n "$URL" ] && break; sleep 3; done
    if [ -n "$URL" ]; then
      msg "${G}✓ Tailscale Funnel up:${X} ${B}https://$URL${X}  (stable, valid cert, no port-forward, CGNAT-proof)"
      print_app_cmd "$URL"
    else
      msg "${Y}Funnel isn't serving publicly yet.${X} Confirm it's enabled at ${C}https://login.tailscale.com/admin/dns${X} ${GR}(HTTPS Certificates = on)${X},"
      msg "then run this ${B}on THIS laptop${X} ${GR}(not on the box — it SSHes into the box for you)${X}:"
      msg "   ${GR}ssh root@$IP $FUNNEL && ssh root@$IP $TS --socket=$SOCK funnel status${X}"
      [ -n "$TSHOST" ] && msg "${GR}When it's on, the box is reachable at ${X}${B}https://$TSHOST${X}${GR} — point the app there with ${X}${B}HTTPS_APEX=1${X}${GR}.${X}"
    fi
    msg "${GR}NOTE: Funnel is ONE hostname → the app connects at the apex (HTTPS_APEX, below). The full api./cloud./… suite needs a real domain + Cloudflare named tunnel or port-forward.${X}" ;;
  ipv6)
    # DECENTRALISED: reach B directly over its public IPv6 — no relay, no NAT, no port-forward. The box
    # firewall already allows :443 (NixOS opens it for v4+v6); we just publish/track an AAAA record.
    DOMAIN=$(need "$DOMAIN" --domain "domain to point at the box (e.g. grandma-1.duckdns.org): ")
    V6=$(box_global_ipv6 "$IP" "$KEY")   # autodetect on the box's CURRENT (final) network
    [ -n "$V6" ] || { msg "${R}no routable public IPv6 on the box's current network (IPv4-only / CGNAT). Use --method cloudflare instead.${X}"; exit 1; }
    msg "${G}box has a public IPv6:${X} ${B}$V6${X} — no NAT; :443 already open in the NixOS firewall."
    if printf '%s' "$DOMAIN" | grep -q '\.duckdns\.org$' && [ -z "$DUCKDNS_TOKEN" ] && [ "$INTERACTIVE" = 1 ]; then
      DUCKDNS_TOKEN=$(ask "DuckDNS token (auto-update the AAAA; blank = I'll set it manually): ")
    fi
    if printf '%s' "$DOMAIN" | grep -q '\.duckdns\.org$' && [ -n "$DUCKDNS_TOKEN" ]; then
      sub="${DOMAIN%.duckdns.org}"; sub="${sub##*.}"
      putfile /root/duckdns-aaaa.sh <<EOF
#!/bin/sh
# keep the DuckDNS AAAA pointed at the box's current global IPv6 (survives reboot / prefix change)
while true; do
  V=\$(ip -6 addr show scope global | awk '{print \$2}' | cut -d/ -f1 | grep -E '^[23]' | head -1)
  [ -n "\$V" ] && curl -fsS "https://www.duckdns.org/update?domains=${sub}&token=${DUCKDNS_TOKEN}&ipv6=\$V" >/dev/null 2>&1
  sleep 300
done
EOF
      box "chmod +x /root/duckdns-aaaa.sh"
      install_service duckdns-aaaa-sp "/bin/sh /root/duckdns-aaaa.sh"
      msg "${G}✓ AAAA ${B}$DOMAIN${G} → $V6 (auto-updated every 5 min via DuckDNS).${X}"
    else
      msg "Set an ${B}AAAA${X} record ${B}$DOMAIN → $V6${X} at your DNS host (DuckDNS: pass --duckdns-token to auto-update)."
    fi
    msg "${GR}Cert: the box runs Let's Encrypt for $DOMAIN itself (HTTP-01 over the now-reachable :80, or DNS-01). Visitors need IPv6 too.${X}"
    print_app_cmd "api.$DOMAIN" ;;
  router)
    PUB=$(box "curl -s --max-time 10 https://api.ipify.org"); LAN=$(box 'hostname -I' | awk '{print $1}')
    msg "${B}Router port-forward${X} (free, but needs admin on every NAT hop):"
    msg "  1. On your router, forward ${B}TCP 443 → $LAN:443${X}."
    msg "  2. Add these A-records at your DNS host, pointing at your PUBLIC IP ${B}${PUB:-<router-public-ip>}${X}:"
    for s in "${SUBS[@]}"; do msg "       A   $s.${DOMAIN:-$BOX_DOMAIN}   ${PUB:-<public-ip>}"; done
    msg "  3. Verify: ${B}bash tools/finish_box_setup.sh --domain ${DOMAIN:-$BOX_DOMAIN} --key ${KEY/#$HOME/\~} --ip $IP --setup $SETUP${X}"
    if [ "${DOMAIN_SOURCE:-}" = duckdns ]; then
      sub="${DOMAIN%.duckdns.org}"
      msg "  ${GR}DuckDNS: keep ${DOMAIN:-<sub>.duckdns.org} pointed at your public IP with a timer on the box:${X}"
      msg "     ${C}*/5 * * * * curl -s 'https://www.duckdns.org/update?domains=${sub:-<sub>}&token=<your-token>&ip='${X}"
      msg "  ${Y}(DuckDNS is dynamic-DNS to YOUR IP — still needs :443 forwarded; it canNOT host a Cloudflare tunnel.)${X}"
    fi
    print_app_cmd "api.${DOMAIN:-$BOX_DOMAIN}" ;;
  none)
    msg "${GR}No public tunnel chosen — the box is reachable on the LAN and over its .onion only.${X}"
    print_app_cmd "api.${DOMAIN:-$BOX_DOMAIN}" ;;
  *) msg "${R}--method must be cloudflare | tailscale | ipv6 | ngrok | pinggy | localtunnel | router | none${X}"; exit 2;;
esac
say "4/4  done ($METHOD)"
