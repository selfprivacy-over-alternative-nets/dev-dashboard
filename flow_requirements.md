# flow_requirements.md — an editable, drill-down diagram surface for the dashboard

**Status:** v1 BUILT 2026-10-25 (see "Build status" below). Sibling to `requirements.md` (which runs
to req 167); this file uses its own **FR#** namespace so the two don't collide.
**Written:** 2026-10-25.

## Build status (v1)
Chosen stack: **zero-dependency vanilla SVG editor** (not Cytoscape/draw.io) — nothing to fetch, fully
self-hosted, deterministic, and semantic JSON = clean Claude diffs. Files:
- `flow.html` + `flow.js` — the viewer/editor (pan/zoom/fit, drag, add/del node+edge, label, colour
  palette, drill-down, breadcrumbs, mode-aware Save). Icon added top-left in `index.html` (▦).
- `docs/diagrams/*.json` — source of truth; seeded with `overview` → `install` / `reach` (drill-down demo).
- `dash serve` — added `GET /api/ping`, `GET /api/diagrams`, `POST /api/diagram/<name>` (localhost-only
  write, path-traversal + payload validation, deterministic dump mirroring `flow.js`).
- `docs/gen_flow_svg.py` — static snapshot `*.svg` per diagram (auto-run by `render-diagrams.sh`).
Satisfied: FR1-FR16, FR17 (vanilla SVG), FR18-FR25. **Verified:** API round-trip, deterministic write
(int coords/sorted keys), traversal/malformed rejection, static-viewer serve, snapshot render.
**Deferred:** FR11 live-reload (manual reload for now); FR12 PR-from-browser (download + copy-JSON only).

## 0. Purpose (what the user asked for)

Add a **page/tab** to the dev-dashboard (reached by **one small icon, top-left**) at
`https://selfprivacy-over-alternative-nets.github.io/dev-dashboard/` that:
1. shows the project's diagrams, and
2. lets the user **edit them by clicking and dragging**, and **by talking with Claude**, and
3. lets the user **edit locally on `localhost` and press Save so Claude can see the change**, and
4. supports **ONE large overview diagram that drills down into subpages / subdiagrams** showing
   more / different information at deeper levels.

It does **not** have to be PlantUML.

## 1. Current state this builds on

- 9 diagrams today (see repo README/networks): PlantUML-authored (`docs/architecture|deployer|flow|
  tunneling|tailscale|cli-flow|setup-flow.puml`) + Python-generated (`docs/gen_levels.py`,
  `gen_l3_coverage.py`). Rendered to `.svg` by `docs/render-diagrams.sh`; pre-commit hook +
  `.github/workflows/diagrams.yml` keep the `.svg` in sync with source.
- The dashboard is **static**: `index.html` + `app.js` + `matrix.html`, published to **GitHub Pages**
  by `.github/workflows/pages.yml` (uploads the whole dir; **no server-side code runs on the public
  site**).
- `./dash serve [port]` (default 8099, binds `127.0.0.1`) serves the dir with Python
  `http.server.SimpleHTTPRequestHandler` — **GET-only, read-only today**.

## 2. THE governing constraint (read before designing anything)

**"Edit → Save → Claude sees it" is only physically possible where a writable backend exists.**
GitHub Pages has none. Therefore the feature has two modes and the requirements are written per-mode:

| | **localhost (`./dash serve`)** | **public Pages site** |
|---|---|---|
| view / pan / zoom / drill-down | ✅ | ✅ |
| click-drag edit in browser | ✅ | ✅ (ephemeral) |
| **Save to disk → Claude reads it** | ✅ (needs a new POST endpoint) | ❌ impossible (static) |
| Save fallback | — | download file · copy-to-clipboard-for-Claude · open PR |

The **authoring + Claude-collaboration loop lives on localhost.** The public site is a **read-only
viewer** (with optional throwaway in-browser edits the user can export). This split must be explicit in
the UI so no one expects "Save" to persist on the public URL.

## 3. Requirements

### A. The page & the entry icon
- **FR1.** A new self-contained page (e.g. `flow.html` / `diagrams.html`) added to the static site; it
  loads with no build step and works when opened directly from Pages.
- **FR2.** **One small icon, top-left** of the existing header bar (`index.html` `.bar`, near the title)
  links to it. Unobtrusive — a single icon, not a row of controls. The diagrams page links back to the
  matrix the same way.
- **FR3.** The page works on the public Pages URL as a **viewer** (FR-D drill-down included) even with
  JavaScript-only, no backend.

### B. Viewing
- **FR4.** Render the current diagram with **pan, zoom, fit-to-screen**.
- **FR5.** A diagram **picker / index** listing all diagrams; selecting one opens it.
- **FR6.** The page detects its mode (localhost-with-backend vs static-Pages) and shows the correct
  Save affordance (FR-C) — never a dead "Save" button on Pages.

### C. Editing + the Claude round-trip (the core)
- **FR7.** **Click-and-drag editing**: move nodes, create/delete nodes and edges, edit labels, set
  colours (reuse the project colour key: blue host · purple CLI step · gray website · orange target ·
  green created · yellow input — see `requirements.md` req 165).
- **FR8. Single source of truth = a structured TEXT file (JSON).** The GUI reads and writes the SAME
  file that Claude reads and writes. The format must be **diff-friendly and deterministic**
  (stable key order, stable number formatting) so a GUI Save and a Claude edit produce clean,
  reviewable diffs — mirrors the project's existing "deterministic render" value.
- **FR9.** **Save on localhost writes that file to disk.** Add a write endpoint to `./dash serve`
  (`do_POST`, e.g. `POST /api/diagram/<name>`), which writes `docs/diagrams/<name>.json` in the working
  tree. After Save, Claude can read the file immediately and the user sees Claude's subsequent edits on
  reload.
- **FR10.** **Claude edits the same JSON as text** ("talking with you"): add/rename/restructure nodes,
  re-wire edges, split a node into a subdiagram, etc. The user reloads and sees the result. Round-trip
  is **bidirectional** and lossless.
- **FR11. (nice-to-have)** Live reload: the localhost page watches the file (or polls) and re-renders
  when Claude writes it, so the user doesn't have to hit reload.
- **FR12.** On the **public site**, "Save" degrades to: **Download JSON** and/or **Copy JSON to
  clipboard** (to paste to Claude) and/or **Open a GitHub PR** (optional, needs the user's auth) — with
  a clear note that edits are not persisted server-side.

### D. Overview → drill-down hierarchy
- **FR13.** Support **ONE top-level overview diagram** whose nodes can be **clicked to descend** into a
  child subdiagram ("go into subpages"). Each child can itself have children (arbitrary depth).
- **FR14.** Deeper levels **show more / different information** (level-of-detail), not just a zoom —
  e.g. the overview's "Install" node opens a subdiagram of the full find-target→install→finish steps.
- **FR15.** The hierarchy is encoded in the JSON (a node references its `childDiagram` id); the index
  (FR5) reflects the tree. **Breadcrumbs** + an "up" control to navigate back toward the overview.
- **FR16.** A node that has a child is visually marked as drillable (e.g. a ⊕ / folder affordance).

### E. Format & migration
- **FR17.** Choose ONE editable format as source of truth (see §4 Open decision). It need **not** be
  PlantUML. Requirement on the format: (a) click-drag positions are stored, (b) it is readable/editable
  as text by Claude, (c) it supports node→child-diagram links (FR13), (d) it can be rendered in-browser
  with no build step, (e) it serialises deterministically (FR8).
- **FR18.** **Static snapshot for Pages:** each diagram also produces a committed `.svg` (or `.png`)
  snapshot so the public viewer shows something even before/without the interactive layer, and so the
  diagram can be embedded in README/networks.md as today. Wire this into `render-diagrams.sh` +
  the pre-commit hook / `diagrams.yml` (same deterministic pipeline as the `.puml` diagrams).
- **FR19.** The new editable surface is the home for the **hand-authored flow diagrams** (the
  setup-flow / cli-flow / tunneling / tailscale / overview family). The **auto-generated** coverage
  diagrams (`levels`, `l3-coverage`) stay generated from code — do not hand-edit those. Existing
  `.puml` diagrams may be **imported once** as a starting point, after which the JSON is source of truth
  (don't maintain two sources for the same diagram).

### F. Determinism, versioning, CI
- **FR20.** Diagrams live under version control (`docs/diagrams/*.json` + their snapshot `.svg`). Git is
  the history/undo of record. **Saving writes the working tree only; committing stays manual** (project
  rule: commit/push only when asked). `dash publish`-style commit of diagrams is opt-in, not automatic.
- **FR21.** The snapshot pipeline (FR18) is enforced by the existing hook + CI so a committed JSON and
  its `.svg` can't drift (same guarantee the `.puml` diagrams have today).

### G. Security / safety of the write endpoint
- **FR22.** The localhost write endpoint only accepts writes **within `docs/diagrams/`**, rejects path
  traversal / absolute paths, and validates the payload parses as the chosen format before writing.
- **FR23.** It is a **localhost-only** capability: `dash serve` already binds `127.0.0.1` by default;
  if `DASH_HOST=0.0.0.0` is set (intentional sharing), the write endpoint must be **off by default**
  (explicit opt-in flag) so a writable editor is never exposed on untrusted wifi. The public Pages
  build ships no endpoint at all.
- **FR24.** No secrets in diagrams: the same no-secrets rule as the rest of the repo (no tokens, no
  real/personal domain) applies to diagram JSON + snapshots; the pre-publish secret guard (see
  round0.md R1-D) should also scan `docs/diagrams/`.

### H. Accessibility / fit with existing style
- **FR25.** Reuse `style.css` tokens and the shared diagram colour key (req 165) so the new page looks
  native to the dashboard. Keyboard-usable where practical; readable at the zoom levels users actually
  use.

## 4. Open decisions (need a choice before building — recommendation given)

1. **Editor/format stack (FR17).** Candidates:
   - **Purpose-built node/edge JSON + a light renderer (Cytoscape.js or React Flow).** *Recommended.*
     Cleanest for the Claude round-trip (semantic JSON → tiny, meaningful diffs), fully self-hosted
     (fits the project's pinned/deterministic/no-CDN ethos), native support for parent/child nodes →
     drill-down (FR13-16). Trade-off: we build the editing UI; less "freeform doodling" than a drawing
     app.
   - **draw.io / diagrams.net (mxGraph XML), embedded offline.** Best built-in multi-page + shape
     hyperlinks for drill-down, mature drag editor, postMessage load/save API. Trade-off: large vendored
     dependency; XML is coordinate-heavy → noisier Claude diffs.
   - **Excalidraw (JSON scenes).** Pleasant freeform drag, element hyperlinks for drill-down. Trade-off:
     heavy React dependency; multi-scene drill-down is more manual; JSON carries lots of layout noise.
   - **PlantUML + a visual layer** — rejected: PlantUML auto-lays-out from text, so click-drag node
     positioning isn't a natural fit (and the user already said it needn't be PlantUML).
2. **Does the public site need in-browser editing at all, or view-only?** (FR12 vs pure viewer.)
   Recommendation: **view + drill-down on Pages; editing+Save only on localhost** — simplest, and the
   Claude loop is inherently localhost anyway. Add download/copy-for-Claude on Pages only if wanted.
3. **Snapshot format for Pages (FR18):** SVG (crisp, text-diffable) vs PNG. Recommendation: **SVG**.

## 5. Suggested implementation sketch (for when we build — not now)

- New `flow.html` + `flow.js` (+ the chosen lib vendored under `docs/vendor/`). Small icon in
  `index.html` header → `flow.html`.
- Diagram model: `docs/diagrams/<name>.json` — `{nodes:[{id,label,x,y,color,childDiagram?}], edges:
  [{from,to,label?}], meta:{title,parent?}}`, serialised with sorted keys + fixed float precision.
- `./dash serve`: subclass the handler to add `do_POST` for `/api/diagram/<name>` → validate → write
  `docs/diagrams/<name>.json`; add a `GET /api/diagrams` index; gate writes on localhost + a flag.
- Snapshot: extend `render-diagrams.sh` with a headless render of each JSON → `docs/diagrams/<name>.svg`;
  hook into the pre-commit hook + `diagrams.yml`.
- Drill-down: clicking a node with `childDiagram` loads that diagram; breadcrumb from `meta.parent`.
- Claude loop: Claude reads/writes `docs/diagrams/<name>.json` directly; user Saves from the GUI to the
  same path; live-reload (FR11) closes the loop.

## 6. Out of scope (for now)
- Real-time multi-user co-editing / conflict resolution (single local user + Claude is the model).
- Auth'd server-side persistence on the public site (no backend there by design).
- Replacing the auto-generated coverage diagrams (`levels`, `l3-coverage`) — those stay code-generated.

---

# v2 — the interactive "Setup map" (FR26+)

**Added 2026-10-25** from the user's request (icons for cable/USB, a device/network topology that
reconfigures by a toggle, VM-nesting, reachability-to-a-visitor, and — later — input/output forms with a
KeePass safe). Chosen design defaults below (user may override any line):
- **Structure:** ONE reconfiguring diagram driven by toggles (not split) — FR27.
- **Icons:** self-hosted inline SVG set, NOT the linked stock JPGs (licensing/raster/offline) — FR33.
- **Visitor device:** shown on the reach path, flaggable IPv4-only — FR31.
- **Scope:** write these requirements, then build the v2 engine + the seed `setup-map` diagram.

## The Setup-map diagram
- **FR26. Plain language, no jargon.** Device labels a non-technical user understands: **"Your computer"**
  (the current/parent device — NOT "host"), **"Your new private server"** (the target), **"Your home
  router"**, **"The internet"**, **"A friend's phone"** (the visitor). No "host/target/box/node" in
  user-facing labels.
- **FR27. ONE diagram, reconfigured by toggles across the top** (segmented controls), covering all three
  concerns the user raised — install method, network setup, and reachability — in a single end-to-end
  picture (install → network → internet → a friend). Rationale: 3 methods × ~6 network setups × 5 reach
  routes ≈ 90 static pictures otherwise.
- **FR28. Toggle 1 = Install method:** `LAN cable` · `Wifi` · `USB stick` · `VM`.
  - **LAN cable:** "Your computer" —[ethernet-cable edge]→ "new server" (direct netboot).
  - **Wifi:** "Your computer" —[wifi edge]→ "Your home router" —[wifi/cable]→ "new server" (A reaches B
    THROUGH the router over wifi — the `lan-setup-1/2` case). Uses a wifi icon on the edge.
  - **USB stick:** the server carries a USB-stick icon; "Your computer" is faded/removed (it only wrote
    the stick).
  - **VM:** the server node is drawn **nested INSIDE "Your computer"** (containment, FR36); no install
    edge; it rides the computer's network.
- **FR28b. Possible future install methods (NOT built; flagged for completeness):** **SD-card / flashed
  image** (ARM boards / Raspberry Pi — upstream supports ARM; altnet is x86 so far) and **netboot via the
  router (proxyDHCP)** (a sub-case of LAN/Wifi when cabled to the router, not directly to B — folded into
  those rather than a separate option). Add as toggle options later if the supported set grows.
- **FR29. Toggle 2 = Network setup, DEPENDENT on the method.** LAN cable → `0a/0b/0c/0d`; Wifi →
  `w1/w2` (install-over-wifi, B on lan `w1` or wifi `w2`); USB → `usb-0a/0b/0c`; VM → hidden/N-A. The
  option list changes with Toggle 1 (`optionsWhen`, FR34). The chosen setup changes the server↔router link
  (cable vs wifi) and whether a **second router (Y)** appears (0c). (Definitions: `question.md` /
  `networks.md`.) Note: we treat install-method as the *A↔B install transport* and network-setup as *B's
  ongoing internet* — more orthogonal and grandma-friendly than `question.md`'s combined `lan-setup-N`.
- **FR30. Toggle 3 = Reach from outside:** `Tailscale` · `Cloudflare` · `Direct IPv6` · `Port-forward` ·
  `.onion`. It draws the outbound path from the server to the visitor: tunnel routes via a relay cloud
  (server ⇢ relay ⇢ internet ⇢ phone); IPv6/port-forward direct (server → router → internet → phone);
  onion via a Tor cloud (server ⇢ Tor ⇢ phone). Mirrors `docs/tunneling.svg`'s routes but live/selectable.
- **FR31. Visitor device on the reach path.** Draw "A friend's phone" at the end; allow flagging it
  **IPv4-only** (ties to the APELL/Timo feedback — "who can actually reach it"; see `round0.md` R5/R8).
- **FR32. Drill-down still applies (reuses v1 FR13-16).** Clicking the server opens the install-steps
  subdiagram; clicking a route opens its specifics. The setup-map is the new overview root.

## Engine additions needed for v2 (extend the v1 editor + `dash` writer + snapshot)
- **FR33. Self-hosted inline-SVG icon set** (drawn in the style of the user's references, NOT hotlinked
  stock JPGs — licensing/raster/offline reasons). Minimum set: `laptop` (your computer), `server`,
  `router`, `cloud` (internet), `phone` (visitor), `usb` (USB stick), `ethernet` (cable), `safe` (lock /
  KeePass), `relay`, `tor`. A node gets an optional `icon` field (icon above/beside the label). If the
  user supplies a licensed raster, it may instead be vendored under `docs/diagrams/icons/` — never
  hotlinked.
- **FR34. Toggles in the data model.** `meta.toggles = [{id, label, options:[{value,label}], default,
  optionsWhen?}]`; `optionsWhen` makes an option list depend on another toggle's value (FR29). Rendered
  as segmented controls in the toolbar; the active selection is encoded in the URL hash so a shared link
  opens a specific configuration. Editable in-GUI (add/rename toggle, add option) and by Claude as JSON.
- **FR35. Conditional visibility (`showWhen`).** Every node and edge gets an optional
  `showWhen: {toggleId: [allowedValues]}`; the renderer shows an element only when the active toggle
  values match (default = always shown). GUI: set/clear `showWhen` on the selected element from the
  active toggle state.
- **FR36. Containment / grouping.** A node may be contained in another: `container: "<nodeId>"`
  (optionally `containerWhen: {toggleId:[values]}` so it only nests in certain states — the VM case,
  FR28). The renderer draws contained nodes inside the container's rect and grows the container to fit;
  contained nodes move with the container.
- **FR37. Edge kinds (visual semantics).** `edge.kind ∈ {cable, usb, wifi, lan, internet, tunnel, tor,
  plain}` selects styling: e.g. **cable** = thick solid with the ethernet icon at the joint; **wifi** =
  dashed/arc; **usb** = USB glyph; **tunnel** = dashed to a relay; **tor** = dashed to the Tor cloud.
- **FR38. Deterministic round-trip for all new fields.** `icon`, `showWhen`, `container`, `containerWhen`,
  `kind`, and `meta.toggles` serialise under the same sorted-key / integer-coord rules as v1 (FR8), so GUI
  saves and Claude's hand-edits still diff cleanly; the Python writer in `dash` and the `gen_flow_svg.py`
  snapshot must honour them (snapshot renders the DEFAULT toggle state).

## Phase 2 — Input & Output information forms (the user's "later")
- **FR39. Input form.** A form-style diagram listing what the user must provide, each with a device/field
  icon: **domain**, **wifi SSID + password**, **confirm disk**, **ssh key**, **Tailscale auth key**,
  **reach method**. (Surface grounded in `deployer_questions.md` B + `add-cloudflare.sh` flags.)
- **FR40. Output form with a KeePass safe.** List what the install produces and **visually sort it into a
  🔒 safe vs shareable**, using a lock/safe icon as a container (reuse FR36):
  - **Into the KeePass safe (secret):** API **token** (`make_keepass_db.sh` already stores it), **recovery
    password**, **wifi PSK**, and the whole `state/` bundle (encryptable one-password via `age -p` —
    `deployer_questions.md` D).
  - **Shareable (not secret):** the **.onion** address and the **public URL** (Funnel/tunnel/domain).
- **FR41. Intuitive + icon-led.** Device icons for each actor, the safe icon for anything secret, clear
  "you give these" vs "you get these" grouping; a non-technical user can tell at a glance what to keep
  private. Authored as a diagram "kind" (`meta.kind = "form"`) reusing the FR33 icons + FR36 containment,
  so it lives in the same editor and round-trips to Claude.

## v2 open items / notes
- Snapshot (`gen_flow_svg.py`) renders only the DEFAULT toggle state for the static Pages view; the live
  editor is where toggling happens (FR38). Acceptable for an at-a-glance embed.
- Layout of conditionally-shown / contained nodes is author-placed (drag), not auto-laid-out — consistent
  with v1; the author positions each state so toggling looks clean.

---

# v3 — Super-Mario-style tunnels (FR42+)

**Added + BUILT 2026-10-25** from the user's request: visualise the reachability tunnels as Super-Mario-
Bros warp pipes, routed through the router, colour-coded, intermediary-vs-direct, with an onion out of Tor
and an IPv6-only/IPv4-blocked marker. Diagram: `docs/diagrams/tunnels.json` (child of `setup-map`).

- **FR42. Warp-pipe edges (`edge.kind:"pipe"`).** A pipe renders as a fat coloured band (dark rim +
  lighter highlight stripe) with a perpendicular **pipe-mouth rim at each end** — the SMB warp-pipe look.
  Shared renderer in `flow.js` (`drawPipe`) and `gen_flow_svg.py` (`pipe_svg`); deterministic.
- **FR43. Per-edge colour (`edge.color`, hex).** Each tunnel is a distinct colour: **Tailscale = blue
  `#3b82f6`, Cloudflare = orange `#f38020`, Tor/.onion = purple `#9b59b6`** (the three the user named),
  plus Direct-IPv6/DuckDNS = green `#2bb673`, Port-forward = yellow `#eab308`, home-LAN = grey. `color`
  also tints non-pipe edges.
- **FR44. All tunnels route THROUGH the router.** `server → router` (home-LAN pipe), then one coloured
  pipe per method fans out of the router → its intermediary/marker → the internet → the friend's phone.
- **FR45. Intermediary vs direct (the user's grouping, with the precise nuance labelled).** Pipes to
  **Tailscale relay** and **Cloudflare edge** pass through a **company** box. **DuckDNS** is drawn as an
  intermediary too because you depend on it — but labelled **"name only (traffic is direct)"** (DNS, not
  a traffic relay). **Tor goes direct** — a `Tor network (no company — goes direct)` box, no commercial
  intermediary. (Technical reality noted: DuckDNS traffic is direct; Tor routes through the volunteer Tor
  relay network. The grouping reflects *company-dependency*, which is the project's sovereignty lens.)
- **FR46. An onion comes out of the Tor tunnel.** The Tor pipe runs `router → tornet → .onion (onion
  sprite) → internet`; new `onion` icon in `docs/icons.svg`.
- **FR47. Port-forward shows router config.** The port-forward pipe passes through an `Open port 443 in
  the router` node (gear icon), labelled "needs public IPv4" — the one route that needs manual router
  setup.
- **FR48. IPv6-only / IPv4-blocked marker.** The Direct-IPv6 (DuckDNS) pipe is labelled "IPv6 only" and
  carries an `IPv4 blocked / IPv6 only` badge (red circle-slash `block` sprite); the relay pipes are
  labelled "IPv4 + IPv6". This directly visualises the APELL/Timo warning that an IPv4-only visitor
  cannot open an IPv6-only link (round0.md R5).
- **FR49. Per-diagram background (`meta.background`).** A diagram may set a canvas colour; `tunnels`
  uses the SMB sky `#5c94fc`. Honoured by both the live editor and the snapshot.
- **FR50. `Show` toggle** (all / tailscale / cloudflare / ipv6 / portfwd / tor) isolates one pipe or
  shows them all at once (default **all**, so every colour is visible together).
- **FR51. New sprites** added to `docs/icons.svg`: `onion`, `gear`, `block` (red, fixed colour), `pipe`.
  Original retro-style art — **no Nintendo character sprites** (no Mario/Luigi etc.); the generic warp-
  pipe + onion motifs only, to avoid using Nintendo's IP.
- **Verified:** rendered `tunnels.svg` (cairosvg → PNG) shows the five colour-coded warp pipes through the
  router, the company/direct split, the onion out of Tor, the port-443 config, and the IPv4-blocked badge
  on the green IPv6-only pipe. `flow.js` passes `node --check`; `dash` compiles; save is deterministic.

## v3.1 — authentic SMB pipes, orthogonal routing, see-through router (FR52+)
**BUILT 2026-10-25** from the user's refinement (ref images in `/images`: SMB 1-1/3-1 green warp pipes on
sky over a brick ground). Replaces the flat capsule pipes.
- **FR52. Authentic warp-pipe rendering.** A pipe is drawn with a **black outline + coloured body + a
  bright highlight stripe and a dark shade stripe + a wider lip (rim) at each mouth** — the NES warp-pipe
  look (`drawMarioPipe`/`mario_pipe_svg`), in the tunnel's colour.
- **FR53. Strictly orthogonal routing — never diagonal.** Pipes route in H/V segments with 90° elbows
  only. An edge may carry an explicit `path: [{x,y},…]` (used verbatim), else an auto **Z-route** (H-V-H /
  V-H-V, border-to-border) is computed. Both guarantee right angles. Shared `zRoute`/`pipePoly` in
  `flow.js` and `gen_flow_svg.py`.
- **FR54. See-through nodes (`node.seeThrough`).** A translucent node (fill-opacity 0.3) so pipes route
  THROUGH it and stay visible — used for the home router: the coloured pipes rise out of the router and you
  see them passing through it.
- **FR55. Brick ground (`meta.ground`: y).** An SMB brown-brick ground strip across the canvas bottom.
- **FR56. Port-forward manual config is now visualised** — a `gate` sprite node "You must open port 443
  (manual)" sitting ON the router, on the yellow pipe (the one route needing hand configuration). New
  sprites `gate`, `warn`.
- **FR57. The Tor pipe pops an onion** out of its top (the `.onion` node emerges above the Tor pipe, piranha
  -plant style — the user's optional ask, done).
- **FR58. setup-map reach edges are now pipes too.** The tunnel/relay/tor/internet edges in `setup-map`
  render as orthogonal Mario pipes (the install *cables* stay thin arrows — they're not tunnels).
- **Verified:** both `tunnels.svg` and `setup-map.svg` rasterised (cairosvg) — orthogonal coloured pipes,
  pipes visibly passing through the translucent router, brick ground, port-443 gate, onion, IPv4-blocked
  badge. Deterministic save preserved (`path`/`seeThrough`/`ground` round-trip through sorted-key dump).

---

# v4 — reach colours, split routes, naming, decentralised Tor (FR59+)

**Added 2026-10-25** from the user's message (re-colour the tunnels, split Tailscale/Cloudflare, show the
things each route actually *requires*). **Governing instruction for this round: the deliverable is the
LIVE, editable view** at e.g. `http://localhost:8099/flow.html#setup-map;method=cable;net=0a;reach=portfwd`,
**NOT** the static `*.svg` snapshot. Verify every item below by screenshotting the running `flow.html` at the
*actual* toggle state it concerns (the snapshot only ever renders the DEFAULT toggle state — see FR67).

- **FR59. Reach-route colour key (user-chosen; OVERRIDES FR43).** Each reach route has a fixed colour,
  applied in BOTH `setup-map` reach pipes and the `tunnels` drill-down:
  **Tailscale = gray `#8b949e`, Cloudflare = orange `#f38020`, Direct IPv6 = blue `#3b82f6`,
  DuckDNS = red `#e5484d`, Port-forward = yellow `#eab308`, Tor/.onion = purple `#9b59b6`.** The plain
  local/home + friend pipes use a dim neutral `#6e7681` so they don't compete with the route colours.
- **FR60. Tailscale and Cloudflare are SEPARATE routes.** Not one shared blue "Tunnel relay" node — each
  has its own company node (`Tailscale (a company)` gray · `Cloudflare (a company)` orange) and its own
  coloured pipe, because they differ in colour, naming, and what the user must provide.
- **FR61. `setup-map` must render a reach path for EVERY `reach` option.** Today `ipv6` and `portfwd`
  render NOTHING (only tailscale/cloudflare/onion have edges) — so the user's `reach=portfwd` view is blank
  of any reach info. Every option (tailscale · cloudflare · ipv6 · portfwd · onion) must draw its path from
  the server to the friend.
- **FR62. Port-forward shows the MANUAL work.** The `portfwd` route is the only one needing hand
  configuration: a `gate` node ON the router — "Open port 443 by hand in your router settings" (with a
  `warn`) — sits on the yellow pipe, and the route also surfaces the registrar settings (FR63). A
  non-technical user must see "this route = I have to go into the router AND the registrar myself".
- **FR63. Domain must be bought at a registrar (if not .onion).** Non-onion public routes need a domain
  name you **purchase at a registrar (€/yr)** — show a `cart`/`tag` "Buy a domain" node on the routes that
  need it (cloudflare, direct ipv6, port-forward), drilling down (`childDiagram`) to a **`registrar`
  diagram listing the exact DNS records to add** (A → your public IPv4, AAAA → your public IPv6, CNAME for
  tunnels, nameserver change for Cloudflare). **.onion needs NO domain** — call that out explicitly (free,
  automatic name).
- **FR64. DuckDNS = name only (red).** Visualise that DuckDNS gives only a **name** (dynamic DNS pointing
  at your changing home IP) — **the traffic goes direct, not through DuckDNS** (contrast with the relay
  companies, whose pipe the traffic actually flows through). It is the **free alternative to buying a
  domain**, used together with a direct route (ipv6 / port-forward): draw it as a red name-tag with a thin
  "just the name" lookup line, not a fat traffic pipe.
- **FR65. IPv4 + IPv6 = two tunnels within one "normal" tunnel.** The direct connection is drawn as ONE
  wide translucent outer tube (`edge.casing:true`, `edge.pw` sets pipe width) containing **two inner pipes
  — IPv4 (yellow) and IPv6 (blue)** — so a non-technical user sees the normal/direct connection carries
  both, and that **IPv6 may not be available for everyone** (a friend on an IPv4-only network cannot open
  an IPv6-only link — the `block` "not everyone has IPv6" badge, ties to round0 R5/R8). Rendered by
  `drawMarioPipe`/`mario_pipe_svg` honouring `pw` + `casing` (shared flow.js ↔ gen_flow_svg.py).
- **FR66. Tor is decentralised.** Visualise the Tor route as passing through a **network of many
  independent volunteer relays** (a mesh of `tornode` dots / multiple hops inside a see-through "Tor
  network" box) with **no single company or owner** — in deliberate contrast to Tailscale/Cloudflare, which
  route through ONE company. Label it so the sovereignty point (no company, nothing to buy) is explicit.
- **FR67. Verify against the LIVE view at the real toggle state — not the snapshot.** Review/QA must
  screenshot the running `flow.html#<id>;<toggles>` (e.g. via Playwright) at each toggle state a
  requirement concerns. The committed `*.svg` renders only the DEFAULT toggle state (FR38) and is a
  Pages/README embed, NOT the source of truth for reviewing toggle-dependent behaviour. Harness:
  `tools/shot_flow.py '<id>;<toggles>' out.png`.
- **FR69. Arrows anchored at side-midpoints, orthogonal, snap-to-straight.** Plain/arrow edges (and
  auto-routed pipes) connect the **mid-point of one node's side to the mid-point of another's** and route
  with **straight lines or 90° elbows only** (never diagonal) — H-V-H / V-H-V via the shared `zRoute`
  (flow.js ↔ gen_flow_svg.py). When the two anchors are within `EDGE_SNAP` (28px) of being aligned, the
  connector **snaps to a single straight line**. An explicit `edge.path` still wins; arrows render as a
  `<path>` polyline with the arrowhead at the end, label/icon at the polyline's length-midpoint.
- **FR68. Resize nodes by drag (width / height / diagonal).** The selected node shows 8 resize handles —
  4 edge-midpoints (grab to change **width** [e/w] or **height** [n/s]) and 4 corners (grab to resize
  **diagonally** [nw/ne/se/sw]). Left/top handles move the opposite edge in place (adjust `x`/`y`, or
  `cdx`/`cdy` for a contained node); min size 40. Handles stay ~constant size on screen across zoom. The
  new `w`/`h` (and `x`/`y`/`cdx`/`cdy`) round-trip through the deterministic save (FR8).
- **FR70. Arrow lines must always render (regression guard).** The `.wire` is a `<path>` (orthogonal
  arrows, FR69), so CSS must style it **by class** (`.edge .wire`), not by element (`line.wire`) — otherwise
  the arrow line disappears while only the edge's mid-icon shows (the install `netboot` / `install over
  wifi` arrows regressed this way). Both `<path>` and `<line>` wires must get stroke/width/dash/selection
  colour.
- **FR71. Ctrl-drag to draw a new arrow (discoverable).** Holding **Ctrl** switches the editor to
  "draw arrow" mode: the cursor becomes a crosshair and the box edge-dots (normally resize handles, which
  show ↕/↔ resize cursors) become arrow-start anchors. **Ctrl-press on a box (or its edge-dot) and drag to
  another box** draws a new arrow between them; a rubber-band line follows the cursor; releasing on a target
  box creates the arrow (releasing on empty space cancels; Esc cancels). The existing `＋ edge` click-click
  flow still works.
- **FR72. Arrow-direction box on a selected arrow.** Selecting an arrow pops a small contextual box near it
  with **A → B · A ← B · A ↔ B** (A = source box, B = target box), setting `edge.dir` ∈
  `to` / `from` / `both`. The renderer maps this to `marker-end` / `marker-start` / both (shared flow.js ↔
  gen_flow_svg.py); default `to`. Round-trips through the deterministic save.
- **FR74. Arrowheads: hand-drawn, always at the box edge, and styleable.** The arrowhead is a drawn
  triangle (not an SVG `marker`) placed with its tip **exactly on the box border** at the connection point,
  so it is always visible — even for very short arrows (the old `marker` had a min-length blind spot and
  scaled with stroke width). The arrow box (FR72) gains three more controls that write per-edge fields:
  **head size** `edge.ah` (px, default 12), **line width** `edge.lw` (px, default 3 for cable/lan else 2),
  and **arrow colour** `edge.color` (colour picker + *reset* to the theme default). Head direction still
  follows `edge.dir`. For `kind:"pipe"` edges the direction/size rows hide (pipes are tubes), but the colour
  control still applies. All fields round-trip through the deterministic save and are mirrored in
  `gen_flow_svg.py` (shared `drawArrowHead`/`arrow_head`).
- **FR73. Hover help on every toolbar control.** Each control (`＋ node`, `＋ edge`, delete, label, icon,
  edge kind, sub-diagram, show-when, contain, toggles, colour, fit/zoom, save, copy) carries a `data-help`
  string shown as a **clear styled textbox on hover** (not the terse/slow native `title`) that says what the
  button does AND how to use it.
- **FR75. Drag-snap a box into another, or onto an edge-centre (all boxes).** When a box is dragged and
  released so it lands **inside** another box (fully within, not overlapping the parent's borders), it
  becomes **contained** by that box (sets `container` + `cdx`/`cdy`, sits inside, and moves with the parent
  — FR36). When it is dragged so it lands **on an edge** of another box (overlapping/straddling one of the
  four sides), its **centre snaps/fixates to the centre of that side** of the box (plop onto the edge-mid),
  like the `pfgate` "Open port 443…" box sitting on the "Your home router" box. This applies to **every**
  box, not just that one. Releasing in empty space leaves the box free (clears any container). The resulting
  `container`/`cdx`/`cdy`/`x`/`y` round-trip through the deterministic save (FR8).
  *Implemented as:* edge-snap stores `container` + **`snapSide`** ∈ `n|e|s|w` (no cdx/cdy) — the box's centre
  is then **pinned** to that side-midpoint of the parent's rendered box, so it stays on the edge when the
  parent moves or is resized, and the parent's auto-grow (FR36) ignores edge-snapped children. Rules on
  release (dragged box `b`, every other visible box `P`, the dragged box detached first so its old parent's
  auto-grow doesn't skew the test): (1) only a **bigger** box (area) is a target — so dragging a container over
  a small box never snaps the container onto it; (2) **on an edge** = the side line passes through the middle
  half of `b` and `b`'s centre lies within that side's extent — a box that merely clips a neighbour does NOT
  snap; nearest side line wins; (3) else **inside** = `b` strictly within `P`, innermost (smallest) wins;
  (4) else free. A drag shorter than ~3 screen px is a click and changes nothing. Dragging an edge-snapped
  box unpins it; release re-applies the rules. A node with a **conditional** container (`containerWhen`)
  that is inactive in the current toggle state is moved but never re-snapped (would clobber the per-state
  nesting); re-dropping into the same container keeps its `containerWhen`. Never snaps into its own
  descendants. Mirrored in `docs/gen_flow_svg.py` (`side_mid`, `rbox`). Known quirk: an edge-snapped box's
  centre coincides with the selected parent's side resize-handle, so grab the child off-centre to drag it.
- **FR76. Auto see-through parent when a contained box has pipes/arrows.** If a box is placed inside another
  box AND that inner box has edges (pipes or arrows) attached to it, the **surrounding (parent) box is made
  translucent automatically** (`seeThrough`, reusing FR54) so the incoming pipe/arrow is visible passing
  through it — the user shouldn't have to toggle see-through by hand. (Reverts to opaque when the inner box
  no longer has attached edges / is removed from the container.)
  *Implemented as:* **derived at render time, never saved** (so it reverts by itself): a box is translucent
  if `seeThrough` is set OR any visible child it contains (inside or edge-snapped, FR75) has a *drawn* edge
  (edge visible in this toggle state AND both endpoints visible). Same in flow.js (`autoSeeThrough`) and the
  snapshot (`auto_see_through`). The live view applies it as an inline `fill-opacity: 0.3` style, because the
  `.node.container rect { fill-opacity: .55 }` CSS rule otherwise overrode the attribute (this also fixes
  explicit `seeThrough` containers such as Tor rendering at 0.55 live vs 0.3 in the snapshot).
- **FR77. Changing an arrow's width (and colour) must visibly change the drawn line.** The arrow box's
  *width* slider (`edge.lw`, FR74) and *colour* (`edge.color`) are applied to the `.wire` as **inline style**
  — `.edge .wire { stroke-width; stroke }` / `.k-cable` CSS rules otherwise silently override SVG attributes
  (regression: the slider moved but the line stayed 1.6/3 px). The click target (`.hit`) widens with the line.
  A thick line keeps reading as an arrow: the drawn head is `max(ah, 2.5 × lw)` (the *head* slider is the
  minimum) and the line is trimmed back to the head's base so its butt never pokes past the tip; the tip
  stays exactly on the box edge. Mirrored in `docs/gen_flow_svg.py` (`trim_end`, head size).
- **FR78. The arrow box (A→B box) can be moved by click-hold-drag.** Pressing and holding anywhere on the
  arrow box (FR72) that is not one of its controls (buttons, sliders, colour picker) and dragging moves the
  box (⠿ grip + `move` cursor show it's draggable; dragging a slider still only changes the slider). The box
  keeps its moved offset relative to the arrow's midpoint, so it follows the arrow on zoom/pan/fit/re-render
  (zoom previously left the box behind). Double-click its background = back to the default spot; selecting a
  different arrow also starts at the default spot. Pure view state — never saved to the diagram JSON.
  *Superseded by FR98: the moved spot is now stored per line and saved with the diagram.*
- **FR79. Drag an edge's line sideways (perpendicular to its segment); past a box's side it gains a bend.**
  Grabbing any segment of an arrow or pipe and dragging it moves that segment **orthogonally to its own
  direction** (a horizontal run moves up/down, a vertical one left/right) — the 90°-only routing (FR53/FR69)
  is kept. Dragging an **end** run shifts where it **attaches** along the box side (the attachment slides with
  it). When the line is dragged **further to the side than the box's edge runs**, it gets **one extra 90°
  bend** to stay connected: it enters/leaves through that box's top/bottom (or left/right) side instead
  (a "stub"); that stub can itself be dragged to shift where it enters the box. The middle elbow of a Z-route
  can be dragged too. An end run dragged level (within `EDGE_SNAP`) with the other end snaps into one straight
  line. *Stored as offsets on the edge* (so the route stays attached when boxes move/resize, and round-trips
  through the deterministic save): `so`/`eo` = start/end attachment shift along its side, `mo` = middle-elbow
  shift, `ss`/`es` = start/end stub shift along the top/bottom side. An explicit `edge.path` (FR53) instead has
  the grabbed segment's two points moved. The arrow box gets a **reset route** button (drops the offsets) and
  now sits fully **above** the line so it never covers the segment being dragged. Snap-to-straight only applies
  when both ends share one offset, so a set attachment (FR81) stays exact. Mirrored in `docs/gen_flow_svg.py`
  (`zroute(a, b, e)` ↔ `zRouteSegs`; parity-tested on random boxes/offsets).
- **FR80. Attach an edge to a pipe, snapping to the pipe's corner or segment-midpoint.** An arrow end can sit
  **on a pipe** instead of a box. Selecting an edge shows a grab-dot at each of its two ends; dragging an end
  and **releasing in proximity** (≤ 24 screen px, or on the pipe's body) of a pipe **jumps/grid-fixes** it to
  the nearest **corner (elbow)** or **middle of a segment's length** of that pipe. Released elsewhere on/near a
  box → it slides to that spot on the box (the FR79 edge-line shifting); released in empty space → the end
  shifts freely toward the cursor. Ctrl-drawing a new arrow (FR71) can also start or end on a pipe. *Stored
  as* `edge.fromOn` / `edge.toOn` = `"<pipeId>:<spot>"` with spot `c<i>` (pipe polyline point i), `m<i>`
  (middle of segment i) or `s<i>@<t>` (exact fraction t along segment i, FR81); `from`/`to` keep a node id.
  The tip lands on the pipe's outline (an attach box the pipe's girth wide). Only plain pipes (not themselves
  attached to a pipe) are targets; if the pipe re-routes so the spot no longer exists, it falls back to the
  pipe's first segment-mid. Mirrored in `docs/gen_flow_svg.py` (`pipe_spot_box`).
- **FR81. Highlight the attach target while drawing/dragging an edge; Shift = exact position.** While
  Ctrl-drawing a new edge (FR71) or dragging an edge end (FR80), the **box or pipe the edge would connect to is
  highlighted** (magenta outline; magenta dashes along a pipe — visible on every node and pipe colour), its
  **grid points** are shown (box: 4 corners as squares + 4 side-midpoints as dots; pipe: elbows as squares +
  segment-mids as dots), and the **specific corner / side-mid / segment-mid it will snap to on release** is
  marked with a large magenta dot. Away from a grid point on a box (without Shift) a new arrow uses the auto
  side-midpoint. Holding **Shift** (together with Ctrl while drawing; on its own while dragging an end) **overrides the grid snapping**: the end
  attaches to **exactly** the spot under the cursor (nearest point on the box outline, or on the pipe),
  marked with a small red dot. A Shift-press deep inside the *start* box (not near its border) still starts at
  the auto side-midpoint. Starting a draw hides the arrow box so it can't cover a target. *Known limit:* an
  exact spot on the box side facing **away** from the other end is reached from the top/bottom side at that
  side's corner (the route model has at most one extra bend per end). Exact box points are stored with the
  FR79 offsets (`so`/`eo`, `ss`/`es`).
- **FR82. Block types: action vs information vs (hardware) device, with a small legend top-right.** Every
  box can say WHAT it is via `node.nodeType` ∈ `action` | `info` | `device`, shown by **shape** (colour keeps
  its palette meaning, FR25): **action** (something you do) = pill, fully rounded ends (`rx = min(h/2, 26)`);
  **info** (a piece of information) = dotted border (`2 4`) + a folded "document" corner top-right (cut in the
  diagram background colour, `meta.background`); **device** (hardware) = square corners (`rx 2`), thick solid
  border (3.5). Untyped = the plain rounded box. Dotted, not dashed, so it never looks like a *selected* box
  (selection is dashed `5 3`); shape styles are inline so the `.node rect` CSS can't override them (FR77
  lesson). A **small legend** of the three shapes sits in the **top-right** of the canvas (HTML overlay live,
  same key drawn into the snapshot above the content); it's shown only on diagrams that use types, and
  *fit* keeps a band free for it so it never covers a box. `◇ type` toolbar button sets/clears the type
  (with hover help, FR73). The drill marker "⊕ open" is inset by the corner radius so a pill doesn't clip
  it. All six diagrams are typed (devices: computers, server, routers, phone, the internet, Tailscale/
  Cloudflare relays, Tor network + relays; actions: buy a domain, open port 443, install/reach steps, the
  registrar "add these records", the reach-route options, "Compare all routes"; info: free names, DuckDNS,
  warnings, DNS records, .onion). Mirrored in `docs/gen_flow_svg.py` (`NODE_TYPES`, `dog_ear_svg`,
  `legend_svg`).
- **FR83. The snapshot renderer draws exactly what the live editor draws.** `docs/gen_flow_svg.py` must stay
  behaviourally in sync with `flow.js` — same geometry and styling for every feature (routing `zRoute`/`zroute`,
  `pipePoly`, Mario pipes, arrowheads + line trimming, `midOfPoly`, containment/`snapSide`, auto see-through,
  block types, legend) — whenever one changes, the other changes in the same edit. The `.svg` files are
  generated: **never edit an `.svg` by hand**; edit the `.json` / `.js` / `.py` and let the pre-commit hook
  re-render (FR18/FR21). After every `flow.js` edit run `node --check flow.js`. Note the hook re-renders
  but leaves the new `.svg` **unstaged** — stage them into the same commit.
- **FR84. (PROPOSED by Claude, not yet requested or built) Don't let a stale tab overwrite newer JSON.**
  Seen in practice: Claude added fields to `setup-map.json` while an editor tab that had loaded the OLDER
  file was still open; its 💾 save silently wrote the old content back and dropped Claude's change (FR10's
  shared-file round-trip). Proposal: the page remembers the file's content hash (or mtime) at load; `dash`'s
  write endpoint rejects a save whose base hash ≠ the file on disk, and the page then offers *reload* or
  *overwrite anyway* (or FR11 live-reload makes the tab pick up disk changes before the user edits).
  Until built: **reload the editor tab after Claude edits a diagram, before saving.**
- **FR85. Drill-down must actually open, and the "compare routes" link lives on The internet.** A box with a
  `childDiagram` opens it by **single-clicking its "⊕ open" link** (pointer cursor + underline on hover) or by
  **double-clicking the box** — in edit mode too. (Regression: neither did anything, because every press
  re-renders and replaces the node's element, so the browser's `dblclick` never reached the node, and node text
  had `pointer-events: none`. The double-press is now detected in `pointerdown`, 400 ms window; a double-press on
  a box with no sub-diagram still relabels it.) The free-floating "▸ Compare all 6 routes (pipes)" box
  (`seeroutes`) in `setup-map` was removed — it looked like a step in the setup flow and the install cable ran
  through it. Its link moved onto **The internet** (`inet.childDiagram = "tunnels"`), which is the question that
  drill-down answers (how the internet reaches the box), so `tunnels` stays reachable from the root.
- **FR86. Canonical positions: one object has ONE position in every view (toggle state) it appears in.**
  Moving a box in one toggle state moves it in all other states that show it — e.g. *Your computer*, *Your
  home router*, *Your new private server*, *The internet*. The data model already guarantees this (a node has
  one `x`/`y`; `showWhen` only hides it), so **one concept must be ONE node**, never per-state copies. Allowed
  exception: a deliberate per-state *nesting* (`containerWhen`, e.g. the server sits inside *Your computer*
  only for the VM install — see FR91). *Done:* *Buy a domain* existed three times in `setup-map` (`cfbuy` / `v6buy` /
  `pfbuy`, one per reach option, at different spots) → merged into ONE red node `buy` (shown for reach
  cloudflare / ipv6 / portfwd; red = costs money; the cloudflare and port-forward arrows now start from it). The `tunnels`
  drill-down keeps its own copies of server/router/internet/friend on purpose (separate Mario-style layout).
- **FR87. Hold Shift = see every view at once, with an overlap check.** While **Shift** is held (on its own,
  in normal editing or while dragging a box; while Ctrl-drawing an arrow or dragging an arrow's end it stays
  FR81's "exact spot" instead), the editor overlays **all reachable toggle states** of the diagram
  (dependent option lists respected, e.g. 50 for `setup-map`): every box position and every line/pipe that
  exists in some *other* state is drawn **dashed/translucent** on top of the current view, and every pair of
  boxes that **overlaps in a state where both are shown** is outlined **red** (containers and their nested /
  edge-snapped children don't count). The status bar lists the overlapping pairs with a state where each
  happens (`you × relayTS (cable·0a·tailscale +9)`) or says *✓ no boxes overlap in any state*. It updates live
  while dragging a box with Shift held, so a move in one configuration can be checked against all others.
  Releasing Shift (or the window losing focus) hides it again. View-only; never saved.
- **FR88. (REQUESTED — design in progress in the CLI-replay chat, NOT built) A real CLI recording that travels
  along the diagram and can be scrubbed by dragging.** For the install wizard (`setup-flow.md`) the user wants
  to **see how each question is answered**: a **small rectangular box showing the CLI** (a "gif" of the
  terminal) that **moves along the pipes / diagram blocks and lines**; when it sits at a specific question's
  node it shows what happens for that question. **Dragging the box up/down the path rewinds / fast-forwards**
  the recording according to its position along the trajectory. The recordings must be **real, not
  synthetic**, tied directly to the diagram and **regenerated when the code changes**; a **CLI check /
  pre-commit hook verifies that the diagram's nodes and paths still line up with the real CLI** (the questions
  it asks, in order). A node may show **more concise, guiding or illustrative text** than the literal CLI
  question, so the node↔question mapping must allow that (the mapping is what's verified, not identical text).
  The wizard steps correlate strongly with the `setup-map` pipes for the chosen toggles (e.g.
  `setup-map;method=usb;net=ua;reach=onion`), so the wizard view should either **reuse the chosen
  configuration and go one level deeper** to show its setup questions, or **lay the question information on
  top of the existing diagram** — the user asked for a plan comparing these before building.
  *Added (user, when switching this work to the Fable model):* the connection between the **code and the CLI
  recordings must be hard-enforced**, with **perfect timing** while the box slides / is dragged across the network /
  diagram / pipes (position ↔ recording time stays exactly in step); **no synthetic data** ever; and when the code is
  updated, running the **update scripts / CI pipeline regenerates the recordings ("gifs") automatically**. Design
  spec: `docs/superpowers/specs/2026-10-25-cli-replay-design.md` (awaits the user's decisions; not built).
- **FR89. Devices are drawn as their icon; arrow icons are large.** A box with `nodeType: device` and an
  `icon` (laptop, phone, router, server, cloud/internet, relay, Tor relay, …) is drawn **as that icon** — a
  pictogram scaled to fill its box, the name underneath (with a dark halo so it stays readable over lines) —
  **no rectangle**, so a viewer sees *what kind of device* it is at a glance. The (invisible) box still sets
  the size, anchors edges and is the drag/resize/snap target; selecting it shows a thin outline. **Exception:**
  a device that currently **contains** other boxes (Tor network + relays, the router holding the port-443
  gate, *Your computer* holding the VM) keeps its box, because a pictogram can't visibly hold children; its
  icon grows 24→34 px. The legend's device row shows a pictogram. **Arrow icons:** the kind icon on a plain
  arrow (cable/ethernet, wifi, USB, tunnel, Tor) is a **30 px icon on a dark round badge** ringed in the arrow's
  colour, centred ON the line (was an 18 px grey icon beside it); the arrow's label moves above the badge
  with a halo. Mirrored in `docs/gen_flow_svg.py` (`picto_geom`, `EBADGE`, `HALO`).
- **FR90. Four line types, told apart by pattern, with a line legend top-right.** Every line says what it
  MEANS via `edge.role` ∈ `link` | `tunnel` | `action` | `info` (pattern, not colour — colour stays the route's
  own, FR59; it also survives greyscale / colour-blindness):
  - **link** — the two devices are *physically connected* (cable / wifi / USB): thin solid line (wifi dashed),
    **no arrowhead** (traffic goes both ways), the medium's badge on the line (FR89).
  - **tunnel** — a *route that carries traffic* between devices: always drawn as the Mario pipe (FR52).
  - **action** — *someone does this, to that*: thick dashes with an **open chevron** head, pointing from who
    acts to what changes (e.g. *Your computer → manual work → Open port 443*).
  - **info** — *information that must go in or come out* (a name, key, token, DNS record): round **dots** with
    a filled head and a **document badge** on the line (e.g. *Buy a domain → server*, *friend → DuckDNS name*).
  Missing `role` is derived (`pipe` → tunnel, cable/wifi/usb/lan → link; otherwise the old plain arrow), but
  every edge in all diagrams now carries an explicit role. The **arrow box** gets a **type** row (link /
  tunnel / action / info) that switches a line's type (tunnel ⇄ pipe kind); a link hides the direction row.
  The **legend** (top-right) now has two sections — *BOXES* (FR82/89) and *LINES* — each shown only when the
  diagram uses it; `fit` keeps its band free. A *needs / depends on* type was considered and folded into
  *info* (what's needed is almost always a piece of information). Mirrored in `docs/gen_flow_svg.py`
  (`LINE_ROLES`, `role_of`, `line_dash`, `chevron`, two-section `legend_svg`); new `doc` sprite in
  `docs/icons.svg`.
- **FR91. A box may have a different position in specific views: *Your new private server* is OUTSIDE *Your
  computer* everywhere, but INSIDE it for the VM install.** Done with conditional nesting: `server.container =
  "you"` + `containerWhen = {method: ["vm"]}` → in the VM view it sits inside the computer at `cdx`/`cdy`; in
  every other view it is free at its own `x`/`y` (now centred below the computer, clear of other boxes). The two
  positions are independent: dragging it in the VM view only moves it **within** *Your computer* (changes
  `cdx`/`cdy`, never `x`/`y`); dropping it outside the computer there **snaps it back** with a status hint
  (instead of silently dropping the VM-only condition, which is how it got lost — a drag out and back in the VM
  view made the nesting unconditional, so the server sat inside the computer in every view). Dragging it in any
  other view only moves its free `x`/`y`. Un-nesting is deliberate: ⊏ contain. The Shift overlay (FR87) shows the
  other position as a dashed ghost.
- **FR92. A line can attach to ANY side of a box — including the far side — wrapping round it; lines touch a
  pictogram's drawn icon.** (Regression report: on `setup-map;method=usb;net=ua;reach=portfwd` the *Buy a
  domain → A friend's phone* line could not end on the phone's right-edge midpoint — it snapped to the top/
  bottom-right corner — and its last vertical segment could not be dragged further right than the box's right
  edge, so it could never get the extra bend to wrap round.) The route model only knew the side *facing* the
  other end plus a top/bottom "stub" clamped to the box's width. Now: (a) attaching an end to a point on the
  **far side** routes over/under the box (the side nearer the other end), past its far edge, and back in
  horizontally/vertically at **exactly** that point; (b) dragging the stub segment **past** the box's edge
  (|`ss`|/|`es`| > half the box) no longer clamps — it gains one more 90° bend into that side; the new offsets
  `sf`/`ef` set where it enters along that side (0 = midpoint; draggable; *reset route* clears them). (c) For
  **pictograms** (FR89) every line, its attach/snap points and the attach highlight use the **drawn glyph's
  outline**, not the invisible box — each sprite in `docs/icons.svg` carries its measured outline as
  `data-bbox` (24-grid, incl. half the stroke), read by both `flow.js` (`anchorBox`) and `docs/gen_flow_svg.py`
  (`anchor_box`), so an arrow tip lands ON the phone, not ~50 px beside it. The box still does drag / resize /
  nesting / snapping. Mirrored in `docs/gen_flow_svg.py` (`zroute` stub/wrap, `anchor_box`).
- **FR93. Tunnels run THROUGH the home router; port-forward opens a port IN it.** (User: on
  `setup-map;method=cable;net=0b;reach=tailscale` the tunnel must go *from your new private server THROUGH the
  router to Tailscale, then from Tailscale to the internet* — the same for Cloudflare, direct IPv6 and .onion;
  only port-forward shows a small interruption in the middle of the router icon with an icon of a port being
  opened.) New edge fields: **`via`** = boxes a tunnel passes *through* — the route is one continuous pipe
  a → into each via box → across its centre → out towards the next box (hidden via boxes are skipped, e.g. no
  router for the VM install); if it would leave a via box on the side it entered (a dead end, not "through"),
  that leg turns 90° and leaves on the other axis. **`gate`** (a via box) = the pipe is **broken open** at that
  box's centre and an **open-port badge** (new `port` sprite: a network socket) sits in the gap, drawn above the
  device icon. A through-route's label sits on its longest straight stretch; its shape follows the boxes (drag
  the boxes, or drag an end onto another box; segment-dragging came later — FR95). Data: `e_ts_up` / `e_cf_up` /
  `e_tor_up` / `e_v6` now start at the server with `via: ["router"]`; the two-piece port-forward route
  (router → gate box → internet) became ONE pipe `e_pf_b` server → internet, `via` + `gate` router. The
  *Open port 443 by hand* action box left the router (it's beside it, with an **action** line into the router),
  so the router is a clean pictogram in every view. The Tailscale / Cloudflare relays and the Tor network (and
  the *.ts.net note) were moved into the gap between router and internet — they overlapped the router, so
  "through the router, then to the relay" couldn't read; `e_tor_run`'s stale route offsets were cleared. Also
  fixed: an edge attached to a spot ON a pipe used the pipe's box-route, not its drawn (pictogram, FR92) route.
  Mirrored in `docs/gen_flow_svg.py` (`through_box`, `route_axis`/`_H`, `gate_split`, `longest_mid`).
- **FR94. Pan position and zoom are remembered across saves and page loads.** Each diagram's view
  (`x`/`y` pan + zoom `k`) is stored **per browser** in `localStorage` (`flow.view.<diagram-id>`), written
  ~250 ms after any pan / zoom / fit — never in the diagram JSON (it is a viewer preference, not diagram data, so it
  never shows up in diffs). Opening a diagram — page load, reload, the picker, a breadcrumb, a drill-down — restores
  its remembered view; **⤢ fit** is only used when nothing is remembered yet, and pressing ⤢ fit makes the fitted
  view the remembered one. Saving never changes the view. Each diagram keeps its own view. Storage failures
  (private window, blocked site data) silently fall back to fit. `tools/shot_flow.py` is unaffected (fresh
  browser profile + it clicks ⤢ fit).
- **FR97. Undo / redo.** **Ctrl+Z** (⌘Z) undoes the last change to the diagram; **Ctrl+Shift+Z** or **Ctrl+Y**
  redoes it; toolbar buttons **↶ / ↷** do the same (with hover help, FR73). One *gesture* is one step: a whole box
  drag / resize / drop-snap, an edge drag or re-attach, a Ctrl-drawn arrow, a button / prompt action (label, icon,
  type, line type, contain, show-when, toggles, delete …), and a continuous slider or colour-picker drag in the arrow
  box all undo in ONE press. History is per diagram (cleared when another diagram is opened), up to 200 steps; a
  new edit after undoing clears the redo list. Undoing back to the last saved state clears the unsaved-changes
  marker. Shortcuts work while an arrow-box slider/picker has focus; in a text field the browser keeps its own
  undo. Only diagram data is undone — not the toggle state, pan/zoom (FR94) or selection. Implemented as JSON
  snapshots recorded in `markDirty` (the single funnel every edit already goes through) and committed when the
  gesture ends.
- **FR95. Every segment of a through-route (FR93) can be dragged, and you pick where it enters / leaves each via box.**
  (User: on `setup-map;method=wifi;net=w1;reach=onion` the Tor pipe server → router → Tor could not be moved —
  neither its horizontal run out of the router nor its vertical run from the server down into it — and *let me pick
  the entry and exit points of the tunnel through the router, whilst still keeping them going through the router*.)
  A through-route is one leg per pair of consecutive boxes (a → via… → b); each leg drags exactly like a plain route
  (FR79: a run sideways = shift its attachment along the side, past the side's extent = one more bend; elbow = `mo`;
  a run dragged level with the other end snaps straight). Dragging the run next to a via box therefore moves where
  the pipe **enters / leaves that box** — it always still crosses the box's centre (the part *inside* the box is
  not draggable; the status bar says to grab it just outside). Storage: the route's own start / end offsets stay
  top-level (`so`/`ss`/`sf`, `eo`/`es`/`ef`, as before — also what the end handles set); everything else lives in
  **`legs["<from>><to>"]`** (e.g. `legs["router>tn1"].so` = where it leaves the router), keyed by box ids so a view
  that hides a via box (VM: no router) simply ignores that leg's offsets. Empty entries are dropped (an untouched
  route saves byte-identically); *reset route* clears `legs` too. The arrow box now opens beside the line wherever it
  would otherwise cover any segment (it covered the vertical run, so a second drag was impossible). Mirrored in
  `docs/gen_flow_svg.py` (`leg_offsets`; `pipe_poly` gets via `(id, box)` pairs) — editor ↔ renderer verified
  point-for-point on the dragged Tor route.
- **FR96. The arrow box names the line, and puts it in front of or behind the boxes.** (User: *give an identifier
  for the line so I can refer to it easily with you, in the box that sets head and width; also add an option to that
  box to move the line (including its arrowhead) to the front or back, w.r.t. the object it crosses and/or attaches
  to.*) The arrow box's first row is **line `<id>`** (the edge's `id`, e.g. `e_tor_up`) — click it to copy the id
  (dragging the box from there does not start a move). A **layer: back | front** row: **back** (default, no field
  saved) draws the line under every box, as before; **front** saves **`z: "front"`** and draws the whole line —
  pipe, wire, arrowhead / chevron, badge, label — above every box (so it also becomes grabbable where it crosses
  one) and above the open-gate badges (FR93/FR100 — changed by FR102), still under the selection handles. Mirrored in `docs/gen_flow_svg.py` (a
  `front` buffer emitted after the boxes and the gate badges) — verified live: DOM order flips router ↔
  `e_tor_up` and back, and `z` is removed again on *back*.
- **FR98. The arrow box keeps the spot you dragged it to — per line, saved with the diagram.** (User: *if I click a
  line and move its line label box (width and head), ensure the position of that box is saved so that if I click
  away and reclick the line, it puts the box in the same position I left it; also include this info in the save.*)
  Dragging a line's arrow box (FR78) stores its top-left as **`edge.bp = {dx, dy}`** — an offset from the line's
  midpoint in **diagram units** — so re-selecting that line (after clicking away, reloading, or on another
  machine after a save) puts the box back exactly there, and it stays at that spot on the line when you pan, zoom
  or move the boxes. Each line remembers its own spot; a line without `bp` uses the automatic spot that keeps
  clear of the line (FR95). The position is part of the diagram JSON (saved, deterministic, rounded to whole
  units), marks the diagram changed, and one box drag is one undo step (FR97); **double-click** the box's
  background = back to the automatic spot (also saved + undoable). A plain click on the box is not a move.
  Editor-only — the static snapshot draws no arrow box.
- **FR99. A device drawn as an icon is selected by, and resized at, its icon — not its larger layout box.**
  (User: *make the hitbox of the router smaller so that its selection edges are on the edges of the router icon.*)
  For every pictogram device (FR89) the **click area, the selection outline and the 8 resize handles** use the
  icon's **drawn outline** (its measured `data-bbox`, the same outline lines attach to — FR92), so clicking empty
  space beside the icon no longer selects it and the dashed outline hugs the icon. Dragging a handle **scales the
  icon evenly** from the opposite edge (a side handle by that side, a corner by the larger of the two), and the
  layout box is set to hug exactly the icon square plus its label, so outline, icon and box stay in step (works
  for a nested pictogram too, via `cdx`/`cdy`). One resize = one undo step (FR97). Moving, snapping and nesting
  still use the layout box. Editor-only (the snapshot draws no selection).
- **FR100. The open port is a barrier gate you can move inside the router; arrows attach to the gate itself.** (User:
  on `setup-map;method=wifi;net=w1;reach=portfwd` *look at how the action line attaches to the port-open icon — allow
  me to move the gate-open icon within the router, use the gate-open icon in `images/` to visualise it, and ensure
  the arrow still attaches to the moved gate icon and not to the router*.) The FR93 open-port badge now shows a
  **boom barrier with its arm raised** (new sprite `ic-barrier` in `docs/icons.svg`, redrawn after
  `images/open-gate-clipart-4.png` — that PNG is a watermarked stock icon, so it is not embedded). **Drag the badge**
  to move the gate anywhere inside its box (the gate box's drawn outline, FR92; the badge always stays fully
  inside): stored as **`gx` / `gy`** on the pipe = offset from the box's centre (absent = centre); a click without
  moving still selects the pipe. The pipe crosses the box **through the gate** (not the centre) and is broken open
  there. An arrow end can attach to the gate: **`toOn` / `fromOn` = `"<pipe>:gate"`** — the end lands on the
  badge's outline and follows the gate when it moves; dropping an arrow end on (or next to) a badge snaps to it.
  Data: `e6` (*Open port 443 by hand* → port) now uses `toOn: "e_pf_b:gate"` — before, it was pinned to a pipe
  elbow (`c3`) that only happened to be beside the badge. Mirrored in `docs/gen_flow_svg.py` (`gate_point`,
  `through_box(…, c)`, `pipe_spot_box` key `gate`) — editor ↔ renderer verified point-for-point for `e_pf_b`
  and `e6` after moving the gate.
- **FR101. *Buy a domain* and *DuckDNS* are either/or — a Name toggle picks one.** (User, on
  `setup-map;method=wifi;net=w1;reach=portfwd`: *port-forward with a registrar domain doesn't give a DuckDNS name,
  right?* — correct: DuckDNS is the free alternative to buying a domain, usable for **both** direct routes
  (port-forward = A record → your public IPv4; direct IPv6 = AAAA → the server), never for a Cloudflare tunnel (no
  NS delegation; `tools/add-cloudflare.sh` says the same). The diagram showed both boxes at once, each with a line to
  the friend's phone, so it read as "you need both".) New `setup-map` toggle **`name`** = *Buy a domain* (`buy`,
  default) | *DuckDNS (free)* (`duckdns`), offered via `optionsWhen` per Reach: IPv6 + Port-forward → both;
  Cloudflare → *Buy a domain* only (shown, so the view says a real domain is needed); Tailscale / .onion → *n/a*
  (those give you a name). `buy` shows only with `name=buy`; `duck` + `e_duck` only with `name=duckdns`; new info
  line **`e_duck_srv`** DuckDNS → server *name + token (keeps it pointing at you)* (the DuckDNS counterpart of the
  registrar's line to the server). The port-forward warning now says *(router + domain name)* instead of *(router +
  registrar)*, true for both choices. A URL with a name that the Reach doesn't offer falls back to the default
  (`reach=cloudflare;name=duckdns` → `name=buy`).
  *Same slot (user: make the Buy-a-domain and DuckDNS-free boxes the same position and size):* because the Name toggle
  shows exactly one of them, both boxes share ONE position and size — 244×85 at (747, −134), centred where *Buy a
  domain* was and sized for DuckDNS's three text lines — so switching the toggle swaps the box in place.
- **FR102. A front arrow's head is never hidden by the gate or the box it ends at; the gate is resizable.** (User:
  *line e6's arrowhead, when I click to front, seems to be behind the router icon and behind the gate icon; I want
  to be able to resize the gate icon.*) Three parts:
  1. **Layer order:** *front* lines (FR96) are now drawn above the open-gate badges too (boxes → gate badges →
     front lines → handles), in `flow.js` and `docs/gen_flow_svg.py`.
  2. **Routing — an elbow dragged past the target never doubles back into it.** The cause was `e6`'s elbow (`mo`),
     tuned for its old target: it landed *inside* the gate's extent, so the route turned back into the gate and the
     head sat under the badge. Rule (both renderers, `zRouteSegs` / `zroute`): when the elbow lands within a box's
     extent along the main axis, the line ends on the **side of that box it runs into** (same for the start box).
     Checked over every toggle state of every diagram: only `e6` (now enters the gate from the left, head
     visible), `e_wifi` (looks identical — the part that used to double back was hidden behind the router icon) and
     a ~3 px line in the VM view (`e5`) change.
  3. **Gate size:** the arrow box of a gated pipe has a **gate** slider (10–60) = the badge's radius, stored as
     **`gr`** on the pipe (absent = 20). It sizes the badge and its barrier icon, the gap in the pipe, how close
     to the box edge the gate can be dragged (FR100), and where an arrow on the gate lands — the arrow follows the
     resized gate. Verified live (head drawn above the badge, gate 20 → 40, arrow tip moves out with it) and
     editor ↔ renderer point-for-point.
- **FR103. An action / information line's COLOUR says what it costs you; the legend explains it.** (User: *red lines
  should be for things you need to do that cost money; orange lines for things you need to do at an intermediary /
  some non-decentralised entity you depend on, like DuckDNS, Cloudflare, Tailscale etc.; yellow lines for actions
  that do not cost money and aren't at a centralised entity, like configuring your router. It is the same for
  getting information (lines). Add this to the legend and implement it in the drawings.*) New edge field
  **`cost`** ∈ `paid` (**red** `#e5484d` — costs money, e.g. buying a domain) | `central` (**orange** `#f97316` — at /
  from a company you depend on: Cloudflare, Tailscale, DuckDNS …) | `free` (**yellow** `#eab308` — free and in your
  own hands, e.g. opening a port in your own router). Applies to **action and information lines** (FR90); links and
  tunnels keep their own meaning/route colours (FR59). When several apply, **money wins**. An explicit `color`
  still overrides; choosing a cost in the arrow box removes a hand-picked colour so the meaning shows. The
  **legend** gets a third section *LINE COLOUR — ACTIONS + INFO* (shown only when a diagram uses it); the
  **arrow box** gets a **cost** row (€ money / company / free / –, hidden for links and tunnels). Data: the
  domain-buying lines are red (*Your computer → Buy a domain*, *Buy a domain → Cloudflare / server / friend*, *→
  manual work (router + domain name)*); DuckDNS / Tailscale / trycloudflare name lines orange (they were drawn red
  before — DuckDNS is a company you depend on); *open port 443 → the router's gate* yellow; the install /
  overview steps on your own machines yellow; the overview's *public URL* orange (the recommended route,
  Tailscale, hands it out). Mirrored in `docs/gen_flow_svg.py` (`COST`, `line_color`, legend section).
- **FR104. ⌖ Anchor: one box stays on the same screen spot in every view and diagram.** (User: *a button that allows
  one to center the views based on a specific item — default w.r.t. your new private server;* then corrected: *I mean
  center it to the position the item is. So you select an item, and then press center and all of the diagrams that
  contain that item are centered with the center of gravity of that item on the same position in the screen (their zoom
  levels may still be whatever they were). Don't put it in the legend, put it in the Install / Network / Reach / Name bar,
  and don't include the dropdown.*) A **⌖ button at the end of the toggle bar** (no dropdown, nothing in the legend):
  **select a box, press ⌖** → that box's **current spot on screen** becomes the anchor. From then on **every view**
  (each toggle combination) and **every diagram** that contains a box with that id (e.g. the *tunnels* drill-down's own
  *server*) is panned so the box's centre — a pictogram's drawn icon (FR92) — lands on exactly that spot, each view
  **keeping its own zoom** (FR94). It is applied when you switch a toggle and when a diagram opens, so e.g. the server,
  which moves into *Your computer* for the VM install (FR91), no longer jumps on screen. While active the ⌖ button is
  highlighted and its hover help + the status bar name the anchored box (icon-only, so the bar stays one line — FR105). **Nothing selected = the default, *Your new private server***; while anchored,
  **⌖ with nothing selected (or with the anchored box selected) releases it**.
  Panning by hand still works; the next toggle switch puts the box back on its spot. The anchor (box id + screen spot)
  is per browser (localStorage), never in the diagram JSON, and survives reloads. Hover help explains it (FR73).
- **FR105. The toggle bar (Install / Network / Reach / Name) is one line whenever it fits.** (User: on
  `setup-map;method=wifi;net=w1;reach=onion` the bar was 3 lines high, on `…;reach=portfwd;name=buy` only 1 — with
  *more* in it.) Cause: an unavailable toggle shows *— n/a* in a `.empty` span, and the page's generic `.empty`
  placeholder style (24 px vertical padding, block) made that one item 64 px tall. `#togglebar .empty` now has no
  padding and is inline; each toggle group is `flex: none; white-space: nowrap`, so a group never breaks inside
  itself and the bar wraps whole groups onto 2…N lines only when the window is too narrow. Verified: 35 px (one
  line) at 1600 px wide for onion, port-forward and VM; at 700 px it wraps to two lines.
- **FR106. 🔨 Fix a box's position everywhere.** (User: *add another button (hammer & nail icon) that fixes all positions
  of that icon across the visualisations — except for the VM private-server-in-computer thing; then just do it for the
  majority configuration group, so in that case for the non-VM install.*) A **hammer-and-nail button** (new `hammer`
  sprite) next to ⌖ in the toggle bar (FR104): **select a box, press 🔨** → its position **and size** are copied onto the
  box with the **same id in every other diagram** (e.g. *server / router / internet / friend* in the *tunnels* drill-down),
  written straight to those files through the dash write-API. (Within one diagram a box already has one position in every
  view — FR86.) The copied position is the one the **majority of views** use: the box's free `x`/`y`; a **conditional
  nesting** (`containerWhen` — the server inside *Your computer* for the VM install, FR91) is the exception and is **left
  alone** in both diagrams. An always-nested box copies its offset inside its parent, only where the other diagram nests
  it in the same parent; a box nested differently there is skipped and named. The status bar lists the diagrams changed /
  already equal / skipped. Not undoable with Ctrl+Z (it writes other diagrams); needs `./dash serve`. Icon-only (its
  hover help explains it, FR73), so with ⌖ the toggle bar still fits on one line (FR105; checked at 1600 and 1366 px).
- **FR107. Free names are a choice with their limitations shown: *Free \*.trycloudflare.com* and *DuckDNS*.**
  (User, on `setup-map;method=usb;net=ua;reach=cloudflare;name=buy`: *give the choice button for "free
  \*.trycloudflare.com" and indicate a warning with any limitations if it is chosen — duration, MB throughput or
  anything; add that warning for free DuckDNS as well.*) The `name` toggle (FR101) gets a third option
  **`trycf`** = *Free \*.trycloudflare.com*, offered only for Reach = Cloudflare (Cloudflare → *Buy a domain* |
  *Free \*.trycloudflare.com*). The existing `cffree` box now shows only with `name=trycf` (no longer beside *Buy a
  domain*), relabelled *(random name, no account)*. Two red **warning** info boxes (⚠, like the port-forward one):
  - **`trywarn`** (Cloudflare + trycf), from Cloudflare's own Quick-Tunnel docs: for **testing only**; **random
    name that changes on every restart** (shared links stop working); **no uptime guarantee**; **max 200
    requests at once** (more → error 429); **no SSE** (live push updates); **no bandwidth or time cap is
    published** — so no MB/duration limit is claimed.
  - **`duckwarn`** (IPv6 / Port-forward + duckdns), from duckdns.org's FAQ/spec: **volunteer/donation-run, no
    uptime guarantee**; only *yourname.duckdns.org* (no own domain); **one TXT value at a time** (certificates
    issued one name per step); **~5 names per account** (reported by third parties, not on duckdns.org — marked
    "reported"); IPv6 is **not auto-detected** (the server must send it).
  Verified live: each Reach shows only its own options/boxes, an unavailable name in the URL falls back
  (`reach=portfwd;name=trycf` → `name=buy`), the toggle bar stays one line (FR105), no overlaps.
- **FR108. The *Free \*.trycloudflare.com* box is orange and wired like *Buy a domain*.** (User, on
  `setup-map;method=usb;net=ua;reach=cloudflare;name=trycf`: *make it orange and add the lines from your computer,
  to the private server and to the phone like in buy a domain* (`…;name=buy`).) New box colour **`orange`**
  (fill `#2a1a0c`, stroke `#f97316` = the FR103 *central* line colour: *at a company you depend on*) in both
  `flow.js` `PALETTE` and `docs/gen_flow_svg.py` `PALETTE` (also offered as a swatch); `cffree` uses it. Three
  new lines mirror `buy`'s, but coloured **`cost: "central"`** (orange — it's free but at Cloudflare) instead of
  `paid` (red): **`e_try_you`** your computer → box (action, like `e8`), **`e_try_srv`** box → server (info, like
  `e7`), **`e_try_friend`** box → friend's phone (info, like `e4`); their route offsets were copied from the
  `buy` lines (the box sits where *Buy a domain* does), so both views look alike. They follow the box's
  visibility (Cloudflare + `name=trycf` only). Verified live side by side with the `name=buy` view.
- **FR109. Tailscale's free name is wired the same way, in orange.** (User, on
  `setup-map;method=usb;net=ua;reach=tailscale`: *add the same lines from your computer, private server and friend
  phone for tailscale — also orange.*) The `tsname` box (*Free name: \*.ts.net (nothing to buy)*) is now
  **orange** (FR108) and sits where *Buy a domain* / *Free \*.trycloudflare.com* sit (it was tucked under the
  Tailscale relay; it only shows in Tailscale views, so no other view moves). Three new **`cost: "central"`** lines
  copy the trycloudflare ones (FR108): **`e_ts_you`** your computer → name box (action), **`e_ts_srv`** name box →
  server (info), **`e_ts_friend`** name box → friend's phone (info). `e3` (Tailscale relay → name box) stays.
  Verified live: the Tailscale view now reads like the Cloudflare and Buy-a-domain views.
- **FR110. The legend can be moved and reshaped, and remembers where you put it.** (User: *allow people to move the
  legend, store its position; allow people to reshape the legend (use line-wrap); block if it doesn't fit.*)
  **Drag** the legend anywhere on the canvas (kept inside it, also after a window resize). **Drag its corner grip**
  to reshape: labels **wrap** to the width, and each section (caption + its rows) flows into a **new column** when
  the legend is made wide and short. **Blocked if it doesn't fit**: a size at which anything would overflow is
  refused — width and height are tried separately so the corner slides along the limit, otherwise the last shape
  that fit stays (red outline while blocked); e.g. it can't get narrower than its longest word.
  **Double-click** = back to the default top-right spot and natural size. Spot + shape are remembered **per
  browser and per diagram** in `localStorage` (`flow.legend.<diagram-id>`, like the FR94 view) — never in the
  diagram JSON, so it is a viewer preference that can't collide with saves; a remembered shape that no longer fits
  (more legend rows later) falls back to the natural size. The static SVG legend (`docs/gen_flow_svg.py`) is
  unchanged. Verified live: move, wide+short (3 columns), narrow (labels wrap, stops at 174 px), blocked shrink,
  survives reload, other diagrams keep their own default, double-click resets.
- **FR111. Tailscale gets a limitations warning too.** (User, on `setup-map;method=cable;net=0a;reach=tailscale`:
  *add the warning box if it should have one.*) New red ⚠ info box **`tswarn`** (all Tailscale views, at the
  `trywarn` spot — they never show together), from Tailscale's Funnel docs (kb/1223) + this project's findings:
  needs a **Tailscale account** (Google/GitHub/… login) — at a company; the name is
  **`<machine>.<tailnet>.ts.net`**, no own domain; **one name only → the app's API, not the cloud. / git. /
  matrix. / meet. services** (handover 11: single-hostname tunnels serve the API only); **bandwidth limits (not
  published)**, still **beta**; a new name can take **~10 min** to work (DNS); **reinstall → new name, old links
  stop working** until the box keeps its Tailscale state (handover 13 node-sprawl). Verified live, no overlaps.

## Nested-tunnel scope (branch `nested-tunnels`, experiment)

The physical links and the tunnels used to be drawn as separate lines: e.g. on
`setup-map;method=cable;net=0a;reach=portfwd;name=buy` the LAN cable `e_scable` ran server → router on its own, and
the yellow tunnel showed how the server reaches the internet — but in reality that yellow tunnel runs *through* the
LAN cable. This scope draws the tunnel inside the connection that carries it. **No positions change** — no device,
text balloon or line offset in the diagram JSON is touched; only how links are drawn.

- **NT1. A link that carries a tunnel is drawn as a sleeve around it.** A physical link (`role: link` — cable /
  wifi / usb / lan) whose two ends are two **consecutive stops of a visible tunnel's route** (`from` → `via`… →
  `to`, either direction) is drawn as a **larger tunnel around that stretch of the tunnel**, following the
  tunnel's route exactly (not the link's own route). Found automatically for every view (e.g. `e_scable` around the
  yellow / purple / orange / grey / blue tunnel, `e_swifi` on wifi-only), so each Reach shows its own tunnel inside
  the same cable. A link that carries no tunnel (or `nest: false`) stays a plain line.
- **NT2. The sleeve stops short of both ends, by different factors.** It ends **`nestA` × its radius** from the box
  at end A (the link's `from`, default **1**) and **`nestB` × its radius** from end B (`to`, default **2**, wider),
  so the inner tunnel **comes out further from the device** at both ends. The cut is measured along the route (over
  bends if needed); a stretch too short for both cuts falls back to the plain line.
- **NT3. Wider and see-through.** Sleeve width = **`nestW`** × the inner tunnel's width (`pw`, default 22; default
  **1.9**), opacity **`nestOp`** (default **0.4**). It is drawn **above every tunnel** (so the tunnel visibly runs
  *inside* it) and still **below the boxes**; `z: "front"` (FR96) still puts it above the boxes.
- **NT4. The link's icon stays visible on the sleeve.** For now the LAN-cable / wifi / USB badge (FR89) and the
  label are drawn on the sleeve (at its midpoint) instead of changing the ends.
- **NT5. Editing.** Clicking the sleeve selects the link (the arrow box sits by the sleeve); dragging a segment
  drags that segment of the tunnel inside (NT9) — the sleeve follows; the end handles still re-attach the
  link. All four parameters are optional fields on the link edge (absent = the defaults above).
- **NT7. The sleeve's numbers are set in the line's arrow box.** (User: *configure those numbers in the line popup
  when I select the encapsulating line.*) When the selected line is drawn as a sleeve, its arrow box shows a
  **sleeve** section — **end A** / **end B** (0–6 × the sleeve radius, step 0.1), **width** (1.1–4 × the inner
  tunnel, step 0.1), **opacity** (5–100 %) — live while dragging, one undo step per change; the head / width row
  (not meaningful for a sleeve) is hidden. A value equal to the default is removed from the edge (nothing stored).
  Verified live: values 0.5 / 4.0 / 2.6× / 70 % re-shape the sleeve and are saved as `nestA` / `nestB` / `nestW` /
  `nestOp`; setting end A back to 1.0 removes `nestA`.
- **NT8. End gaps can be negative, so the sleeve can touch the icons.** (User: *allow sliding the distance into
  negative values w.r.t. the radius — hit boxes are square but icons aren't; I want it to be able to touch the
  icons.*) `nestA` / `nestB` (and their sliders) go from **−4** to 6: a negative gap **lengthens** the sleeve's
  end segment outward by that many radii, past where the tunnel stretch meets the box's square outline and into
  the box, so it can reach the drawn icon (the boxes are drawn on top, so it disappears under the icon, never over
  it). Mirrored in `docs/gen_flow_svg.py` `trim_poly`. Verified live: end A −1.2 / end B −1.5 makes the sleeve touch
  the server icon and the router's antennas; editor ↔ renderer identical.
- **NT9. Sleeve editing fixes.** (User, on `setup-map;method=wifi;net=w1;reach=cloudflare;name=buy`: *it glitches when
  I go negative; I can't move the rightmost vertical segment of `e_scable` any more; when I grab the box to adjust
  the end distance it jumps ~2.5× its width to the right before I can move it.*) (1) The arrow box of a sleeve is
  anchored to the **tunnel stretch it wraps** (fixed), not to the sleeve itself — before, its midpoint moved with
  end A / B, so the box and the slider under the mouse shifted while sliding (the glitch). (2) Placing and dragging
  the box use that **same anchor** (`panelLine`) — before, the box was placed by the sleeve but dragged relative to
  the link's own, unused route, so the first drag jumped (FR98 `bp` offsets). (3) Dragging a sleeve's segment
  **drags that segment of the tunnel inside** (FR95 leg offsets, stored on the tunnel) and the sleeve follows.
  Verified live: box fixed while sliding end A 1 → −4; a grab moves the box exactly with the mouse; the rightmost
  vertical segment drags (x 938 → 822) and the sleeve follows.
- **NT10. A USB link animates the stick carrying the data.** (User: *show a USB-stick icon travelling across (and
  back) the line for USB transfer, with a small light as payload that comes out of "your computer" and goes into
  "your new private server".*) Every `kind: usb` link (today `e_usb`, USB install views) gets a looping **6 s**
  animation: a small **light** appears at the source box's centre (it shows through the laptop's screen) and moves
  to the line start (0–10 %), rides the **USB stick** (an `ic-usb` badge) along the line (10–45 %), goes into the
  target box's centre and fades out under its icon (45–55 %); the stick waits, then travels **back empty**
  (55–90 %) and waits at the start. Plain SVG `<animateMotion>` along the drawn route (follows any re-routing), the
  same markup in the live page and the static SVG (`usb_trip_svg`); not clickable; hidden when the viewer prefers
  reduced motion (CSS media query, also inside the static SVG). Verified with the SVG timeline paused at 0.3 /
  0.9 / 1.7 / 2.6 / 3.1 / 4.2 / 5.6 s.
- **NT11. A LAN link's sleeve is drawn as a LAN cable.** (User: *change the encapsulating LAN tunnel to an
  encapsulating LAN cable*; agreed reasoning: a cable with RJ45 plugs is recognised without a legend, while a pipe
  around a pipe reads as "a tunnel inside a tunnel".) For `kind` `cable` / `lan` the NT1 sleeve is no longer a
  Mario pipe but a **cable**: a round jacket (dark outline, body in the line colour — default grey `#8b949e`, a
  light and a dark stripe for roundness) ending at each end in a **boot** (darker, 0.6 R long, 2.2 R wide) and a
  **clear RJ45 plug** (1.6 R long, 2.4 R wide, 6 gold contacts at the tip, a latch on one side), R = sleeve radius.
  The plug tips sit exactly where the sleeve ends, so end A / end B (incl. negative, NT8), width and opacity work
  unchanged; a stretch too short for two plugs shows just the jacket. The wifi sleeve stays a see-through pipe.
  Mirrored in `docs/gen_flow_svg.py` `cable_svg`; verified: plug / boot geometry identical in editor and renderer.
- **NT12. The moving USB stick's size is a parameter.** (User: *a numeric factor w.r.t. the line width to increase
  the size of the moving USB icon.*) Field **`usbS`** on a USB link = the stick's radius ÷ the line width
  (default **1.8**, i.e. today's size on `e_usb`'s width-6 line); the stick's icon and the travelling light scale
  with it. Set with a **usb stick** slider (0.5–6×) in the arrow box of a USB link; the default is not stored.
  Mirrored in `usb_trip_svg`. Verified live: 1.8× → 3.5× grows the stick radius 10.8 → 21, saved as `usbS: 3.5`.
- **NT6. Mirrored in the static SVG** (`docs/gen_flow_svg.py`: `pipe_legs`, `nest_host`, `trim_poly`, `NEST`).
  Verified: editor ↔ renderer sleeve geometry identical point-for-point in five views (cable/portfwd,
  wifi/onion, wifi-only/tailscale, usb/trycloudflare, cable+wifi/ipv6); no diagram JSON changed.
