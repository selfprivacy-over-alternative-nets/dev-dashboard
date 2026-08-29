# SelfPrivacy dev dashboard

A **full-width, CLI-style test matrix** that shows — per commit and per (even uncommitted) code
config — **what works, what doesn't, and how fast**, across the SelfPrivacy-over-alternative-nets
stack. One orchestrator script runs/times/records every command; the board publishes to GitHub Pages.

- **Live:** `https://selfprivacy-over-alternative-nets.github.io/dev-dashboard/`
- **Local (with videos & raw logs):** `./dash serve` → http://localhost:8099/

## The three axes

The app-usage matrix is 3-dimensional, exactly as requested:

- **rows** = the test / flow,
- **columns** = the **installation method** — *where/how the backend runs* (VM same device, VM other
  device, native ethernet, native USB→NVMe, native bootable USB),
- **3rd dimension** = the **network** (tor · chutney · https · future ygg/hypha) shown as sub-columns
  you toggle up top.

A dedicated **installation** row shows how long each deploy took (network-independent), so install
times and test times sit in the same matrix.

### Levels (also explained in-page)

- **L1 — unit:** pure Python logic in the API (onion/URL routing). No VM, no network. Milliseconds.
- **L2 — integration:** a real NixOS backend boots in the automated test-VM; routing checked per
  network. No app.
- **L3 — app usage:** the SelfPrivacy app is driven like a user (open → Providers→Services→back →
  add a service …) against a running backend, and **screen-recorded**.

`unit` is deliberately **not** a network column.

## One command: run everything this host can

```bash
./dash here --long     # sudo-start Tor, build the VM via build-and-run.sh, run L1+L2, launch+record the app, publish
./dash here            # quick: use a running backend if present, else tell you how; run L1+L2
```

`--long` does the full chain: a **preflight** first handles anything needing sudo (starts host Tor),
then it builds/starts the backend VM through the Manager repo's own `build-and-run.sh` (no edits to
that repo), runs L1 + L2, and finally runs the **automated** Flutter integration test over Tor and
**screen-records it** (no manual clicking). Flags: `--fast` (skip L2), `--no-publish`, `--no-install`.

The automated app test lives in **this** repo (`flutter/providers_flow_test.dart`). At run time `dash`
injects it into the app package + adds the `integration_test` dev-dependency, runs
`flutter test integration_test/… -d linux`, then **restores the Manager repo byte-for-byte** — so the
test is fully automated yet the Manager submodule is never left modified.

> First time only, the app build needs its Linux deps:
> `(cd ../Manager-Ubuntu-SelfPrivacy-Over-Tor && ./scripts/requirements.sh --app-linux)`.

## Or run individual pieces

```bash
./dash run L1.onion-routing                          # unit, ~30s
./dash run L2.backend --net tor                       # or --net https
./dash serve                                          # look now (localhost:8099)
./dash publish                                        # commit + push → live board updates
```

`--net` picks the transport, `--on` picks the install method the backend runs on, `--record` screen-
records the client UI. Every run appends to `data/results.jsonl`; nothing is overwritten, so repeated
runs **stack newest-first** in a cell. Label a dirty tree to compare WIP variants:

```bash
./dash run L3.addremove.desktop --net tor --on vm-local --config "socks5 retry patch"
```

Pick a **commit** in the top bar, then its **config** dropdown, to drill clean vs each uncommitted diff.

## Recording client-side tests (see it work)

L3 runs capture three artifacts, inspectable by unfolding a cell:

- **UI video** — screen recording of the app (ffmpeg/x11grab or wf-recorder via `--record`).
- **client CLI log** — everything the launcher printed.
- **server log** — pulled from the backend if you pass `--server-log 'ssh … journalctl -u selfprivacy-api -u nginx …'`.

GitHub Pages can't serve video reliably, so on the live site these show as **placeholders**; run
`./dash serve` locally to actually watch/inspect them. The Flutter flow itself lives in the app repo:
`flutter-app/selfprivacy.org.app/integration_test/providers_flow_test.dart` (Providers→Services→back).
Wire it into the catalog by replacing the `@todo` cmd for `L3.*` once you've run it once.

## Results that ran elsewhere (USB / another machine)

The USB/bootable-USB/other-laptop installs can't run from here — log them after the fact (or over
SSH from the target), including the time:

```bash
./dash report install.native-usb-nvme --status pass --duration 1180 --config "v3 image"
ssh pi@host 'cd dev-dashboard && ./dash report install.native-ethernet --status pass --duration 735'
```

## Reading the board

🟢 pass · 🟠 slow (over the catalog time budget) · 🔴 fail · ○ **todo** (automated test not written
yet) · — **no runs** (nothing recorded — *nothing runs in the background*; start one with `./dash
run`) · ▶ has a recording · ᶜ = CI run. Hover a row for what it tests. Click a cell to **unfold** its
runs, errors, logs and video — errors live per-test, not in one separate list.

## Data model

One JSON record per run in `data/results.jsonl`:

```
run_id · ts · env(local|ci) · host
repo · commit · subject · dirty · diff_hash · config_label     ← commit + dirty-config drilldown
id · name · level · client · transport(network) · method(install) · backend
status(pass|slow|fail) · duration_s · exit_code · error
artifacts{ client_log, server_log, video }
```

`status`: exit 0 → pass, exit 0 but over `budget_s` → slow, else fail. `env` is `ci` when
`$CI`/`$GITHUB_ACTIONS` is set.

## Demo data

The board defaults to **real data only**. `./dash demo` adds clearly-labeled illustrative records
(purple, `demo:true`) so you can see the full 3-axis layout; tick **demo** in the top bar to show
them (a banner makes it obvious), or `./dash clear-demo` to remove. This is why install times you
never ran only appear when demo is on.

## Publishing & security

`.github/workflows/pages.yml` deploys on every push to `main` (auto-enables Pages on first run).
Raw logs (`logs/*.log`, `*.server.log`) and videos (`media/`) are **git-ignored** — kept local, since
they can contain live `.onion` addresses — so media links work under `./dash serve`, not on Pages.
Published error summaries have `.onion` scrubbed to `<onion>`.

## Safety checks (before running on untrusted / café wifi)

`dash serve` binds **`0.0.0.0:8099`** (see `cmd_serve`) and serves this whole dir — `logs/`, `media/`,
`data/results.jsonl` — which can contain live `.onion`s and tokens. The chutney test-net binds
`0.0.0.0:7100–7108`. So on a shared network these are reachable by anyone **unless** a firewall blocks
them. Check first:

```bash
# 1. What is reachable from the LAN? (anything NOT on 127.x / ::1)
ss -ltn | awk 'NR>1 && $4 !~ /^127\.|^\[::1\]/ {print $4}'

# 2. Is the firewall actually on? (want: "Status: active", default deny incoming)
sudo ufw status verbose
```

Harden — pick **A** (firewall) or **B** (bind to loopback):

```bash
# A) turn the firewall on (default-deny inbound; safe here — no host service needs inbound)
sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw enable

# B) bind services to loopback instead
#   dash:  cmd_serve → HTTPServer(("127.0.0.1", port), …)   # currently ("0.0.0.0", port)
#   VM ssh forward → loopback (tunnel still works via localhost):
VBoxManage controlvm "SelfPrivacy-Tor-Test" natpf1 delete ssh
VBoxManage controlvm "SelfPrivacy-Tor-Test" natpf1 "ssh,tcp,127.0.0.1,2222,,22"
#   chutney: only run on a trusted network (relays bind 0.0.0.0:7100-7108)
```

**Don't run `dash serve` or the chutney net on public wifi without A or B.** After hardening, re-check with
command 1 — it should print nothing outside `127.x`.

> `setup-theory7-https.sh` installs a local **mkcert** root CA (system + Firefox) — browser-trusted HTTPS for
> the VM (`https://theory7.weersurf.nl`). Guard `~/.local/share/mkcert/rootCA-key.pem` (never copy/sync it);
> `mkcert -uninstall` to revoke. See `../handover2.md`.

## Layout

```
dash                     orchestrator: run · wrap · report · serve · publish · demo
catalog.json             the tracked matrix (generated by tools/gen_catalog.py)
tools/gen_catalog.py     edit to change what's tracked
tools/gen_demo.py        illustrative demo data
index.html app.js style.css   the static full-width matrix (no build step)
data/results.jsonl       append-only results (published)
logs/  media/            raw logs + recordings (local only)
```
