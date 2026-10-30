# Test matrix — run by hand, track per commit

> Rule (enforced): **every command here is written in full with all args explicit, and the
> tooling REQUIRES them — no implicit defaults.** Omitting an arg fails fast telling you what
> to set. Reason: prove a random person on a random network/device can run these from the
> text alone; hidden defaults silently do the wrong thing and mask real bugs.

---

## How to run & see results
- Run one/many automated tests (see full commands below).
- Log a **manual** (click-through / video) result with the same args as a run — `--reach` [`--name`] `--net` only
  for an L3 flow, and `--ip --key` for a box so its deployed build is recorded:
  `./dash report L3.<flow>.desktop --status pass|fail --duration <sec> --on <SETUP> --reach <REACH> [--name <NAME>] --net <NET> --ip <BOX_LAN_IP> --key <SSH_KEY> [--error "…"]`
  `./dash report install.<SETUP> --status pass|fail --duration <sec> --on <SETUP> --ip <BOX_LAN_IP> --key <SSH_KEY> [--error "…"]`
- See what ran + output **per commit**: `./dash serve 8099` → http://localhost:8099/index.html (setups × reach)
  and http://localhost:8099/matrix.html (per code state); or `grep <id> testresults/results.jsonl`. Each record
  carries `commit`,`dirty`,`diff_hash`,`status`,`duration_s`,`error`,`method` (setup),`reach`,`reach_name`,
  `transport`,`diagram_view`,`log_path` (full output in `testresults/logs/<run_id>.log`).
- **Storing ≠ publishing:** results stay local; push them with `./dash publish` only when you mean to.
- Re-map a test→command: edit `catalog.json`. Fix a recorded row: edit its line in
  `testresults/results.jsonl` or re-`report` it.

## The axes = the setup diagram
The matrix uses the setup diagram's toggles ([`flow.html#setup-map`](flow.html#setup-map), data
`docs/diagrams/setup-map.json`): **Install × Network** → setup (`--on`, a column), **Reach × Name** → reach row
(`--reach` [`--name`], a row group), plus the transport the app speaks (`--net`). `./dash setups` lists them and
checks they still match the diagram. **Every `run` / `wrap` / `report` runs that same check first and refuses
if the matrix and the diagram have drifted apart** (no override, not even `--allow-dirty`): fix `catalog.json`
until `./dash setups --check` says `aligned`. Full tables + diagram links: [`networks.md`](networks.md).

| axis | flag | values |
|---|---|---|
| setup = Install × Network | `--on` | `cable-0a` `cable-0b` `cable-0d` `cable-0c` · `wifi-0a` `wifi-0d` · `usb-0a` `usb-0d` `usb-0c` · `vm` |
| reach = Reach (× Name) | `--reach` [`--name`] | `onion` · `tailscale` · `cloudflare --name buy\|trycf` · `ipv6 --name buy\|duckdns` · `portfwd --name buy\|duckdns` · harness: `local` |
| transport the app speaks | `--net` | `tor` (onion) · `chutney` (onion on a private test Tor, vm only) · `https` (every other reach) |

`--reach` is required for every L3 run. Valid L3 combinations today:

| setup | `--reach` [`--name`] `--net` | |
|---|---|---|
| `vm` | `onion --net tor` · `onion --net chutney` · `local --net https` | runnable on this computer |
| `vm` | `tailscale` / `cloudflare` / `ipv6` / `portfwd` | ○ diagram views, not wired for the VM yet |
| a box (`cable-*`, `wifi-*`, `usb-*`) | `onion --net tor` · `cloudflare --name buy --net https` · `ipv6 --name buy\|duckdns --net https` · `portfwd --name buy\|duckdns --net https` | needs `--ip --key --token` |
| a box | `tailscale` · `cloudflare --name trycf` | ○ one-hostname tunnels: no automated L3 yet — `./dash app --domain <HOST> --token <API_TOKEN> --apex`, then `./dash report … --reach tailscale --net https --ip <BOX_LAN_IP> --key <SSH_KEY>` |
| a box | `onion --net chutney` · `local --net https` | N/A (harness-only rows) |
| any | greyed out: `onion --net tor+https` · `onion --net chutney+https` · `ngrok` · `pinggy` · `localtunnel` | can't run — kept in the matrix for reference; no diagram view, no test (`dash` refuses them) |

## Your deployment values (fill these for YOUR rig; shown with the current pcname box)
```
FLAKE=/home/a/git/personal/selfprivacy/selfprivacy-altnet-deployer      # the deploy flake (#box)
KEY=/home/a/.ssh/pcname_ed25519                            # ssh deploy key
MAC=d8:cb:8a:7c:0a:f4                                      # target NIC MAC
DOMAIN=weersurf.nl                                         # public domain (reach rows with --name buy)
# IP: for install.cable-* the direct-cable installer's address 192.168.100.50; for install.wifi-* / install.usb-* the
# target's address on router R (192.168.1.167). After ANY install (reach.*, L3, report) the box is on router R:
# use its LAN IP there (192.168.1.167).
# API token: per box + secret, never written down here — read it from your KeePass (state/keepass/<host>.kdbx).
```

## Scope legend (decides sharing)
🟢 READ (no server change) · 🔵 REVERSIBLE (undoes itself) · 🟡 PERSISTENT (dirties baseline) ·
🔴 DESTRUCTIVE (data/connectivity/terminal) · ⟳ rebuild · 🔑 external (B2/DNS/provider)

## Deployment groups
D0 provisioning (the install) · D1 shared clean box (🟢, order-free) · D3 service lifecycle (fresh,⟳) ·
D4 backup lifecycle (fresh,🔑,ends🔴) · D5 system/settings (fresh) · D6 destructive/terminal (isolated)

---

## Matrix — RUNNABLE NOW on this computer (setup `vm`, no hardware)
One-time prerequisites on this computer (the runs refuse with the fix if one is missing): VirtualBox; host Tor
(`sudo apt install tor`; dash starts a user-level tor on 9050); the trusted local https name
(`bash setup-theory7-https.sh` → `/etc/hosts` entry, mkcert CA, Caddy user service); chutney cloned at `../chutney`
with its Python deps (`pip install tomli_w tomli paramiko rpyc`) for the chutney rows.

### L1 + L2 — self-contained (they start their own throwaway VM; VirtualBox must be stopped meanwhile)
```sh
./dash run L1.onion-routing
./dash run L2.backend --net tor        # matrix row .onion · app over Tor   (harness setup test-vm)
./dash run L2.backend --net https      # matrix row local https            (harness setup test-vm)
```

### D0 — a fresh VM, built from source
```sh
./dash vm-reset                        # remove every old copy of the VM
./dash run install.vm --on vm          # build the image from the committed backend flake, install it
./dash vm-up                           # restart it with stable VirtualBox settings, wait for its .onion
```

### D1 — the 7 read-only flows on that ONE fresh VM (order-free) [🟢]
```sh
./dash run L3.connect.desktop L3.login.desktop L3.services.desktop L3.providers.desktop \
           L3.nextcloud.desktop L3.users.desktop L3.menus.desktop --on vm --reach local --net https
./dash run L3.connect.desktop L3.login.desktop L3.services.desktop L3.providers.desktop \
           L3.nextcloud.desktop L3.users.desktop L3.menus.desktop --on vm --reach onion --net tor
./dash run L3.connect.desktop L3.login.desktop L3.services.desktop L3.providers.desktop \
           L3.nextcloud.desktop L3.users.desktop L3.menus.desktop --on vm --reach onion --net chutney
```

### D3 — service add/remove, each on its OWN fresh VM [🟡⟳]
```sh
./dash vm-reset && ./dash run install.vm --on vm && ./dash vm-up
./dash run L3.addremove.desktop --on vm --reach local --net https
./dash vm-reset && ./dash run install.vm --on vm && ./dash vm-up
./dash run L3.addremove.desktop --on vm --reach onion --net tor
./dash vm-reset && ./dash run install.vm --on vm && ./dash vm-up
./dash run L3.addremove.desktop --on vm --reach onion --net chutney
```

---

## Matrix — boxes (needs the target hardware)
Replace FLAKE/KEY/MAC/DOMAIN/IP with your values above; `<API_TOKEN>` is the box's token from your KeePass.

### D0 — install a fresh box. LAN cable (direct-cable netboot), one command per Network variant:
```sh
./dash run install.cable-0a --on cable-0a \
  --ip 192.168.100.50 --key /home/a/.ssh/pcname_ed25519 \
  --env NETBOOT=auto --env TRANSPORT=none \
  --env FLAKE=/home/a/git/personal/selfprivacy/selfprivacy-altnet-deployer \
  --env MAC=d8:cb:8a:7c:0a:f4 --env DOMAIN=weersurf.nl
# cable-0b / cable-0d / cable-0c leave the server on wifi — same command plus its wifi spec:
./dash run install.cable-0d --on cable-0d \
  --ip 192.168.100.50 --key /home/a/.ssh/pcname_ed25519 \
  --env NETBOOT=auto --env TRANSPORT=none \
  --env FLAKE=/home/a/git/personal/selfprivacy/selfprivacy-altnet-deployer \
  --env MAC=d8:cb:8a:7c:0a:f4 --env DOMAIN=weersurf.nl \
  --env WIFI_SSID=<SSID> --env WIFI_PSK=<PASSWORD>
```
`TRANSPORT=none` = install-only (stays on the cable). For the full install **+ live verify** use
`--env TRANSPORT=https` (public `https://api.DOMAIN`) or `--env TRANSPORT=onion` (the .onion); it prompts you to
move the box onto its final network first.

Wifi (netboot through router R) — **not runnable yet**: it needs R configured for network boot and dash has no
check for that, so its preflight always refuses (printing the router setup). The commands, for when it is wired:
```sh
./dash run install.wifi-0a --on wifi-0a \
  --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 \
  --env NETBOOT=off --env TRANSPORT=https \
  --env FLAKE=/home/a/git/personal/selfprivacy/selfprivacy-altnet-deployer \
  --env MAC=d8:cb:8a:7c:0a:f4 --env DOMAIN=weersurf.nl
./dash run install.wifi-0d --on wifi-0d \
  --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 \
  --env NETBOOT=off --env TRANSPORT=https \
  --env FLAKE=/home/a/git/personal/selfprivacy/selfprivacy-altnet-deployer \
  --env MAC=d8:cb:8a:7c:0a:f4 --env DOMAIN=weersurf.nl \
  --env WIFI_SSID=<SSID> --env WIFI_PSK=<PASSWORD>
```

USB stick (one chain: write the stick → boot + install on the target → stamp + verify). usb-0d / usb-0c leave the
server on wifi: add `--env WIFI_SSID=<SSID>` (checked in range) — the USB chain writes no wifi config, so set the
server's wifi up by hand during the USB install:
```sh
./dash run install.usb-0a --on usb-0a \
  --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 \
  --env USB_DEV=/dev/sdX --env TRANSPORT=https \
  --env FLAKE=/home/a/git/personal/selfprivacy/selfprivacy-altnet-deployer \
  --env MAC=d8:cb:8a:7c:0a:f4 --env DOMAIN=weersurf.nl
```

### Reach — make the installed box reachable (one route; `--on` = the setup you installed)
```sh
./dash run reach.onion            --on cable-0a --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519
./dash run reach.tailscale        --on cable-0a --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 --env TAILSCALE_AUTHKEY=<tskey-auth-...>
./dash run reach.cloudflare-buy   --on cable-0a --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 --env DOMAIN=weersurf.nl --env CF_TUNNEL_TOKEN=<CONNECTOR_TOKEN>
./dash run reach.cloudflare-trycf --on cable-0a --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519
./dash run reach.ipv6-buy         --on cable-0a --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 --env DOMAIN=weersurf.nl
./dash run reach.ipv6-duckdns     --on cable-0a --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 --env DOMAIN=<NAME>.duckdns.org --env DUCKDNS_TOKEN=<DUCKDNS_TOKEN>
./dash run reach.portfwd-buy      --on cable-0a --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 --env DOMAIN=weersurf.nl
./dash run reach.portfwd-duckdns  --on cable-0a --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 --env DOMAIN=<NAME>.duckdns.org
```

### D1 — read-only suite on that box (order-free) [🟢]
```sh
./dash run L3.connect.desktop L3.login.desktop L3.services.desktop L3.providers.desktop \
           L3.nextcloud.desktop L3.users.desktop L3.menus.desktop \
           --on cable-0a --reach onion --net tor \
           --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 --token <API_TOKEN>
./dash run L3.connect.desktop L3.login.desktop L3.services.desktop L3.providers.desktop \
           L3.nextcloud.desktop L3.users.desktop L3.menus.desktop \
           --on cable-0a --reach portfwd --name buy --net https \
           --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 --token <API_TOKEN>
```
(Use the `--reach`/`--name` of the route you applied: `cloudflare --name buy`, `ipv6 --name buy|duckdns`,
`portfwd --name buy|duckdns`.) Over `tailscale` / `cloudflare --name trycf` there is no automated L3 yet — drive the
app and log each flow by hand:
```sh
./dash app --domain <HOST> --token <API_TOKEN> --apex
./dash report L3.connect.desktop --status <pass|fail> --duration <seconds> \
  --on cable-0a --reach tailscale --net https --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519
```

### D3 — service add/remove, on its OWN fresh box [🟡⟳]
```sh
# (install a fresh box first, as in D0), then:
./dash run L3.addremove.desktop --on cable-0a --reach onion --net tor \
  --ip 192.168.1.167 --key /home/a/.ssh/pcname_ed25519 --token <API_TOKEN>
```

| id | scope | group |
|----|-------|-------|
| L1.onion-routing | 🟢 | D1 |
| L2.backend | 🟢 | D1 |
| L3.connect/login/services/providers/nextcloud/users/menus .desktop | 🟢 | D1 |
| L3.addremove.desktop | 🟡⟳ | **D3** |
| install.\<setup\> | 🔴 (wipes the target) | D0 |
| reach.\<route\> | 🟡🔑 (tunnel/DNS on the box) | D0 (after install) |

## Matrix — PLANNED (roadmap; add catalog stubs as you implement)
**D1 (shared 🟢):** dashboard · server-details · server-logs · memory-by-service · monitoring-charts ·
storage-view · services-catalog · service-detail · open-service-ui · users-list · user-details ·
devices-list · tokens-list · dns-view · providers-view · backups-list · app-settings · about ·
developer-settings · jobs-timeline
**D2 (shared 🔵, needs teardown):** user-lifecycle(create→ssh→pw→rm-ssh→delete) · device-lifecycle(authorize→revoke-that-one⚠) · recovery-key-rotate🟡
**D3 (fresh ⟳):** service-enable🟡 · service-settings🟡 · service-disable🟡 · service-move🔴
**D4 (fresh 🔑B2):** backup-config🟡→init🟡⟳→create🟡→settings🟡→restore🔴
**D5 (fresh):** auto-upgrade🟡 · timezone🟡 · ssh-settings🟡 · update-now🟡⟳ · reboot🟡
**D6 (isolated, terminal):** extend-volume🔴 · dns-rewrite🟡🔑 · provider-token-swap🟡🔑 · logout-active-device🔴⚠ · factory-reset🔴(last)
**Reach (not automated yet):** L3 over the one-hostname tunnels (`tailscale`, `cloudflare --name trycf`) · the VM over
any public route · the android app (all flows `@todo`).

**Interference:** enable/disable/settings ↔ services-list/catalog · restore ↔ everything ·
user create/delete ↔ users-list(admin) · revoke-active ↔ your session · recovery-key/provider-token/dns ↔ later auth/conn.

---

## Adding a planned test so `./dash report` tracks it
```json
{ "id": "L3.dashboard.desktop", "name": "Dashboard", "level": "L3",
  "category": "test", "client": "desktop", "networks": ["https","tor"],
  "clean_state": "read", "deployment_group": "D1",
  "repo": "../Manager-Ubuntu-SelfPrivacy-Over-Tor/flutter-app/selfprivacy.org.app",
  "cmd": "@todo" }
```
`clean_state`/`deployment_group` are free-form notes (dash ignores them today). The matrix places it on every
setup × reach row automatically (L3 rows = catalog `reach_rows`, columns = catalog `setups`).
