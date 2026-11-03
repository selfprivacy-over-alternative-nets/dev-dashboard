# dev-dashboard — notes for Claude

Two things live here:

1. **The test-matrix dashboard** — `index.html`, `matrix.html`, `data/`, the `./dash` tool. `./dash serve 8099` serves it
   (and the editor) on http://localhost:8099/. Its requirements: `requirements.md` (numbered reqs).
2. **The setup-map diagram editor** — `flow.html` + `flow.js`; `docs/gen_flow_svg.py` draws the same diagrams as static
   SVGs and must mirror every change made in `flow.js`. Diagrams: `docs/diagrams/*.json`. Requirements:
   `flow_requirements.md` (FR#, in the order they were asked; a later entry can change an earlier one — see their
   *Changed since* lines).

## The story steps (setup-map: Tailscale, and Direct IPv6 with DuckDNS or a bought domain)
They are written by scripts, run from this folder in this order:

```
python3 checks/fr124_steps_apply.py docs/diagrams/setup-map.json
python3 checks/fr139_scenarios_apply.py docs/diagrams/setup-map.json
python3 checks/fr141_ipv6_steps_apply.py docs/diagrams/setup-map.json
```

## Checks (`checks/`)
Run from this folder with `./dash serve 8099` running; they never press Save.
`parity_steps.py`, `ui_steps.py`, `ui_scenarios.py`, `parity_lines.py`, `parity_phonebook.py`, `overlap_scan.py`,
`smoke_all_views.py` (each `python3 checks/<name>.py`), plus `./dash setups --check`. Pictures: `checks/frames_view.py`,
`checks/shot.sh <out-dir> <name> '<state json>'`. The `fr*_apply.py` scripts are the one-off diagram edits of each FR.

## Rules
- After editing `docs/diagrams/*.json` directly, ask the user to reload the editor tab before they save — a stale tab
  overwrites the JSON.
- Keep `flow.js` and `docs/gen_flow_svg.py` in sync; run the checks and look at screenshots before saying it works.
- No secrets and no real domains in diagrams. This repo is **public**: never commit IP addresses, onion addresses,
  tokens, passwords or your domain — check with
  `python3 ../selfprivacy-context/tools/scan_sensitive.py --deny /home/a/selfprivacy-private/redaction-map.txt <files>`.
- Several Claude chats may work in this checkout at once; commit and push only when asked.

`prototypes/` holds the early design pages of the nested tunnels and the router gates. The work's wider context —
handovers, decisions, Claude's memory — is in the private repo `selfprivacy-context`, cloned next to this one.
