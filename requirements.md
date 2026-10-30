# Test requirements

## Commands & reproducibility
1. Every command (in docs and chat) must be written in full, with all arguments explicit.
2. All CLI arguments are required — no implicit defaults that silently change behaviour.
3. Commands must fail fast, stating exactly which argument to set, when one is missing.
4. The goal is that a random person on a random network/device can run the tests from the written commands alone.
5. The test commands are run manually by the human, not by an AI that can resolve intermediate issues.
6. An argument must be required only if silently defaulting it could make the run test the wrong thing or hit the wrong target unnoticed; values that are purely derived from a required argument (e.g. EXTRA from FLAKE) or are mere timeouts may keep defaults.

## Test matrix & scope
7. Provide integration tests covering the whole UI / Flutter app.
8. Every test has an accompanying recording, and the recording must correspond to what the test actually tests.
9. Determine which tests can run on a single deployment and which interfere (require a fresh deployment).
10. A test requires a fresh deployment when it changes settings/state that another test relies on relative to the clean/initial deployment.
11. Group tests by whether they can share one deployment vs. must be isolated.
12. Each test declares the repos it depends on; this scopes both its state identity and its clean-state gate.
13. Structure: test group (A) with a command to run the whole group; tests within a group (A.1) each with a command to run just that test.
14. Keep `N/A` for entries/combinations that are not available.

## Networks
15. Supported networks (the transport the app speaks, `--net`): Tor, Chutney (harness: private Tor test network), Https; roadmap: Yggdrasil, Hyphanet. Since the setup-diagram alignment (req 168) the matrix rows are **reach rows** — the diagram's Reach × Name views + the harness-only rows — each tied to one of these transports. The former Tor+https / Chutney+https placeholder rows (no test, no diagram view) are kept as **greyed-out**
    rows (req 184).
16. Per test, record which network SelfPrivacy uses.
17. Per network, record in which network setup the test was run.
18. Per network setup, record whether it was run Locally or on CI.

## Network setups
*(Setup ids = the setup diagram's Install × Network views, `<method>-<net>` — renamed 2026-10-30, req 168. The old ids in brackets are still accepted as aliases.)*
19. `vm` (was `vm-local`): VirtualBox VM on the host (build-and-run.sh), no external wiring. The diagram's VM view has no Network toggle.
20. `cable-0a` (was `lan-setup-0a`): direct cable, router out of path, netboot install; cable later replugged into router R for its IP; no wifi config.
21. `cable-0b` (was `lan-setup-0b`): as cable-0a, plus a wifi config for the same router R.
22. `cable-0c` (was `lan-setup-0c`): as cable-0a, plus a wifi config for a different router (the diagram's Y).
23. `cable-0d` (was `lan-setup-0d`): direct-cable install; cable later removed; target runs wifi-only (wifi reaching the internet).
24. `wifi-0a` (was `lan-setup-1`): laptop on router R's wifi, target wired to R (requires R configured for netboot).
25. `wifi-0d` (was `lan-setup-2`): laptop and target both on router R's wifi (requires R configured for netboot).
26. `usb-0a`: installer USB → target internal disk (manual boot); target wired to router R for internet.
27. `usb-0d` (new; replaces `usb-0b`, which the diagram has no view for): as usb-0a, but the cable is removed — target runs wifi-only.
28. `usb-0c`: as usb-0a, plus a wifi config for a different router (the diagram's Y).
29. Use one diagram per setup family (direct-cable family, usb family) to avoid duplication, without altering any option.

## Stamping & deployment identity
30. Tests must only ever run against the most recent / desired code state.
31. The system must be able to determine whether a deployed box corresponds to a given code state.
32. The target is stamped at deployment with the identity of what was deployed.
33. The stamp is based (hash-wise) on the list of repos, branches and commits used for the deployment.
34. Dirty deployments are not permitted; if dirty, that must be indicated with a hashsum of the dirtiness.
35. A test that uses the target retrieves the stamp from the device and links it to the code states it knows (locally or in committed history).
36. A test that uses the target verifies the stamp first and refuses to run if it is not the desired state.
37. This applies to every install method, including USB.
38. A manual/USB test is one uninterrupted chain: prompt to insert the USB and confirm "did you install it on the target?", then continue into the test.
39. When the box cannot be verified, distinguish "reachable but not stamped" from "unreachable".
40. Tests error if the flake.lock does not correspond to the selfprivacy-api checkout (rev differs or checkout dirty).
41. The dashboard shows an additional warning when the api checkout ≠ the deployed flake.lock pin (similar to the dirty warning).

## Dirty / clean state & integrity
42. At the start of a test, verify the code state is not dirty; if code changed, ask to commit the current state before running, so all tests run on the same code.
43. The clean-state gate checks all repos a test uses, not just one.
44. A submodule's working checkout must match the superproject's recorded pointer (no drift); otherwise refuse.
45. Test-result data must not be a factor in the clean-state check (so multiple tests can run back-to-back without each run dirtying/altering the code state).

## Results storage
46. Commit all test-result data except videos.
47. Videos are local-only artifacts; never committed.
48. Store results in a separate repo (testresults) so recording results never dirties or changes the code commit.
49. Results are keyed by the code state, so recording a result does not change that state.
50. Easily see which commands were already run and what their output was, per commit/state.
51. Be able to correct what is recorded for which test.

## Dashboard / visualization
52. An additional dashboard, based on the current one.
53. Scroll through branches and commits (states) and reload the accompanying test history on selection.
54. Hierarchy per test: test group → test → network → network setup → Local/CI.
55. The selectable state at the branch/commit level is the whole repo combination (all repos/commits used), not a single repo.
56. Per test run configuration, fold down the list of past runs for that configuration on the same state.
57. Collapsing a test shows only the latest result for each configuration.
58. Show pass / fail / N/A.
59. Click a status dot to see that run's log/output.
60. For local runs, view the recordings (both screenshots and videos).
61. Commands are not always shown; they appear on hover, with a clickable copy item in the top-right corner.
62. Hover/click the dirty-state warning to see which repos and branches are dirty.
63. Show all repos and branches a test uses (even when clean) and the commits per branch per repo, so the exact config under test is visible.
64. Display the deployed flake.lock pins for the selected state.

## CI vs local
65. Record, per run, whether it was executed Locally or on CI.
66. In CI, the recorded repo/branch/commit is whatever CI checked out (the committed refs from the git server).

## Dashboard / visualization (status model)
67. The matrix is catalog-driven: it shows every test as the overview even with no results — each applicable network × setup × {Local,CI} cell defaults to ☐ todo.
68. Cell statuses are todo / pass / fail / N/A (N/A for an unsupported network or a non-applicable setup).
69. Hovering a ☐ todo cell shows the exact command to run that test (with a copy button).

## Setup availability (preflight)
70. At the start of a test, verify the specified setup is available, as far as it can be checked.
71. USB setups: a USB device is present (and empty, if emptiness is required).
72. Wifi setups: a wifi spec (SSID, plus credentials as needed) must be specified.
73. Verify the specified wifi is in range / yields internet only when that is possible without disturbing the current wifi connection (e.g. a scan confirms the SSID is in range; the PASSWORD can only be verified by associating, so it is tested only when a wifi radio is free — not the one in use — otherwise it is flagged as not-verified (orange warning); internet-through-it is not checked if that would require connecting).

## Dashboard / visualization (explanatory hovers)
74. Hovering a test group (level) or a test shows a brief explanation of what it tests (sourced from the catalog `levels`/`desc`).
75. Hovering a ⚪ N/A cell shows a brief reason it is not available: a roadmap transport that is not implemented yet (catalog `future_networks`), or not applicable because that test does not exercise that transport.
76. The matrix shows a sub-header row under the setup columns indicating the Local/CI split (each cell holds two dots: local, then CI).

## Integrity — a result must reflect the committed code (no silent green)
77. A pass must mean the committed code of the recorded state actually ran; any divergence between what runs and the intended code must be detected — refuse or fail, never a silent pass.
78. Pins recorded for a run, and the pin gate, are read from the flake.lock that actually governs that run's build: a self-contained test uses its OWN flake.lock, not the backend's.
79. The pin gate checks every input the governing lock pins (e.g. selfprivacy-api AND manager), not only the api.
80. A nix build that reused an existing output (nothing built; no VM ran) is flagged (from_cache), not shown as a fresh run.
81. An output fetched from a binary cache (substituted — built elsewhere, not run here) is flagged.
82. A self-contained test's nixpkgs matches the deployed backend's nixpkgs (test ↔ production parity).
83. L3 drives the app with a pinned toolchain (the app flake's flutter) and resolves deps with the lockfile enforced; a toolchain/dep mismatch fails loud instead of silently regenerating the lockfile.
84. The box-identity check measures the box's actual running system (/run/current-system vs a baseline recorded at install), not only the install-time stamp.
85. A run forced past a gate (--allow-dirty) is recorded and shown as forced — never indistinguishable from a clean pass.
86. Manually-reported (click-through/video) results are marked manual/self-attested, distinct from automated runs.
87. A transient/flaky retry attempt is retained (marked flaky), not deleted, so intermittent failures are not hidden.
88. A checkout behind its tracked upstream blocks the run (after refreshing the remote ref); bypass only with --allow-dirty (then recorded as forced).
89. A live target address (e.g. the backend .onion) is read live from the backend, not from stale local state.

## Integrity — to implement (Track 2)
90. L3 real-data assertions run against a known-clean backend baseline: mutable state (userdata, enabled services, users, DB) is snapshot/restored (or reset) per flow so a result reflects the code, not leftover state; what the reset cannot cover is logged.
91. The clean-state check also catches build-affecting inputs invisible to `git status`: gitignored files (e.g. users.nix, .env) and a non-hermetic nix config (sandbox disabled / --impure).
92. The recorded state identity is the exact build closure (derivation path/hash), not only the three input pins.

## Dashboard / visualization (run history & flakiness)
93. One circle never represents multiple runs; each run is its own circle.
94. A config's runs are shown chronologically: collapsed shows only the most recent; expanded shows the full sequence, newest on top → oldest on the bottom.
95. Flakiness is represented by the green/red sequence of per-run circles, not by an aggregate marker or count.
96. Each run circle links to that run's log/media.
97. A run carrying trust qualifiers (forced/manual/cached/substituted/behind) is marked per-run (e.g. a ring), distinct from a clean run.

## Integrity — L3 backend targeting (Track 2, item 1a)
98. L3 desktop flows run against the backend named by the test args (`--on <setup>`): `vm` → the local VirtualBox VM; `cable-0a/0b/0d/0c` / `wifi-0a/0d` / `usb-0a/0d/0c` → a deployed physical box reached over the LAN. The backend is never hardcoded to the VM.
99. Running an L3 flow against a box requires `--ip`, `--key`, and `--token`; the box's API token is per-box and secret, so it is never defaulted (reproducibility reqs 1–6). Missing args fail fast, naming what to set.
100. For a box the dialed address is read LIVE from the box (req 89), never from stale local state: the onion from `/var/lib/tor/hidden_service/hostname`, the https host as `api.<domain>` where `domain` comes from the box's `/etc/nixos/userdata.json`.
101. `chutney` is a laptop-local private Tor network, valid for `vm` only; a box is reached over `tor` (real onion) or `https` (public domain, system-trust LE cert — no tunnel/mkcert CA). An unsupported network×setup combination is rejected fast.
102. An L3 run records the real setup as its `method` so the result lands in the correct matrix column; for a box, the deployment provenance the box-identity gate computed (stamp, measured running-system, box repos+pins) is recorded on the run.
103. The clean-state, pin, and behind-upstream gates apply to every gated run — a test (identified by its `level`) as well as an install — not only installs. The L3 inner recorder does not re-gate a run whose outer run_entry already gated it.

## Integrity — clean per-L3 backend-state baseline (Track 2, item 1b, req 90)
104. Around each L3 flow the backend's mutable SP state (`/etc/nixos/userdata.json`: enabled services = `modules.*.enable`, users, dns/server/provider config) is snapshotted before the flow and restored after, so a real-data assertion reflects the code, not leftover state. Target-aware (the VM or the box the run used).
105. The pre-flow state is compared to a captured known-clean golden baseline (keyed by the deployed backend's state identity + setup); drift is recorded (`l3_baseline_match`/`l3_baseline_drift`) and surfaced, not silently absorbed into the result.
106. The golden baseline is blessed right after a fresh install — explicitly via `dash l3-baseline capture --on <setup> …`, or auto-captured from the first flow's pre-state with a loud note that it assumes a fresh install. It stores only a state hash + the module/user summary — never secrets.
107. Restore is hybrid: service-enable changes are reverted via the `enable/disableService` mutation (which triggers the real rebuild), and any remaining `userdata.json` fields are file-restored; the restore reads the backend's `.onion` live.
108. What snapshot/restore cannot cover is listed on the run (`l3_state_uncovered`) and logged — service DB/app content, a created user's home dir + password hash until the next rebuild, backups already pushed to a provider, DNS records created at a provider, and a disabled service's torn-down unit when no Tor mutation channel was available. No silent caps.
109. Per-deploy local state (keepass secret DBs, L3 golden baselines) is git-ignored; the raw `userdata.json` is used only in-memory for restore and is never recorded or persisted.

## Integrity — hidden build inputs (Track 2, item 2, req 91)
110. The clean-state check also catches build-affecting files that `git status` cannot see: a catalog `guard_paths` file (e.g. users.nix, .env, .envrc, flake.local.nix, local.nix, secrets.nix) that is gitignored AND present in a repo under test is recorded (`guard_files`, with a content sha) and warned. A tracked guard file is already in the committed state, and an untracked one already trips the dirty gate — so only the gitignored+present (truly invisible) case is surfaced.
111. A self-contained nixosTest VM build must be hermetic: if the host nix `sandbox` is not `true`, or the build command passes `--impure`, the run is refused (recorded `hermetic`/`hermetic_problems`, with `nix_sandbox`/`impure`). Bypass only with `--allow-dirty` (then recorded as forced). This catches host state leaking into a build that is supposed to reflect only the committed code.

## Integrity — full build-closure identity (Track 2, item 3, req 92)
112. The recorded state identity is the exact build closure, not only the three input pins (api/nixpkgs/manager). A self-contained test (L1/L2) records its derivation path (`drv`/`closure`, via `nix eval <attr>.drvPath` — which captures every transitive input); a box run records the box's running-system store path (`closure`). A short hash of the closure is folded into `state_id` so two builds that differ only in a transitive input cannot collide on one identity.
113. The matrix surfaces the closure per run (in the run-history drawer) and flags closure divergence: more than one distinct build closure across runs on the same code-state key means a transitive input changed (same commits, different actual build). The sidebar grouping stays by repo-commits so a code state still shows all its tests together.

## Harness UX — fail fast before I/O
114. Args-only preconditions are rejected before any git fetch / lock read / SSH: a no-op entry (@todo/@manual) or an L3 run whose args can't work (no --on; a box setup missing --ip/--key/--token; chutney on a box; an android client not yet supported) fails in milliseconds, instead of paying per-entry base-building (notably `repos_behind_upstream(fetch=True)`'s `git fetch`). The authoritative box checks (reachability, live onion/domain, stamp identity) still run for valid args.

## Reproducibility — retargeting the rig to new hardware
115. Pointing the netboot + deploy rig at a different target device is a single scripted, explicit-args operation — not a hand-edit and not an AI task. `dev-dashboard/tools/retarget_device.sh` discovers the new target's NIC MAC and disks from the running netboot installer over SSH, then rewrites the two hardware-specific files (the `dnsmasq.conf` MAC→pinned-IP reservation and the `disko.nix` disk layout, by stable by-id), with backups, a confirm before wiping, and single- or dual-disk support.

## Integrity — install-method must match the claimed column
116. The deployment stamp records the install method, and a test that runs against a box verifies it: a result only lands in an install-method column (usb vs lan/netboot vs vm) if the box was actually installed that way — matched by family, since the fine `a/b/c/d` variants share one install. Otherwise the run is refused (bypass `--allow-dirty`, recorded as a method mismatch), so e.g. a `usb-*` cell can't go green against a lan-installed box.

## Install UX — verify the right target device
117. The harness helps you install to the RIGHT physical device, not just the right code. `dash find-target` discovers candidates — the netboot DHCP leases first (a device that booted into the installer), then a scan of every connected LAN incl. the direct-cable netboot subnet — shows each MAC+IP, and asks you to confirm the one matching the MAC shown on the target's own screen before printing the install command. The install itself stays MAC-locked (it finds/adopts the box only by the MAC you pass), so it can never silently talk to a different machine.

## Install UX — adapt to the target hardware
118. Installing to a DIFFERENT physical device adapts automatically: before writing anything, the install checks whether the deploy flake's disks (by stable id) exist on the target and, on a mismatch, retargets the disk layout (+ netboot MAC pin) from the target's real hardware — asking ONCE, up front, which disk to WIPE. A disko pinned to one machine's serials isn't portable; the install adapts instead of failing with a cryptic disko error.
119. The fine install setups are runnable ids: `install.cable-0a..0c` / `install.wifi-0a|0d` / `install.usb-0a|0d|0c` resolve to their Install method's installer (`install.cable` / `install.wifi` / `install.usb`) while recording the fine setup as the method; `install.vm` is the VM. A setup that leaves the target on wifi (cable-0b/0d/0c, wifi-0d, usb-0d/0c) requires a wifi spec (`--env WIFI_SSID=…`), verified in range by a non-disruptive scan (reqs 72–73) before anything is written.

## End-to-end flow (install a box → test it) + where secrets live
*(Visualised in the README: `docs/deployer.svg` = what the installer is made of + what you provide;
`docs/flow.svg` = the 3 steps below.)*

120. The whole flow is three steps; each prints what you feed the next:
   - **0. Get ready** — cable the device to this laptop, boot it in UEFI network mode (it shows its MAC),
     then start the address server: `sudo bash ~/netboot/start-netboot-server.sh` (leave it running).
   - **1. Find the device** — `./dash find-target` → prints the target's MAC + IP, e.g.
     `MAC 80:e8:2c:15:81:8b   IP 192.168.100.29`.
   - **2. Install** — paste the MAC + IP from step 1:
     ```
     ./dash run install.cable-0d --on cable-0d \
       --ip <IP-from-step-1> --key ~/.ssh/<your-key> \
       --env FLAKE=<path to selfprivacy-altnet-deployer> \
       --env MAC=<MAC-from-step-1> --env DOMAIN=<your-web-address e.g. selfprivacy.example.com> \
       --env WIFI_SSID=<your-wifi-name> --env WIFI_PSK=<your-wifi-password> \
       --env NETBOOT=auto --env TRANSPORT=none
     ```
     → it confirms which disk to WIPE `[y/N]`, installs, and prints `done` (auto-adapts disks + MAC to
     this device; see reqs 116/118).
   - **3. Test the running box** —
     ```
     ./dash run L3.connect.desktop --on cable-0d --reach portfwd --name buy --net https \
       --ip <box-IP> --key ~/.ssh/<your-key> --token <box-api-token>
     ```
     → `pass` (green) = it works; `fail` (red) → the log says why.
121. **Where sensitive data lives:** the wifi password, the box's API token, the TLS certificate and ssh
   keys are written only into the deployer's `state/` folder on this computer. `state/` is git-ignored and
   excluded from the mirror (`rsync --exclude state`), so it is never pushed/uploaded. To version it
   safely too, lock the whole folder with ONE passphrase — `age -p` over a tar of `state/` → one
   encrypted `state.age` (symmetric = post-quantum-adequate) that can go in a private repo.

## Install UX — fill in the flake automatically
122. After `dash find-target` confirms a target, it resolves the last two blanks of the install command for you (via `tools/resolve_flake.sh`): the deploy FLAKE is auto-found (the sibling folder whose `flake.nix` declares `nixosConfigurations.box` — i.e. `selfprivacy-altnet-deployer`; a list to pick from, or a prompt, if there are zero or several), and the DOMAIN is suggested from that flake. It then asks which network setup to use (cable-0a/0b/0d/0c — how the box gets online after install), prompting for the wifi SSID + password (entered hidden) only when the chosen setup needs wifi, and prints the fully-filled command (wifi password masked) and offers to run it.

## Install UX — the flow ends with the next steps spelled out
123. When an install finishes, the installer prints a **NEXT STEPS** block so the operator never has to
   reconstruct them: (a) the exact **L3 integration-test command** that drives the app against this
   backend (`./dash run L3.connect.desktop --on <the setup just installed> --reach <reach> [--name <name>] --net …
   --ip … --key … --token "$(ssh … secrets.json …)"` — the reach of the chosen public method, and the token as a
   command that READS it, never its value: reqs 171, 176); (b) the **5 DNS A-records** to add
   (`api`/`cloud`/`git`/`matrix`/`meet`.<domain>) pointing at the box's LAN IP (home access) or the
   router's public IP (public access + forward :443); (c) a **concise on-box command**
   (`ping -c1 1.1.1.1 && hostname -I`) to find the box's IP + confirm internet, for when the host can't
   see it (e.g. a wifi setup — after power-cycle the box is on a different radio/MAC/network). On the live
   path (box already online) the DNS records and L3 command are printed with the real IP already filled in.
   The suggested `--on` reflects the fine setup actually installed (`dash` passes `SP_SETUP`).

## Guided post-install finish (reboot → online → DNS → verify)
124. After an install, the operator can be walked through the whole finish **interactively**
   (`tools/finish_box_setup.sh`, offered automatically at the end of an interactive install and
   runnable standalone later): (1) prompt to **reboot** the box (wifi-only: unplug the install cable);
   (2) **wait** until it is reachable over SSH again (by `--ip`, or found by `--mac`, or typed in from
   the console's `hostname -I`); (3) **confirm it booted the installed system** (secrets.json present,
   not the in-RAM installer); (4) **verify internet**; (5) **read the box's public IP** (and LAN IP);
   (6) print the **5 DNS A-records with that IP already filled in**; (7) ask **"did you enter them?"** and,
   on yes, **verify they actually resolve** to that IP — querying PUBLIC resolvers (1.1.1.1 / 8.8.8.8) so
   the laptop's cache or `/etc/hosts` can't mask the result. Each record is classified: ✓ matches the
   public IP, ⚠ resolves to the box's LAN/private IP (home-only, not reachable from outside), ✗ wrong IP
   or not propagated yet; a re-check loop handles propagation delay. On success it prints the ready L3
   integration-test command. All CLI args explicit; `--domain`/`--key` required. Fully non-interactive
   installs (CI/pipes) are unchanged — the guided finish is only offered when a terminal is present.
   **Placement preserves timing integrity:** under `dash` the install runs in a captured pipe, so `dash`
   launches the guided finish on the real terminal only AFTER the install record is written — the human's
   time inside it (incl. DNS-propagation waits) never counts toward the install's recorded `duration_s`,
   so a clean install is never mis-marked `slow`. A standalone run of the installer (`stdout` is a tty)
   offers it inline instead. The two paths are mutually exclusive (keyed on whether stdout is a terminal).

## HTTPS tunnels (public reachability without router access)
125. A box behind double-NAT or a third-party gateway (no inbound port-forward possible) can still be
   reached from the public internet by an **outbound tunnel the box dials itself** — nothing is forwarded
   IN. `tools/add-cloudflare.sh` wires this up over SSH, offered interactively at the end of an install
   (`e2e_install_native_ethernet.sh`) or run standalone later.
126. It asks **three things, with no silent defaults**: (1) *Do you already have a paid domain?* → it
   prints the exact DNS records to set; (2) *Do you want a free domain?* → a Cloudflare **quick** tunnel
   needs none (random `*.trycloudflare.com`), or register a free **custom** domain at `https://nic.eu.org`
   and pass it in; (3) *transport* = `cloudflare` (free), `ngrok` (free tier = random `*.ngrok-free.app`),
   or `router` (free but needs admin on every NAT hop).
127. **Cloudflare** transport: with no domain → an account-less **quick tunnel** fronting the
   `api.<box-domain>` vhost only (URL is temporary, changes on restart); with a `--domain` → a
   **headless named tunnel** — you create the tunnel in the Cloudflare dashboard on your laptop and paste
   its **connector token** (`--cf-tunnel-token`); the box only runs `cloudflared tunnel run --token …`,
   installed + started over SSH. The 5 public hostnames (api/cloud/git/matrix/meet) are added once in the
   dashboard (each auto-creates its DNS CNAME). **Nothing is ever typed on the box** — no on-box
   `cloudflared tunnel login`.
128. **ngrok** transport: installs ngrok on the box (unfree → `--impure`), takes the free authtoken, runs
   `ngrok http https://localhost:443` with the box's Host header; a custom domain is a paid ngrok feature
   (called out explicitly).
129. **router** transport: not automatable for arbitrary routers — it prints the port-forward
   (`TCP 443 → <box-lan>:443`) + the 5 A-records at the public IP, and defers DNS verification to
   `finish_box_setup.sh`.
130. Whatever the transport, the tunnel runs as a **persistent systemd unit** on the box (cloudflared/ngrok
   installed into root's nix profile = gc-rooted, survives reboot), and the script ends by printing the
   `./dash app` / `--dart-define=HTTPS_DOMAIN=…` command and the matching `./dash run L3.connect.desktop --on …
   --reach … --net …` line (or, over a one-hostname tunnel, the `./dash report` line), with the token as a
   command that reads it over SSH — never its value (reqs 171, 176). A route that did not come up (no tunnel
   URL, service not active, not publicly reachable, a human step needed under `SP_NONINTERACTIVE`) makes it
   exit non-zero, so a `reach.*` run is never recorded as a pass: under `SP_NONINTERACTIVE` every route must
   answer `https://<host>/api/version` from the public internet (the install verifier's check) — onion: tor
   active with a published hostname — and a missing value (`need`) aborts instead of continuing empty.
131. All CLI args explicit; `--key`/`--ip` required; a non-interactive run must pass every choice
   (`--method`, `--domain-kind`, …) or fail fast — the same command reproduces the same setup for anyone.
   Preflight refuses to run unless the box is reachable **and** is the installed system (`secrets.json`
   present), not the in-RAM installer.
132. The public-access choice is made **up-front**, at the "your web address" prompt in
   `resolve_flake.sh` (right after the device is connected) — because the chosen method **decides the
   domain**, and the domain is baked into the box at deploy time (vhost routing + LE cert); asking it at
   the end would be too late. `add-cloudflare.sh --plan` asks the three questions with **no box needed**
   and hands back `DOMAIN` + method (`PUBLIC_METHOD` / `PUBLIC_DOMAIN_KIND` / `PUBLIC_CF_NAMED`) as
   `KEY=VALUE` on stdout; those flow via `--env` into the install and drive the end-of-install apply, so
   the domain is never asked twice and a Cloudflare **custom** domain is consistent end-to-end. A quick
   tunnel / free-ngrok / none keep the flake's **default** domain baked in — their public URL is decided
   post-install (random `*.trycloudflare.com` / `*.ngrok-free.app`).
133. The public-access apply is **embedded** and runs **entirely over SSH** — the operator never opens a
   shell on the box. When a method was chosen up-front, `finish_box_setup.sh` (which already rebooted the
   box, brought it online and discovered its IP) runs `add-cloudflare.sh` as its final **step 8** with
   that IP; `dash` and `e2e_install_native_ethernet.sh` forward `--public-method` / `--public-cf-named`
   to it. So `dash find-target` → install → finish → tunnel is one unbroken flow with **zero manual box
   interaction**; the only human step for a named tunnel is pasting a Cloudflare token on the laptop.
134. **Pinggy** transport (`--method pinggy`): an **SSH-based** tunnel the box dials out over `ssh -p 443
   -R0:localhost:443 … a.pinggy.io` — **nothing to install** (ssh is already on the box), run as a
   persistent systemd unit. Free tier = random `*.pinggy.link` with ~60-min sessions; a `--pinggy-token`
   (pinggy.io account) makes it persistent + custom. Caveat logged: SelfPrivacy vhosts are Host-routed on
   :443, so a Host-header rewrite may be needed for the api vhost.
135. **LocalTunnel** transport (`--method localtunnel`): installs `nodePackages.localtunnel` (`lt`) into
   the box's nix profile and runs `lt --port 443 --local-https --allow-invalid-cert --host
   https://localtunnel.me [--subdomain <prefix>]` as a systemd unit → `https://<prefix>.loca.lt`. Caveats
   logged: loca.lt shows a one-time browser interstitial (API/app clients send `Bypass-Tunnel-Reminder:
   true`), and it fronts ONE endpoint (Host-routed cloud/git/… need separate tunnels).
136. **Free-domain source** is a menu (`--domain-source`): **`eu-org`** (nic.eu.org — a real DELEGABLE
   domain whose NS point to Cloudflare; works with a Cloudflare tunnel AND the router method, but SLOW
   manual approval), **`duckdns`** / **`afraid`** (instant, but A/TXT only — **router method only**, they
   can't host a Cloudflare tunnel's CNAME/NS), or **`other`**. The menu states these limits honestly and
   steers tunnel users to `eu-org`. DuckDNS, when chosen for the router method, prints its dynamic-DNS
   updater line (it maps a name to YOUR public IP — still needs :443 forwarded).
137. **Direct IPv6** transport (`--method ipv6`): the only route that is reliable + no-port-forward AND
   **decentralised** (no relay) — because IPv6 has no NAT to traverse. It reads the box's global IPv6
   (`2000::/3`), fails fast with a clear message if the ISP is IPv4-only/CGNAT, and publishes an **AAAA**
   record for the chosen domain — for a `*.duckdns.org` domain with `--duckdns-token` it installs a
   persistent on-box updater (`duckdns-aaaa-sp`) that keeps the AAAA on the box's current IPv6 across
   reboots/prefix-changes; otherwise it prints the AAAA to set. The box's own Let's Encrypt provisions
   the cert. Caveat logged: visitors must also have IPv6. The route map lives in `docs/tunneling.puml`
   (rendered `docs/tunneling.svg`, referenced from `networks.md` → Tunneling) with the A–E scoring.
138. **Public vs private IP must ALWAYS be explicit** — in every operator-facing message AND in the
   code/comments. Any IP (or a command that yields one) is labelled either **LAN / private** (to connect
   to the box over the local network — `hostname -I` → 192.168.x.x) or **public** (reachable from
   anywhere, for DNS records / port-forward — `curl -s https://api.ipify.org` for IPv4, or
   `ip -6 addr show scope global` for the public IPv6). Never ask for or print "the IP" unqualified.
   Concretely: `finish_box_setup.sh` steps 1–2 ask for the box's **LAN IP** (only to SSH in) and read the
   **public** IP themselves at step 5; DNS-record prompts state LAN (home-only) vs public (from-anywhere);
   every `--ip` flag is the box's LAN/SSH address, never a public one.
139. **Tailscale Funnel** transport (`--method tailscale`): the recommended FREE way to reach the box
   from any IPv4 visitor behind an uncontrolled router (CGNAT/double-NAT) without IPv6 or port-forward.
   Installs tailscale on the box, runs `tailscaled --tun=userspace-networking` (no kernel TUN) as a
   systemd unit, joins the tailnet with a one-time **auth key** (generated in the admin console — nothing
   typed on the box), and `tailscale funnel https+insecure://localhost:443` → a **stable**
   `https://<host>.<tailnet>.ts.net` with a valid cert. One-time admin-console prerequisites (HTTPS certs
   + the `funnel` node attribute) are printed if Funnel isn't live. It's ONE hostname → the app connects
   at the apex (`HTTPS_APEX`); the full api./cloud./… suite still needs a real domain + CF tunnel/forward.
140. **IPv6 autodetect runs on the box's FINAL network, not the install path.** IPv6 is a property of the
   network the box ends up on — which for `cable-0c/0d` / usb variants can be a different wifi/router
   than the install cable or the laptop — so a pre-install check is meaningless. `tools/net_lib.sh`
   `box_global_ipv6` probes the box (post-reboot, in `finish_box_setup` step 4b) for a global-unicast
   (`2000::/3`) address with working v6 egress on ANY interface, and says to re-run if the box later moves.
141. **The box's domain is an install PARAMETER, never a hardcoded personal domain.** The deploy flake
   reads `./domain.local` (tracked, generic default `selfprivacy.box`); the installer dirty-overwrites it
   per deploy and restores the generic default afterwards, so a real/personal domain only ever enters as a
   chosen value and never lands in the committed codebase. Cert source (`cert-source.local`) defaults to
   `selfsigned` (any domain / tunnel), `external-le` when a real LE cert for the domain is injected.

## Robust prompts & tunnel apply (hardened 2026-10-09)
142. **Every interactive question validates its answer and re-asks until it's valid — it NEVER quits or
   silently defaults on a bad answer.** A single typo must never drop the whole flow (losing all prior
   answers). Only an explicit `n`/blank cancels where cancelling is meaningful; no-TTY / non-interactive
   runs fail fast naming the exact flag to pass, instead of looping forever. Enforced across: the
   `dash find-target` target pick + confirm; `resolve_flake.sh` (flake / network-setup / wifi SSID+PSK /
   run-now); `add-cloudflare.sh` `run_wizard` AND the flag-fallback (`need()` re-asks until non-empty;
   `ask_choice` re-asks fixed choices; domains validated via `is_domain`); `finish_box_setup.sh` (box LAN
   IP validates four octets 0-255; the "added the records?"/"re-check?" gates via a `yesno` helper); the
   `dash` "Finish setup now? [Y/n]" gate (an IP typed there re-asks with a hint, is not read as "no");
   `make_keepass_db.sh` master-password (re-ask until non-empty + matching); `e2e_install_usb.sh`
   device-path confirm (mismatch re-asks; blank aborts — it's a destructive erase, exact match required).
143. **The Tailscale auth-key step is self-explanatory and self-verifying.** The prompt prints
   step-by-step instructions (open the admin console, sign up if needed, Generate auth key, copy, paste),
   rejects anything not starting `tskey-`, and VERIFIES the key the only way possible — by joining and
   checking the box reaches `Running` — re-asking in place on failure. Keys are SINGLE-USE: a fresh key
   is needed for every setup (tick **Reusable** for several boxes). A rejected key is distinguished from a
   connectivity problem using the real `tailscale up` output, pointing at `journalctl -u tailscaled-sp`.
144. **When a step can't be reliably automated, the script captures the EXACT action and walks the
   operator through it — it never fails vaguely.** Enabling Tailscale Funnel is a one-time, browser-only,
   tailnet-owner consent: the script captures the exact pre-filled `https://login.tailscale.com/f/funnel?
   node=…` URL that `tailscale funnel` prints, shows click-by-click steps, waits, and retries until Funnel
   actually serves. Blocking remote commands (`funnel --bg`, `up`) are `timeout`-capped so a prompt can
   never hang the flow.
145. **On-box services are installed the NixOS-correct way.** `/etc/systemd/system` is a read-only
   Nix-store symlink, so imperative tunnel units are written to the writable `/run/systemd/system` and
   `systemctl start`-ed (not `enable`-d). Caveat logged: `/run` is cleared on reboot, so re-run the apply
   after a box reboot; true reboot-persistence would bake the unit into the deploy flake.
146. **Re-running an apply is idempotent and non-destructive.** The Tailscale apply authenticates only
   when the box isn't already on the tailnet — it polls `BackendState` after the (re)started daemon
   reconnects (absorbing the race), never passes `--reset`, so it never logs the box out or spawns
   duplicate nodes (`selfprivacy-1`, `-2`, …). `tailscale status --json` is parsed whitespace-tolerantly
   (`"Key": "val"` has a space after the colon — a naive `":"` matcher silently never matches).
147. **Every operator-facing command states WHICH DEVICE to run it on and is copy-paste-runnable.**
   Commands that SSH into the box say "on THIS laptop" (never on the box); the printed Flutter command
   includes `cd <…/selfprivacy.org.app> &&` so it runs from the app's own project root (where
   `pubspec.yaml` is), not from `dev-dashboard`.
148. **Single-hostname tunnels expose the API/app endpoint ONLY — set that expectation explicitly.**
   tailscale / cloudflare-quick / ngrok-free / pinggy / localtunnel each give ONE public hostname.
   Opening it in a browser shows the box's default nginx page at `/` and GraphiQL at `/graphql` — there
   is NO web login page; the server is managed from the SelfPrivacy app (point it at the host with
   `HTTPS_APEX=1`). The browser login frontends (`api.<domain>` → `/user`, Nextcloud `cloud.`, Forgejo
   `git.`, …) are name-based nginx vhosts; a single hostname reaches the API vhost only if the Host header
   matches `api.<domain>`, and **Tailscale Funnel cannot rewrite the Host header** (unlike ngrok /
   cf-quick `--host-header`), so over Funnel only `/graphql` (which the default server also serves) is
   reached and the app works while the browser frontends do not. Full browser / 5-subdomain access needs
   a real domain + a Cloudflare NAMED tunnel (or router port-forward / direct IPv6). **Open TODO:** make
   the SelfPrivacy API nginx the `default_server` on the box so the funnel host reaches the API vhost in a
   browser too (deployer-module change + box rebuild).

## North-star objective & reachability wait
149. **NORTH STAR: the whole `find-target` → install → finish → public-access flow must work end-to-end
   for a NON-TECHNICAL user ("grandma") on a random laptop and random home network, with ZERO manual
   device fixing.** This is the point of the project — not getting one SelfPrivacy box up, but perfecting
   the SCRIPTS so anyone can. Every rough edge hit while testing is a bug to fix **in the script** (wizard
   / deployer / apply), never a one-off patch typed on the box by hand. The operator — human OR AI — must
   not SSH into the box to make it work; if something only works after hand-fixing the device, the script
   is not done. Success = the user runs the printed commands only, answers plain-language questions, waits,
   and ends with a working public URL + the app connecting — understanding none of the internals. A
   developer re-installing repeatedly is a tester, not the target user; artifacts that only appear from
   repeated re-installs (e.g. duplicate tunnel identities) must be handled by the script, not blamed on
   the user.
150. **The apply WAITS until the box is actually reachable from the public internet, with visible
   progress — it never stops at "serving on the box".** Serving locally ≠ publicly reachable: tunnel
   providers (Tailscale Funnel, Cloudflare, …) publish public DNS for a NEW name minutes after it is
   enabled. `add-cloudflare.sh` `wait_reachable()` polls the public URL FROM THE LAPTOP (which uses public
   DNS, unlike the box's MagicDNS) until it responds — printing progress — up to a generous ceiling
   (`SP_REACH_TIMEOUT`, default 600s), and only THEN presents the app command. Each attempt is shown as a
   numbered check with elapsed time and a PLAIN reason derived from curl's exit code (6 = "address not
   published yet (DNS)", 7 = "not accepting connections", 28 = "timed out", 35/60 = "TLS/cert warming up",
   22 = "HTTP error") so the user sees it is actively doing something. Polling uses a GENTLE backoff
   (10→30s) — ~20 checks over 10 min, not 40 — to avoid hammering DNS / the tunnel provider and tripping
   rate limits. On timeout it explains in plain language and names the single likely cause (leftover
   duplicate nodes from repeated re-installs — a testing artifact, not something a one-time setup hits).
   The non-technical user just waits; they never debug DNS, delete nodes, or re-run by hand. (Applies to
   every single-hostname tunnel method, not only tailscale.)

## Known limitation (single-hostname tunnels)
151. **Live GraphQL subscriptions (WebSocket) don't work through a single-hostname tunnel yet — but
   queries do, and this is NOT a find-target bug.** Over Tailscale Funnel (and the other one-name
   tunnels) HTTP POST `/graphql` works, so the app connects and all one-shot data loads (domain, DNS,
   disk, service list). The app's live views (Services/Jobs/Logs) open `wss://<apex>/graphql` and fail
   with HTTP 400 "not upgraded to websocket". Same family as req 148: the funnel forwards `Host: *.ts.net`
   which doesn't reach the `api.<domain>` vhost carrying the websocket-upgrade proxy config, and the WS
   upgrade over the tunnel isn't negotiated. (Not reproducible with curl — curl negotiates the upgrade
   differently and gets 200 GraphiQL — so the precise failure point is unconfirmed.) The box API serves
   subscriptions fine on the LAN / `api.` vhost; this is a SelfPrivacy-stack/deployer gap, not the
   find-target flow. Candidate fix (deployer, needs redeploy + a real WS-client test): make the API vhost
   the `default_server` WITH the `Upgrade`/`Connection` headers so any Host — incl. the funnel apex —
   gets full API incl. subscriptions.
   **RESOLVED (root cause was NOT missing config):** the onion/default vhost's `/graphql` ALREADY has
   `proxyWebsockets = true` in `selfprivacy-tor-core.nix` (commit 6666528). The box lacked it because the
   deployer's `spbackend` `path:` input in `flake.lock` was **stale** (pinned pre-6666528 content) — so
   every reinstall deployed the old backend. Re-locking `spbackend` fixed it; `nix eval` confirms
   `virtualHosts.onion.locations."/graphql".proxyWebsockets == true`, so the Funnel apex now serves
   subscriptions. Tailscale was never the limitation. See req 152.
152. **A `path:` flake input must never silently deploy STALE source.** The deployer pins the Manager
   backend (`spbackend`) as a `path:` input; its `flake.lock` narHash does NOT auto-update when the
   backend changes, so committed backend fixes (e.g. the onion `/graphql` websocket upgrade) never reached
   the box until the lock was manually re-locked — a silent reproducibility hole that invalidated testing.
   Requirement: before an install/deploy, the deployer's `spbackend` (and any `path:` input) lock must be
   verified fresh against the current committed source — re-lock, or GATE like req 40/41 does for
   selfprivacy-api (fail/warn when `flake.lock` ≠ the checkout). A deploy must reflect the committed source,
   not a stale pin.

## Deploy-config completeness & explicit launch
153. **The deploy seed must provide EVERY `userdata.json` key the API resolvers read.** A missing key is
   a direct `KeyError` in a Strawberry resolver → the query returns `data: null` → the app's screen
   skeleton-loads forever (looks like "won't load", not an error). Concretely: `get_system_domain_info`
   (`selfprivacy_api/.../system.py`) reads `user_data["domain"|"hostname"|"dns"]["provider"]`; the seed
   (`secrets-seed.nix`) omitted `hostname` → `KeyError('hostname')` → the Domain&DNS "required DNS records"
   screen hung on skeletons. Fix = seed `hostname` (domain's first label). GENERAL rule: userdata
   completeness is part of deploy correctness; after install, smoke-test the key app queries
   (`system.domainInfo`, `services.allServices`, …) return non-null so a missing field can't silently hang
   the UI.
154. **`./dash app` requires every launch value EXPLICITLY — no cache, no auto-resolve (reinforces req 2).**
   It launches the Flutter app against the box's PUBLIC url (works from anywhere — the app reaches the box
   over the tunnel, not the LAN). Mandatory: `--domain`, `--token`, and `--apex`|`--no-apex`. It must NOT
   cache the target to a state file, must NOT SSH the box to auto-resolve the url/token, must NOT reuse a
   prior value — so the printed command is fully reproducible and can't silently hit a stale target (the
   `selfprivacy-5` vs `-6` trap). Auto-finding the local Flutter checkout dir (a derived local path) is OK.

## Tailscale account & credentials
155. **The Tailscale credential is an EXPLICIT input and the resulting domain is an OUTPUT — neither is
   ever a stored default.** (The auth-key prompt / sign-up / verify flow itself is req 143; this requirement
   only adds the input/output discipline.) The credential is a single-use **auth key** (`tskey-auth-…`),
   supplied explicitly (`--tailscale-authkey` or the interactive prompt), never baked in or defaulted; a
   fresh key is generated per install (req 143), exactly as a new user would. (No OAuth client / ACL-tag
   path — it adds setup a first-time user shouldn't face, and its only advantage was non-expiry for
   persistence, which the project does not do.) The resulting `<hostname>.<tailnet>.ts.net` is an OUTPUT
   discovered AFTER the node joins — printed, then passed explicitly to `./dash app --domain` — not a value
   the script stores, caches, or auto-reuses (reinforces req 2 / 154).
156. **No identity reuse or persistence — every install is a clean new-user install; node cleanup is a
   TESTER-only step run OUTSIDE the install flow, never a default install behaviour.** The project does not
   persist, reuse, or seed the Tailscale identity (no `--reuse`, no stored `tailscaled.state`, no stored
   credentials): each install reproduces exactly what a brand-new user goes through. A genuine new user has
   ZERO prior nodes, so node deletion is NOT part of their flow — only a developer re-installing repeatedly
   accumulates stale `selfprivacy*` nodes (a testing artifact, req 149). Before a re-test the tester deletes
   ALL stale `selfprivacy*` nodes (at least the one holding the clean base name) in the Tailscale admin
   console (login.tailscale.com/admin/machines) so the `selfprivacy` name is free. This MUST NOT be folded
   into the default install flow: the install must stay runnable with only an auth key, but node deletion
   needs a higher-privilege Tailscale **API key** that new users do not have — and a "default, no-arg" reset
   could only work by STORING that key, reintroducing the exact stored-default trap this discipline avoids.
   If the tester automates the cleanup it is a SEPARATE command taking the API key EXPLICITLY every run
   (never stored), run before the install, so the flow a new user experiences is byte-for-byte unchanged.
   Rationale: persisting/reusing credentials or state would (a) stop reproducing the new-user experience,
   (b) hide that new users do NOT have those credentials, and (c) bake in defaults for values that must
   remain variables.

## Tailscale pre-continue checks (block + guide, never auto-fix)
157. **The install VERIFIES the box got the clean `selfprivacy` name and BLOCKS with instructions until it
   does — it detects and guides, but never deletes nodes itself.** As soon as it can (right after
   `tailscale up` — the earliest the box has tailnet visibility without an API key), the script reads the
   box's assigned name from `tailscale status --json`. If the name carries a `-N` suffix
   (`selfprivacy-3`, …), a stale/dead node still owns the base name: the script PAUSES, prints
   `login.tailscale.com/admin/machines`, and tells the operator to delete ALL `selfprivacy*` nodes
   (including the just-created `selfprivacy-N`), then re-checks — looping (re-run `tailscale up` with a fresh
   single-use key, req 143) until the box registers as the clean `selfprivacy`, then continues. A genuine
   new user's account is empty, so this never triggers for them (invisible); only a repeat-installing tester
   hits it. The install only DETECTS and GUIDES the manual deletion — it never deletes (deletion needs a
   higher-privilege API key new users lack, and stays a manual browser step, req 156).
158. **The install VERIFIES Tailscale Funnel + HTTPS are enabled for the tailnet and BLOCKS with
   instructions until they are.** Funnel requires two one-time, tailnet-owner, browser-only settings (HTTPS
   certificates + the `funnel` node attribute) that a brand-new account lacks. If Funnel isn't live, the
   script PAUSES, shows the exact pre-filled `login.tailscale.com/f/funnel?node=…` URL it captured, tells the
   operator to enable HTTPS + Funnel, and re-checks — looping until Funnel actually serves, and only THEN
   prints the public URL. (Reinforces reqs 139/144; stated here explicitly as a gating check with the same
   detect → pause → re-check pattern as req 157.)

## ⛔ CARDINAL TESTING RULE — ONLY FULL, FROM-SCRATCH, NEW-USER RUNS COUNT
159. **A VALID TEST IS A COMPLETE RUN OF THE WHOLE FLOW FROM SCRATCH, AS A BRAND-NEW USER — NEVER A
   RESUMED, "FINISHED", OR HAND-PATCHED BOX.** The entire point is to prove a non-technical new user can
   complete `find-target → install → finish → public-access` end-to-end with ZERO hand-fixing (req 149).
   Therefore: ONCE A RUN HAS BEEN MUDDLED WITH — a mid-flow patch, a developer/AI intervention, a half-done
   state, or a bug worked around by hand — THAT RUN IS DEAD AND PROVES NOTHING. Do NOT offer to "just finish
   the box", resume the apply, or continue from the broken intermediate state; a box reached by any path
   other than the one-shot new-user flow is NOT evidence the flow works. AFTER ANY FIX TO A SCRIPT, THE ONLY
   VALID NEXT STEP IS TO RE-RUN THE ENTIRE FLOW FROM THE VERY BEGINNING (A FRESH REINSTALL). (Reinforces
   reqs 5, 10, 42, 149 — tests run on a clean state, from the written commands alone.)

## DOMAIN, DNS & Services fixing with TAILSCALE
160. **On a Tailscale (single-hostname tunnel) setup the app's Domain tile MUST SHOW THE DOMAIN — a real
   value, never a grayed-out / skeleton box — even though DNS management is Not-Applicable
   (`DnsProvider.NONE`).** For this instance/user the shown domain must be the live funnel URL
   **`https://selfprivacy.<tailnet>.ts.net`** (e.g. `https://selfprivacy.tail6ab1a9.ts.net`). "No DNS
   provider to manage" must degrade to "nothing to configure here", NOT to a blank/greyed Domain box.
161. **On the Domain & DNS screen (Providers → Domain and DNS) the per-service required-DNS-records
   section — the `Services` / `Emails` / `Other` categories under "Type 'A' records required for each
   service" — MUST RENDER, never skeleton-load forever.** For a tunnel / provider-NONE setup
   `requiredDnsRecords` is `[]` (nothing to create), so this section must resolve to an empty / "no records
   needed" state, NOT perpetual loading placeholders. (CONFIRMED via screenshot 2026-10-11: the domain
   header shows the funnel URL `selfprivacy.tail6ab1a9.ts.net` and "Records are OK" renders — req 160 met —
   but this required-records list is stuck on grey skeleton bars. handover13's "app needs NO change" claim
   was wrong for this section. The left-nav **Services** tab, driven by `services.allServices`, loads fine;
   this is specifically the Domain & DNS records list when there are zero required records.)
162. **Both outcomes MUST BE CONFIRMED VISUALLY** — a screenshot of the running app showing (a) the domain
   and (b) the services list populated. **Logs / backend GraphQL probes are NOT sufficient evidence** —
   they have produced false positives. A "pass" requires the pixels, not just a 200 from `/graphql`. If a
   failure is only tunnel-propagation latency (the public `.ts.net` address not live yet), say so
   explicitly and distinguish it from an app/backend bug.
163. **The app connects over a single-hostname tunnel on an IPv4-only client — and it DOES, no fix
   needed.** Tailscale Funnel publishes BOTH AAAA (IPv6) + A (IPv4). VERIFIED 2026-10-11 with a standalone
   Dart test: the default `HttpClient` returns **HTTP 200 in ~700ms** when AAAA+A both resolve on this
   IPv4-only laptop — it falls back from the unreachable IPv6 to the working IPv4 by itself. **Correction of
   an earlier wrong diagnosis in this file's history:** the original "Network is unreachable (errno 101) /
   Domain grayed / lists spin" was because the **funnel was not publicly live yet** (propagation —
   `wait_reachable` was still timing out; reqs 150/162), NOT an app fallback failure. An attempted
   `connectionFactory` IPv4-forcing change was tried and **REVERTED** — a Dart test proved it broke TLS
   (HttpClient does NOT do the TLS/SNI upgrade on a connectionFactory socket). The `/etc/hosts` IPv4 pin
   used while chasing this was unnecessary and removed. **Lesson: reproduce + confirm the root cause before
   writing the fix** (reinforces req 162: evidence, not assumptions).

## Public-reachability: recommended default vs expert choice
164. **Default (non-expert) public reachability = the ONE proven, zero-config, always-works path (Tailscale
   Funnel); `--expert-mode` exposes the full method menu.** A non-technical user must not face an 8-way
   choice. `add-cloudflare.sh` defaults to recommending **Tailscale Funnel** — it needs NO autodetection
   because it works on ANY network (CGNAT / double-NAT / a router you don't control) with only outbound
   internet. `--expert-mode` shows the full list (cloudflare/tailscale/ipv6/ngrok/pinggy/localtunnel/router/
   none). **Why a full auto-pick of "the best path" is NOT possible up front:** the method is chosen BEFORE
   the box exists (req 132), so a box's public IPv6 (the `ipv6`+DuckDNS path) is only knowable post-install
   (req 140), and true inbound :443 reachability (the `router` path) can't be tested from behind the NAT
   without an EXTERNAL probe. So those can't be reliably recommended up front. For now the only OTHER proven
   path, **ipv6+DuckDNS**, is SURFACED (not auto-picked) when the operator's own machine has IPv6. Future
   enhancement: post-install, detect the box's IPv6 (req 140 already probes it) and OFFER switching to the
   decentralised ipv6+DuckDNS path. The `--expert-mode` flag currently lives on `add-cloudflare.sh`; thread
   it through `resolve_flake.sh`/`dash` so an expert can choose during `find-target` too (follow-up).

## Diagram conventions & CLI-flow visualisation
165. **Every setup/flow diagram uses ONE shared colour convention; and `networks.md` carries a CLI-flow
   diagram composing the per-method sub-flows.** Colour key (established by the Tailscale Funnel diagram
   `docs/tailscale.svg`, reused everywhere): **blue** = the host / laptop and its CLI container; **purple**
   = a CLI action/choice the user makes; **gray** = a website/browser step; **orange** = something that
   happens on the target box; **green** = an information piece / what gets CREATED (auth key, node, name,
   public URL, `.onion`). `docs/cli-flow.svg` (embedded in `networks.md`) shows WHICH questions the user is
   asked for EACH public-reachability method and WHAT each creates — a composition of the per-method
   sub-flows (tailscale, ipv6+DuckDNS, cloudflare quick/named, ngrok, pinggy, localtunnel, router, none)
   between the common head (`find-target` → reachability choice) and tail (network-setup → install →
   finish → `./dash app`); the tailscale sub-flow's full entity view is the standalone `tailscale.svg`.
   `docs/tunneling.svg` shows the reachability ROUTES (the Tunnel-relay box holds one sub-box per provider:
   Tailscale/Cloudflare/ngrok/Pinggy/LocalTunnel; DuckDNS-over-IPv6 is NOT a tunnel — direct IPv6, no
   relay, so it is a separate route). All diagrams render deterministically via `docs/render-diagrams.sh`
   (pinned plantuml; edit the `.puml`, never the `.svg`); the pre-commit hook + CI enforce they are current.

## CLI-flow diagram requirements (`docs/cli-flow.puml`) — tracked, extend as specified
166. **The CLI-flow diagram is a numbered, sovereign-first reachability decision tree** (reuses the
   `setup-flow.puml` intelligence). Running list of its requirements:
   1. **Every step is NUMBERED** so it can be referenced/edited precisely: `[0]` find-target, `[0b]`
      host-IPv6 detect, `[S1]` onion, `[A.1..A.3]`, `[B.0..B.6]`, `[C1..C4]`. (Say "edit A.2" / "add B.7".)
   2. **Fully-sovereign options (your own infra, NO third-party relay) are listed FIRST and coloured
      ORANGE with a ⚠** — `.onion` (S1), router port-forward (A.1), direct IPv6 (A.2, B.6). NB: orange here
      = "sovereign", which DIFFERS from `tailscale.svg` where orange = the target box (documented per-diagram
      in each legend). [if you want one unified colour scheme across diagrams, say so.]
   3. **Port-forward carries explicit warnings:** it is ⚠ difficult; and **the 5 DNS A-records are entered
      DIFFERENTLY at each registrar**.
   4. **`[0b]` auto-detects whether THIS host has working IPv6**; if yes, the direct-IPv6 options are
      surfaced first. The host is only a HINT — the BOX's own IPv6 is re-verified post-install (req 140).
   5. **Structured as A (I already have my own domain) vs B (I don't).** A: port-forward (A.1) / direct
      IPv6 via your registrar's AAAA (A.2) / Cloudflare NAMED tunnel (A.3). B: get a free domain (B.0:
      nic.eu.org delegable but ⚠ ~days approval, or DuckDNS/afraid instant A/AAAA-only) / Tailscale default
      (B.1) / cf-quick (B.2) / ngrok (B.3) / pinggy (B.4) / localtunnel (B.5) / DuckDNS+direct-IPv6 (B.6).
   6. **Facts the diagram must state (verified 2026-10-11):** Tailscale Funnel can NOT serve your own domain
      (cert/SNI is `*.ts.net`); "DuckDNS without port-forward" is really **direct IPv6** (AAAA) — DuckDNS is
      only a free-NAME provider, so with your own domain you set the AAAA at your own registrar; whether
      port-forward is even possible is auto-checked via **CGNAT detection** (public IP vs WAN / `100.64/10`;
      true inbound still needs an external probe).
   7. Same shared colour key as req 165 otherwise (purple = CLI step, gray = website step, green = created).
   8. **CORRECTION to item 2 (orange):** orange now means **the TARGET device** (consistent with
      `tailscale.svg`), NOT sovereign — because this diagram now also draws the target. Sovereign options are
      instead **listed FIRST and marked ⚠** (no orange fill).
   9. **Containment:** a big **HOST** box (blue = your laptop) holds ONE box **per terminal** — Terminal 1 =
      the `sudo ~/netboot/start-netboot-server.sh` server you START FIRST and leave running; Terminal 2 =
      the `./dash` CLI holding the question + input boxes. The **TARGET device** is a separate orange box;
      arrows show Terminal 1 netbooting it over the direct cable and it appearing as a find-target candidate
      (by MAC). ALL CLI steps + the sudo command run on the HOST.
   10. **Every question has an INPUT box to its RIGHT** showing the allowed input: a range (`[1..n]`,
      `[1-8]`, `[1-4]`), a yes/no (`[y/N]`), or a format (`tskey-auth-…`, `<label.example.org>`, `<SSID>` +
      `<password, 8..63 chars>`, `--domain <host> --token <token> --apex`). Values unknown a-priori (the box
      LAN IP, the candidate MACs/IPs) are shown as **examples / `<placeholder>`**.
   11. **`[0]` find-target shows the candidate list** to pick from (`[1] MAC… · IP…`) and the printed
      Terminal-1 sudo command; **`[0b]` is a yes/no decision** (host IPv6? → yes: direct-IPv6 offered first /
      no: relay · .onion).
   12. **The flow is chained question → (answer) → next question** down to the green "public URL + .onion
      ready" outcome.
   13. **Colours in this diagram:** blue = host · white = terminal · purple = a question · **yellow = the
      INPUT you give** · orange = the target device · green = what's created.
   14. **After `[0b]` the flow BRANCHES into a method tree:** `[1.Y]` host-has-IPv6 → direct-IPv6 (1.Y.A ⚠
      sovereign) · DuckDNS+IPv6 (1.Y.B ⚠) · Tailscale (1.Y.C) · relays CF/ngrok/pinggy/localtunnel (1.Y.D);
      `[1.N]` no-IPv6 → IPv4 port-forward (1.N.A ⚠) · Tailscale (1.N.B, recommended) · relays (1.N.C). Each
      method node carries its sub-question inline. Relays are dual-stack (so they appear in BOTH branches);
      direct-IPv6 & DuckDNS-IPv6 REQUIRE IPv6 (1.Y only). A `[1.Y-check]` node sits AFTER `[Q2]` — see items 15-17 + req 167.
   15. **The method options are stacked VERTICALLY WITHIN each branch box.** `[1.Y]` and `[1.N]` are
      ENCLOSING boxes (restored); their options (`1.Y.A..D` / `1.N.A..C`) run top-to-bottom INSIDE each box,
      never side-by-side — forced via hidden layout edges. The two branch boxes themselves may sit
      side-by-side. Vertical spacing minimised (`skinparam ranksep`). A yellow INPUT box to the right of
      its question is also permitted.
   16. **`[1.Y-check]` is placed AFTER `[Q2]`** (it depends on the chosen network) and BRANCHES: **back to
      `[1.Y]`** (re-pick a method) or **forward to run-it-now**. OPTIONAL — only for a 1.Y IPv6 method with
      `[Q2]` = 0c/0d (a different network).
   17. **`[Q2]` lists its real options:** 0a cable→R (no wifi) · 0b cable→R + wifi→R (SAME router) · 0c
      cable→R + wifi→B (a DIFFERENT router) · 0d wifi-only (cable removed). (0b/0c corrected 2026-10-11.)

## IPv6 must be verified on the TARGET, not assumed from the host
167. **An IPv6-requiring method must be verified against the target's ACTUAL network — up-front AND
   post-boot — never assumed from the host's IPv6.** The `[0b]` host-IPv6 detection is only a HINT: the host
   may be on a different network than the box's final one (`cable-0c` = other wifi, `0d` = wifi-only).
   (a) **Up-front:** if an IPv6-only method (direct-IPv6 / DuckDNS+IPv6) is chosen AND `[Q2]` places the
   target on a DIFFERENT network than this host, PROMPT **"ARE YOU SURE THE TARGET WILL ALSO HAVE IPV6?"**
   before installing. (b) **Post-boot (regardless of that answer):** after the box reboots onto its final
   network with internet, it SELF-VERIFIES a global IPv6 (`net_lib.sh box_global_ipv6`, req 140); if an
   IPv6-requiring method was chosen but no global IPv6 is present, it prints a clear **"NO IPV6"** error —
   not a silent failure and not a generic "unreachable". Extends req 137 (the `ipv6` method already
   fails-fast when the box lacks v6) with the explicit host≠target warning + the named NO-IPV6 post-boot
   error. (Script wiring of the prompt + the named error is a follow-up; the detection already exists.)

## Test matrix ↔ setup diagram (2026-10-30)
168. **The test matrix's axes ARE the setup diagram's toggles** (`flow.html#setup-map`, data
   `docs/diagrams/setup-map.json`): a **setup** (`--on`, a matrix column) = one Install × Network view, named
   `<method>-<net>` (`cable-0a` `cable-0b` `cable-0d` `cable-0c` `wifi-0a` `wifi-0d` `usb-0a` `usb-0d` `usb-0c`,
   and `vm`), in the diagram's order; a **reach row** (`--reach` [`--name`], a matrix row group) = one Reach ×
   Name view (`onion`, `tailscale`, `cloudflare` buy|trycf, `ipv6` buy|duckdns, `portfwd` buy|duckdns), tied to
   the transport the app speaks (`--net`). Rows the diagram doesn't have are explicitly **harness-only**
   (`onion` over `chutney`, `local` https — VM only) or **future** (Yggdrasil, Hyphanet); the L1/L2 `test-vm` is
   harness-only too. `catalog.json` (`setup_map`, `setups`, `reach_rows`), `networks.md` and `test_matrix.md`
   say the same thing.
169. **The alignment is checked, not assumed:** `./dash setups` compares the catalog with the diagram's
   toggles (option values + labels, the Network values each Install offers, the Names each Reach offers, and
   every diagram view has a matrix setup / reach row, every matrix row is a diagram view, every setup's net
   matches its id) and `./dash setups --check` exits 1 on a mismatch; the dashboard runs the same checks for its
   banner.
170. **Every matrix setup and reach row links to its diagram view** (▦ on the column/row headers, and per cell
   `flow.html#setup-map;method=…;net=…;reach=…;name=…`); every run records its `diagram_view`.
171. **`--reach` is required for every L3 run** (+ `--name` exactly when the diagram offers names for that
   reach) and is validated args-only before any I/O: it must fit `--net` (onion → tor|chutney, the rest →
   https), harness-only rows are VM-only, and it must be wired for that backend (one-hostname tunnels —
   tailscale, cloudflare trycf — and the VM over a public route have no automated L3 yet: ○ in the matrix).
   L2 derives its row from `--net` (tor → onion, https → local). Runs record `reach`, `reach_name`, `reach_row`.
172. **Each diagram route's apply step is a matrix row**: `reach.<row>` runs `tools/add-cloudflare.sh` against
   an installed box over SSH with every input explicit (`--on <box setup> --ip --key` + the route's
   `--env` values); it is box-only (the VM's reach is fixed by the harness).
173. **Old setup ids keep working as aliases** (`lan-setup-0a..0d` → `cable-0a..0d`, `lan-setup-1/2` →
   `wifi-0a/0d`, `vm-local` → `vm`; `install.<old>` → `install.<new>`) and old records land in the new columns;
   ids with no diagram view are refused with the reason (`usb-0b`; the coarse `lan-setup-0` / `usb` /
   `native-ethernet` need their Network variant).
174. **A run forced past a gate with `--allow-dirty` is recorded as forced for L3 too** (req 85): the outer
   gate's forced reasons are carried onto the inner flutter record — on every attempt, incl. a retried (flaky)
   one (before, an `--allow-dirty` L3 run was recorded as a clean pass). Bypassing the box-identity gate (box
   unreachable / not stamped / no `--ip --key`) is a forced reason too: `box-unverified:<why>`.
175. **`install.vm` builds the VM image from source** (`SP_BUILD_MODE=build`, the committed backend flake) — a
   downloaded release image would not be the code under test (req 77) — and `./dash vm-up` starts the
   installed VM with the harness's stable VirtualBox settings and waits for its .onion, so the VM procedure
   in `test_matrix.md` is complete with no hidden step.
176. **A run log never contains the box API token.** `dash` redacts the token values a run knows (`--token` /
   `API_TOKEN`, `--dart-define=API_TOKEN=…`) and any 64-hex string from the echoed command, the log header and
   every streamed line; the installer/apply scripts print a command that READS the token over SSH
   (`tools/net_lib.sh token_cmd`), never its value (logs are committed by `./dash publish`; round0 R1).
177. **`reach.*` applies never wait on a hidden prompt:** under `./dash run reach.<row>` every input is on the
   command line (req 172), so `dash` sets `SP_NONINTERACTIVE=1` and `add-cloudflare.sh` fails fast on a missing
   value instead of prompting (a prompt could not show through dash's line-by-line output relay).
178. **The VM install gets enough RAM.** `install.vm` runs `build-and-run.sh` with `SP_VM_MEMORY=4096`: the
   installer builds the whole system INSIDE the live ISO (RAM-backed root), and on 2026-10-30 a 2048 MiB guest
   livelocked for 55 min (both vCPUs pegged, sshd unresponsive, no disk writes — recorded as a failed
   `install.vm`); with 4096 MiB the same install peaked at 2469 MiB of guest RAM in use (more than the old VM
   had in total) and completed in 15 min (over the 900 s budget → recorded `slow`).
179. **The L3 lock check matches what L3 actually does.** The committed app is resolved with
   `flutter pub get --enforce-lockfile` (pinned toolchain; req 83) BEFORE anything is injected. The harness's
   injected test needs the SDK's `integration_test`, which the app doesn't declare, so the second resolve (after
   injection) may only ADD packages to the lock (observed: integration_test, flutter_driver,
   fuchsia_remote_debug_protocol, process, sync_http, webdriver); any change to a package the committed lock pins
   fails loud. (Before, `--enforce-lockfile` ran after the injection and could never pass — no L3 run succeeded
   since it was introduced.)
180. **L3 builds the app with ONE consistent toolchain:** the app flake's `.#linux` shell (Flutter engine, GTK, C/C++
   toolchain, Mesa EGL and every tool from the same nixpkgs as its Flutter). The default devShell mixes two nixpkgs:
   its GTK no longer links against the Flutter 3.44 engine, and a build that fell back to the host compiler (a stale
   gitignored `build/linux` CMake cache pointing at `/usr/bin/clang++`) crashed on the host's newer glibc. A Linux
   build dir configured with any other compiler than that shell's is discarded before the build (a hidden build
   input, req 91). Each L3 run's `nix develop` temp files go to its own on-disk TMPDIR, deleted afterwards (they
   filled the RAM-backed /tmp).
181. **A box https result is filed under a reach row only if the box really uses that route**, checked live
   before the app runs (`dash verify_reach_route`): Name — duckdns ⇔ the box's domain is `*.duckdns.org`;
   Reach — port-forward ⇔ the public DNS A of `api.<domain>` (DNS-over-HTTPS, never `/etc/hosts`) is the box's
   public IPv4 and none is non-public (private, carrier-grade NAT, loopback, link-local); direct IPv6 ⇔ its public
   AAAA is one of the box's global IPv6s; Cloudflare ⇔ `cloudflared-sp` is active on the box and the name's public A
   records are global and NOT the box's own public IPv4 (that is a port-forward with cloudflared merely running). The TLS chain is checked against the
   system CAs (`curl` without `-k`) and the app gets `HTTPS_CA=/etc/ssl/certs/ca-certificates.crt`, so it validates
   the real certificate (without `HTTPS_CA` the app's dev mode trusts any certificate). A mismatch refuses the run
   (`--allow-dirty` → forced `reach-unverified`); the evidence is recorded (`reach_evidence`). The box-identity gate
   compares the box's stamped setup with `--on` exactly (req 168), not just the install family.
   Tested without a box by `python3 tools/test_reach_route.py ./dash`: live DNS-over-HTTPS + TLS against public
   hosts (badssl.com for broken certificates), every route decision with canned box answers, and the refuse /
   `--allow-dirty` wiring.
182. **The L3 golden baseline is per install, not just per code state:** its key adds the backend's
   `/etc/machine-id` (new on every fresh install), so every fresh VM/box gets its own golden from its first flow
   (or `./dash l3-baseline capture`). Before, a fresh reinstall of the same code was compared with the previous
   install's golden and always reported "drift outside modules/users" (its userdata.json holds per-install values).
183. **Every run checks the matrix still matches the setup diagram first** — the same check as
   `./dash setups --check`, run by `run`, `wrap` and `report` before anything else, and again inside every single
   test run (so `here`, the VM bring-up and the L3 recorder are covered too). On any mismatch nothing runs and
   nothing is recorded; there is no override (not even `--allow-dirty`), because a result filed under drifted axes
   lands in a matrix cell that no longer means what it says.
184. **Rows without a diagram view or a test stay in the matrix, greyed out**, instead of being dropped: Tor + https
   (`onion-https`, `--net tor+https`) and Chutney + https (`onion-chutney-https`, VM only) — the old matrix's
   placeholders — and the ngrok / Pinggy / LocalTunnel relays (`add-cloudflare.sh --method …` sets them up, but
   the setup diagram has no option for them). Each carries its reason (catalog `reach_rows[].greyed`), shown on
   hover; `dash` refuses to run or report them, they get no diagram link, and the alignment check (req 183)
   ignores them. Giving one a diagram option and a test turns it into a normal row.
