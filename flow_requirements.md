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
- **FR68. Resize nodes by drag (width / height / diagonal).** The selected node shows 8 resize handles —
  4 edge-midpoints (grab to change **width** [e/w] or **height** [n/s]) and 4 corners (grab to resize
  **diagonally** [nw/ne/se/sw]). Left/top handles move the opposite edge in place (adjust `x`/`y`, or
  `cdx`/`cdy` for a contained node); min size 40. Handles stay ~constant size on screen across zoom. The
  new `w`/`h` (and `x`/`y`/`cdx`/`cdy`) round-trip through the deterministic save (FR8).
