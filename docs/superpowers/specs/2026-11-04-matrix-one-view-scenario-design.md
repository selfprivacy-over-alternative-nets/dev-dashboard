# Test matrix: one Reach × Name × Scenario view at a time — design

*2026-11-04 · built the same day (reqs 185–187 in `requirements.md`) · owner: Akke.*

The ask (2026-11-04): on `index.html#method=cable;net=0a;reach=ipv6;name=buy;scenario=first` — the link a
setup-map view gives — make **Reach, Name and Scenario selectable**, keep the results in **columns per Install
option with a sub-column per Network choice, local and CI per result**, keep **the tests in the rows**, and make
the matrix ready for the Tailscale view's options (`flow.html#setup-map;method=cable;net=0a;reach=tailscale;
scenario=first;step=3`): Name *— n/a*, Scenario *First install · Reinstall · Restore a backup*. Layout only; what a
cell offers (exact command, runs, logs, screenshots, video, "all runs") stays as it is.

## 1. Decisions

| Question | Decision | Why |
|---|---|---|
| What the toolbar is | The diagram's toggles, **single-select**: Reach · Name · Scenario (Name / Scenario read *— n/a* where the diagram offers none for that reach), then the harness's client show/hide, then ▦ to the selected view. The Install / Network show-hide chips are gone. | The page shows what the diagram shows: one view. Install × Network are the columns, every view, always. |
| The URL | The diagram's hash, same keys and order: `#method=…;net=…;reach=…;name=…;scenario=…`. `reach/name/scenario` = the selection; `method/net` = the column of the view you came from, marked ◧ (click a column header to move it). They never hide columns. | The ◧ link of a diagram view lands on the right matrix view and the matrix's ▦ goes back to it; the same link means the same thing on both pages. |
| Rows | The tests of the selected view: install (per setup), make reachable, the L3 flows (desktop / android). For `.onion` all its rows (the diagram's, the harness chutney row, the greyed Tor + https placeholders). Matrix-only reaches (harness `local`, greyed relays, future transports) stay selectable after the diagram's five. | Tests stay in the rows (the ask). Nothing is dropped. |
| L1 / L2 | Untouched by the selection: their own tables, the test-vm's own rows. | They are not views of the diagram. |
| Scenario in the data | Catalog `setup_map.scenarios` mirrors the toggle; `reaches[].scenarios` says which reaches tell the stories (Tailscale, Cloudflare, Direct IPv6). A run that recorded no `scenario` is a **first install** (req 159: every valid run is from scratch), so today's runs land under *First install*. | Honest: no run so far was a reinstall or a restore. |
| Reinstall / Restore cells | **○ not wired** with the reason: `dash` takes no `--scenario`, so such a run cannot be filed. Never a command that would silently file a reinstall under *first*. | Req 1–2: a printed command must work as written. |
| Alignment | `./dash setups --check` and the page banner also compare the Scenario toggle, the scenarios per reach, and every toggle's default with the catalog's first entry (the matrix's default selection). | Req 169 / 183: the alignment is checked, not assumed. |

## 2. Layout

```
REACH [Tailscale] Cloudflare  Direct IPv6  Port-forward  .onion  local https  ngrok …   NAME — n/a   SCENARIO [First install] Reinstall  Restore a backup   CLIENT [desktop][android]   ▦ setup diagram
                      LAN cable ▦              │  Wifi ▦            │  USB stick ▦            │ VM ▦
          ◧ cable→R │ cable+wifi→R │ wifi-only │ cable→R, wifi→Y │ cable→R │ wifi-only │ cable→R │ wifi-only │ cable→R, wifi→Y │ on this computer
            L  CI   │   L   CI     │  L   CI   │ …
install · time
▾ reach: Tailscale · https ▦ — --reach tailscale --net https · scenario: First install
make reachable · reach.tailscale
connect to server · desktop
…
```

## 3. Files

`app.js` (selection, hash, column mark, scenario, alignment, legend), `index.html` (comment), `style.css` (chips,
column mark), `catalog.json` (`setup_map.scenarios`, `scenario_arg`, `reaches[].scenarios`), `dash`
(`diagram_alignment`, `setups` listing), `requirements.md` reqs 185–187, `networks.md`, `test_matrix.md`, `README.md`.

## 4. Follow-up (not in this change — it changes documented commands)

Filing a Reinstall / Restore run: `--scenario` on `dash run / wrap / report`, required exactly when the diagram offers
scenarios for that Reach (the `--name` rule, req 171), recorded on the run and in `diagram_view`; set
`setup_map.scenario_arg` to `"--scenario"` so the matrix prints it in every cell command. Every documented L3 / reach
command of the Tailscale, Cloudflare and Direct IPv6 rows gains `--scenario first` (test_matrix.md, networks.md,
README, the installer's NEXT STEPS block, add-cloudflare.sh's printed lines).

## 5. Verification

`./dash setups --check` aligned; Playwright against `./dash serve` (the user's 3000 and the checks' 8099): the ask's
URL shows all ten setup columns with `cable-0a` marked, Reach / Name / Scenario chips with the right one on,
`reach=tailscale` → Name *— n/a* + three scenarios, Reinstall → ○ cells with the reason, `.onion` → four row groups,
a clicked cell unfolds its command and runs, "all runs" stacks them; no console errors; screenshots looked at.
