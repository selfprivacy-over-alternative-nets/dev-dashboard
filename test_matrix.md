# Test matrix — run by hand, track per commit

> Rule (enforced): **every command here is written in full with all args explicit, and the
> tooling REQUIRES them — no implicit defaults.** Omitting an arg fails fast telling you what
> to set. Reason: prove a random person on a random network/device can run these from the
> text alone; hidden defaults silently do the wrong thing and mask real bugs.

---

## How to run & see results
- Run one/many automated tests (see full commands below).
- Log a **manual** (click-through / video) result:  `./dash report <id> --status pass|fail --duration <sec> [--error "…"]`
- See what ran + output **per commit**:  `./dash serve 8099` → http://localhost:8099
  (or `grep <id> data/results.jsonl`). Each record carries `commit`,`dirty`,`diff_hash`,
  `status`,`duration_s`,`error`,`log_path` (full output in `logs/<run_id>.log`).
- **Storing ≠ publishing:** `data/`+`logs/` are local; push to the dashboard with `./dash publish`.
- Re-map a test→command: edit `catalog.json`. Fix a recorded row: edit its line in
  `data/results.jsonl` or re-`report` it.

## Your deployment values (fill these for YOUR rig; shown with the current pcname box)
```
FLAKE=/home/a/git/personal/selfprivacy/pcname-deploy      # the deploy flake (#pcname)
KEY=/home/a/.ssh/pcname_ed25519                            # ssh deploy key
MAC=d8:cb:8a:7c:0a:f4                                      # target NIC MAC
DOMAIN=weersurf.nl                                         # public domain
# IP depends on the setup:  lan-setup-0 -> 192.168.100.50   |  lan-setup-1/2 -> 192.168.1.167
```

## Two axes
- `--on` setup (where the box is): `vm-local` · `lan-setup-0` (direct cable, auto-netboot) ·
  `lan-setup-1/2` (via router R) · `usb`.
- `--net` transport (REQUIRED for L2/L3): `https` · `tor`/`onion` · `chutney`.

## Scope legend (decides sharing)
🟢 READ (no server change) · 🔵 REVERSIBLE (undoes itself) · 🟡 PERSISTENT (dirties baseline) ·
🔴 DESTRUCTIVE (data/connectivity/terminal) · ⟳ rebuild · 🔑 external (B2/DNS/provider)

## Deployment groups
D0 provisioning (the install) · D1 shared clean box (🟢, order-free) · D3 service lifecycle (fresh,⟳) ·
D4 backup lifecycle (fresh,🔑,ends🔴) · D5 system/settings (fresh) · D6 destructive/terminal (isolated)

---

## Matrix — RUNNABLE NOW (desktop), full commands
Replace FLAKE/KEY/MAC/DOMAIN/IP with your values above.

### D0 — install a fresh box (direct cable). Install-only (stays on the cable):
```sh
./dash run install.lan-setup-0 --on lan-setup-0 \
  --ip 192.168.100.50 \
  --env NETBOOT=auto --env TRANSPORT=none \
  --env FLAKE=/home/a/git/personal/selfprivacy/pcname-deploy \
  --env MAC=d8:cb:8a:7c:0a:f4 \
  --env KEY=/home/a/.ssh/pcname_ed25519 \
  --env DOMAIN=weersurf.nl
```
Full install **+ live public verify** (prompts you to move the box to router R, then checks
`https://api.DOMAIN`): same command with `--env TRANSPORT=https` (use `onion` for the Tor check).

Via router R instead of a direct cable (target already on R, no netboot):
```sh
./dash run install.lan-setup-1 --on lan-setup-1 \
  --ip 192.168.1.167 \
  --env NETBOOT=off --env TRANSPORT=https \
  --env FLAKE=/home/a/git/personal/selfprivacy/pcname-deploy \
  --env MAC=d8:cb:8a:7c:0a:f4 \
  --env KEY=/home/a/.ssh/pcname_ed25519 \
  --env DOMAIN=weersurf.nl
```

### D1 — read-only suite on that one box (order-free)  [🟢]
```sh
./dash run L1.onion-routing
./dash run L2.backend --net https --on lan-setup-1 --ip 192.168.1.167 --env KEY=/home/a/.ssh/pcname_ed25519
./dash run L3.connect.desktop L3.login.desktop L3.services.desktop L3.providers.desktop \
           L3.nextcloud.desktop L3.users.desktop L3.menus.desktop \
           --net https --on lan-setup-1 --ip 192.168.1.167 --env KEY=/home/a/.ssh/pcname_ed25519
```

### D3 — service add/remove, on its OWN fresh box  [🟡⟳]
```sh
# (install a fresh box first, as D0/router above), then:
./dash run L3.addremove.desktop --net https --on lan-setup-1 --ip 192.168.1.167 --env KEY=/home/a/.ssh/pcname_ed25519
```

| id | scope | group |
|----|-------|-------|
| L1.onion-routing | 🟢 | D1 |
| L2.backend | 🟢 | D1 |
| L3.connect/login/services/providers/nextcloud/users/menus .desktop | 🟢 | D1 |
| L3.addremove.desktop | 🟡⟳ | **D3** |

> ⚠ Still-implicit (make explicit when you wire them): the L3 flows get `DOMAIN`/`API_TOKEN`
> via dart-defines from the harness connect-config, not from the command line yet. Same rule
> should apply — pass them explicitly per run.

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
`clean_state`/`deployment_group` are free-form notes (dash ignores them today).
