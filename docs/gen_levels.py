#!/usr/bin/env python3
"""Generate docs/levels.svg — the test levels L1/L2/L3 stacked vertically, with each code repo drawn
as a bar SPANNING the levels that use it. A bar overlapping several level-blocks = that repo is shared
across those levels. The data is dash's DEFAULT_REPOS (what each level's clean-state/pin gate + state
key cover): L1=[api], L2=[tests,manager,api], L3=[app,manager,api].

Pure stdlib, no timestamps → byte-deterministic. Rendered by docs/render-diagrams.sh (local hook + CI).
"""
import os
from xml.sax.saxutils import escape

# ── data ─────────────────────────────────────────────────────────────────────
LEVELS = [  # top → bottom
    ("L1", "unit"),
    ("L2", "integration"),
    ("L3", "app usage"),
]
NEW, FORK = "#CDEBC5", "#F7E7A6"
REPOS = [  # (display, provenance, color, levels-used)
    ("selfprivacy-api",       "FORK", FORK, {"L1", "L2", "L3"}),
    ("Manager · Over-Tor",    "NEW",  NEW,  {"L2", "L3"}),
    ("selfprivacy-tor-tests", "NEW",  NEW,  {"L2"}),
    ("flutter-app  (app)",    "FORK", FORK, {"L3"}),
]

# ── geometry ─────────────────────────────────────────────────────────────────
M = 20                      # outer margin
GUT = 120                   # left gutter for the level labels
COLW, GAP = 168, 18         # repo column width + gap
PAD = 12                    # bar inset within its column / band
BAND_TOP, BAND_H = 96, 104
N = len(REPOS)
X0 = M + GUT
COLS_W = N * COLW + (N - 1) * GAP
W = X0 + COLS_W + M
BANDS_BOTTOM = BAND_TOP + len(LEVELS) * BAND_H
H = BANDS_BOTTOM + 86
LVL_IDX = {name: i for i, (name, _) in enumerate(LEVELS)}
BAND_FILL = ["#F1F5FA", "#EFF6F0", "#FAF4EC"]


def band_y(i):
    return BAND_TOP + i * BAND_H


def t(x, y, s, size=12, anchor="start", weight="normal", fill="#222", italic=False):
    return (f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" '
            f'font-weight="{weight}" fill="{fill}"'
            f'{" font-style=\"italic\"" if italic else ""}>{escape(s)}</text>')


def rrect(x, y, w, h, r, fill, stroke="#555", sw=1.3):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'


out = []
out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'viewBox="0 0 {W} {H}" font-family="Helvetica,Arial,sans-serif">')
out.append(f'<rect width="{W}" height="{H}" fill="white"/>')

# title
out.append(t(M, 34, "Test levels × repos — which repos each level uses", 18, weight="bold"))
out.append(t(M, 54, "A bar spanning several level-blocks = that repo is shared across those levels "
                    "(dash DEFAULT_REPOS: the clean-state + pin gate and state key per level).",
             11.5, fill="#555"))

# bands (full-width "layer blocks"), with level labels in the left gutter
for i, (name, sub) in enumerate(LEVELS):
    y = band_y(i)
    out.append(f'<rect x="{M}" y="{y}" width="{W - 2*M}" height="{BAND_H}" rx="10" ry="10" '
               f'fill="{BAND_FILL[i]}" stroke="#D5DBE0" stroke-width="1"/>')
    out.append(t(M + 16, y + BAND_H / 2 - 4, name, 26, weight="bold", fill="#2b3a4a"))
    out.append(t(M + 16, y + BAND_H / 2 + 18, sub, 13, fill="#5a6b7a"))

# repo bars spanning their levels (drawn on top → they overlap the band blocks)
for c, (disp, prov, color, levels) in enumerate(REPOS):
    idxs = sorted(LVL_IDX[l] for l in levels)
    top = band_y(idxs[0]) + PAD
    bottom = band_y(idxs[-1]) + BAND_H - PAD
    cx = X0 + c * (COLW + GAP)
    bx, bw = cx + PAD, COLW - 2 * PAD
    out.append(rrect(bx, top, bw, bottom - top, 10, color))
    mid = bx + bw / 2
    out.append(t(mid, top + 24, disp, 12.5, anchor="middle", weight="bold", fill="#1f2d1f"))
    out.append(t(mid, top + 42, prov, 11, anchor="middle", fill="#3a4a3a"))
    # a faint ✓ per level the bar covers, so the span is explicit even in grayscale
    for i in idxs:
        out.append(t(mid, band_y(i) + BAND_H / 2 + 20, "used", 10, anchor="middle", fill="#48603f"))

# legend
ly = BANDS_BOTTOM + 34
out.append(t(M, ly, "Provenance:", 12, weight="bold"))
lx = M + 86
for label, color in (("NEW (this project)", NEW), ("FORK (upstream + our delta)", FORK)):
    out.append(rrect(lx, ly - 12, 16, 16, 4, color))
    out.append(t(lx + 22, ly + 1, label, 11.5, fill="#333"))
    lx += 34 + 7 * len(label) + 26
out.append(t(M, ly + 24, "Levels stack by cost/coverage: L1 (ms, no VM) → L2 (a backend VM) → "
                         "L3 (the app vs a backend). install uses [manager, api].", 11, fill="#666"))

out.append('</svg>')
svg = "\n".join(out) + "\n"

dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "levels.svg")
with open(dest, "w") as f:
    f.write(svg)
print(f"wrote {dest} ({len(svg)} bytes)")
