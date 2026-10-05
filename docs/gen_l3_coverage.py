#!/usr/bin/env python3
"""Generate docs/l3-coverage.svg — the L3 app-usage coverage grid: FRONTEND DEVICE (runs the app) ×
BACKEND MACHINE (runs SelfPrivacy). The two axes are orthogonal and easy to conflate, so this makes
the VM-vs-physical and desktop-vs-android combinations explicit, and marks which the harness exercises.

This is CAPABILITY (what the harness supports / what's roadmap), NOT live pass/fail — the live per-flow
× network results are in the matrix dashboard (its setup columns = the backend machine; the
.desktop/.android tests = the frontend device). Pure stdlib → byte-deterministic.
"""
import os
from xml.sax.saxutils import escape

# columns = backend machine (dash install_methods backend: vm vs native)
COLS = [("VirtualBox VM", "vm-local"), ("Physical box", "lan-setup-* / usb-*")]
# rows = frontend device (catalog client: desktop vs android)
ROWS = [("Ubuntu laptop", "Flutter desktop app  (.desktop)"),
        ("Android device / emulator", "Flutter app  (.android)")]
SUP, ROAD = "#CDEBC5", "#ECECEC"
# cell[(row,col)] = (status, tag, transports)
CELLS = {
    (0, 0): ("supported", "primary — exercised", "tor · https · chutney"),
    (0, 1): ("supported", "new — item 1a",        "tor · https"),
    (1, 0): ("roadmap",   "app runner TODO",      "tor · https · chutney"),
    (1, 1): ("roadmap",   "app runner TODO",      "tor · https"),
}
STATUS = {"supported": ("✓ supported", SUP), "roadmap": ("☐ roadmap", ROAD)}

M = 20
BANNER = 26                 # width/height of the axis banners
RH_X = M + BANNER + 6       # row-header x
RH_W = 184
CX0 = RH_X + RH_W + 8       # cells start x
COLW = 236
CELL_H = 104
GY = 132                    # grid top (below title + backend super-header + column headers)
W = CX0 + len(COLS) * COLW + M
GRID_BOTTOM = GY + len(ROWS) * CELL_H
H = GRID_BOTTOM + 96


def esc(s):
    return escape(str(s))


def text(x, y, s, size=12, anchor="start", weight="normal", fill="#222", italic=False, rot=None):
    tr = f' transform="rotate({rot} {x} {y})"' if rot is not None else ""
    st = ' font-style="italic"' if italic else ""
    return (f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" '
            f'font-weight="{weight}" fill="{fill}"{st}{tr}>{esc(s)}</text>')


def rect(x, y, w, h, fill, r=8, stroke="#888", sw=1.2):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'


o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
     f'font-family="Helvetica,Arial,sans-serif">', f'<rect width="{W}" height="{H}" fill="white"/>']

o.append(text(M, 30, "L3 app-usage coverage — frontend device × backend machine", 17, weight="bold"))
o.append(text(M, 50, "Which frontend+backend combinations the harness exercises. The app runs on a "
                     "frontend device and dials the backend over a transport.", 11.5, fill="#555"))

# backend super-header (spans the two columns) + column headers
cells_w = len(COLS) * COLW
o.append(rect(CX0, 64, cells_w, 22, "#FBF2EC", r=6, stroke="#E2CDBB"))
o.append(text(CX0 + cells_w / 2, 79, "BACKEND MACHINE — runs SelfPrivacy", 11.5, anchor="middle",
              weight="bold", fill="#7a5230"))
for c, (name, sub) in enumerate(COLS):
    cx = CX0 + c * COLW
    o.append(text(cx + COLW / 2, GY - 24, name, 13, anchor="middle", weight="bold"))
    o.append(text(cx + COLW / 2, GY - 8, sub, 11, anchor="middle", fill="#666", italic=True))

# frontend super-banner (rotated, spans the two rows)
o.append(rect(M, GY, BANNER, len(ROWS) * CELL_H, "#EEF3FB", r=6, stroke="#CBD8EC"))
o.append(text(M + BANNER / 2 + 4, GY + len(ROWS) * CELL_H / 2, "FRONTEND DEVICE — runs the app",
              11.5, anchor="middle", weight="bold", fill="#2b4a7a", rot=-90))

# row headers + cells
for r, (name, sub) in enumerate(ROWS):
    ry = GY + r * CELL_H
    o.append(rect(RH_X, ry + 6, RH_W, CELL_H - 12, "#F7F8FA", r=8, stroke="#DDE2E8"))
    o.append(text(RH_X + 14, ry + CELL_H / 2 - 4, name, 12.5, weight="bold", fill="#333"))
    o.append(text(RH_X + 14, ry + CELL_H / 2 + 16, sub, 10.5, fill="#667", italic=True))
    for c in range(len(COLS)):
        cx = CX0 + c * COLW
        status, tag, transports = CELLS[(r, c)]
        label, color = STATUS[status]
        o.append(rect(cx + 8, ry + 6, COLW - 16, CELL_H - 12, color, r=8))
        mx = cx + COLW / 2
        o.append(text(mx, ry + 34, label, 13.5, anchor="middle", weight="bold", fill="#1f2d1f"))
        o.append(text(mx, ry + 54, tag, 11, anchor="middle", fill="#3a4a3a"))
        o.append(text(mx, ry + 76, transports, 10.5, anchor="middle", fill="#48603f"))

# footnotes
fy = GRID_BOTTOM + 28
o.append(text(M, fy, "transports:  tor = .onion over SOCKS · https = clearnet (system/LE-trusted cert) "
                     "· chutney = private Tor net (vm-local only).", 11, fill="#555"))
o.append(text(M, fy + 20, "Live per-flow × network pass/fail is in the matrix dashboard — its setup "
                          "columns are the backend machine; .desktop/.android tests are the frontend.", 11, fill="#555"))
o.append(text(M, fy + 40, "L1/L2 are backend-only (a throwaway test-VM, no frontend); only L3 pairs a "
                          "frontend device with a persistent backend machine.", 11, fill="#777"))

o.append('</svg>')
svg = "\n".join(o) + "\n"
dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "l3-coverage.svg")
with open(dest, "w") as f:
    f.write(svg)
print(f"wrote {dest} ({len(svg)} bytes)")
