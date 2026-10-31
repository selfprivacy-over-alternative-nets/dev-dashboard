#!/usr/bin/env python3
"""gen_flow_svg.py — render each docs/diagrams/<id>.json to a static docs/diagrams/<id>.svg.

The interactive editor (flow.html) renders the JSON live; this produces a committed STATIC snapshot of
each diagram's DEFAULT toggle state (flow_requirements.md FR18/FR38) for the public Pages viewer / README
embeds, guarded by the same deterministic pre-commit hook + CI as the .puml diagrams. Pure stdlib,
deterministic. Mirrors flow.js render(): toggles(default) → showWhen filter → containment → icons → edge
kinds. Run via docs/render-diagrams.sh (loops docs/gen_*.py) or: python3 docs/gen_flow_svg.py
"""
import glob
import html
import json
import os
import re

DOCS = os.path.dirname(os.path.abspath(__file__))
DIAG = os.path.join(DOCS, "diagrams")
ICONS = os.path.join(DOCS, "icons.svg")

PALETTE = {  # must match flow.js PALETTE / requirements.md req 165
    "host": ("#13233a", "#58a6ff"), "cli": ("#1c1430", "#a371f7"), "web": ("#1a1d23", "#8b949e"),
    "target": ("#2a1d10", "#e3882d"), "created": ("#10231a", "#3fb950"),
    "input": ("#2a2410", "#d6a015"), "note": ("#14181f", "#6e7681"),
    "red": ("#2a1113", "#e5484d"), "orange": ("#2a1a0c", "#f97316"),   # FR108
    "green": ("#10231a", "#3fb950"),   # FR121: free & in your own hands (e.g. a free phonebook)
}
FG, DIM = "#c9d1d9", "#6e7681"
EDGE_ICON = {"cable": "ethernet", "lan": "ethernet", "wifi": "wifi", "usb": "usb", "tunnel": "relay", "tor": "tor"}


def shade(hex_, f):
    m = (hex_ or "#8b949e").lstrip("#")
    r, g, b = int(m[0:2], 16), int(m[2:4], 16), int(m[4:6], 16)
    c = lambda v: max(0, min(255, round(v * f)))
    return "#%02x%02x%02x" % (c(r), c(g), c(b))


def _dedupe(pts):
    o = []
    for p in pts:
        if not o or abs(o[-1][0] - p[0]) > 0.5 or abs(o[-1][1] - p[1]) > 0.5:
            o.append((p[0], p[1]))
    return o


EDGE_SNAP = 28   # within this perpendicular gap a near-aligned connector snaps to a straight line


def route_axis(a, b, e):   # True = horizontal main axis; e["_H"] forces it (FR93 through-routes)
    if isinstance(e.get("_H"), bool):
        return e["_H"]
    return abs(b[0] + b[2] / 2 - a[0] - a[2] / 2) >= abs(b[1] + b[3] / 2 - a[1] - a[3] / 2)


def side_of(p, R):
    return "w" if abs(p[0] - R[0]) < 0.5 else "e" if abs(p[0] - R[0] - R[2]) < 0.5 else "n" if abs(p[1] - R[1]) < 0.5 else "s"


GH = {}   # FR118: edge id → the crossing of a gated route through its gatehouse router (cleared per render) — mirrors flow.js GH


def gate_mode(e):   # FR118: a route that opens gates runs along the gate row, one that opens none (a tunnel) over them
    return "row" if isinstance(e.get("open"), list) and e["open"] else "lane"


def gate_geo(R):   # FR118: the gatehouse as fractions of the router body — mirrors flow.js gateGeo
    x, y, w, h = R
    return {"mL": x + 0.083 * w, "mR": x + 0.917 * w, "laneY": y + 0.159 * h, "rowY": y + 0.611 * h, "botY": y + 0.95 * h,
            "xs": (x + 0.30 * w, x + 0.694 * w), "ww": 0.278 * w, "wy0": y + 0.333 * h, "wy1": y + 0.889 * h}


def gate_cross(p, q, R, mode):   # FR118: p (entry) → the gate row or the lane → q (exit) — mirrors flow.js gateCross
    G = gate_geo(R)
    Y = G["laneY"] if mode == "lane" else G["rowY"]
    sp, sq = side_of(p, R), side_of(q, R)
    pref = lambda pt, sd: G["mL"] if sd == "w" else G["mR"] if sd == "e" else (G["mL"] if pt[0] < R[0] + R[2] / 2 else G["mR"])
    mq, mp = pref(q, sq), pref(p, sp)
    if mp == mq:   # the exit side chooses first
        mp = G["mR"] if mq == G["mL"] else G["mL"]

    def to_y(pt, sd, m):
        if sd in ("w", "e"):
            return [pt, (m, pt[1]), (m, Y)]
        if sd == "n":
            return [pt, (pt[0], Y)] if mode == "lane" else [pt, (pt[0], G["laneY"]), (m, G["laneY"]), (m, Y)]
        return [pt, (pt[0], G["botY"]), (m, G["botY"]), (m, Y)]
    return _dedupe(to_y(p, sp, mp) + list(reversed(to_y(q, sq, mq)))), mp, mq


def gate_wins(gh):   # FR118: the fire wall on the exit (internet) side, the port barrier on the server side — mirrors flow.js gateWins
    G = gate_geo(gh["R"])
    fire_x = G["xs"][1] if gh["mq"] > gh["mp"] else G["xs"][0]
    port_x = G["xs"][0] if fire_x == G["xs"][1] else G["xs"][1]
    win = lambda cx: {"x": cx - G["ww"] / 2, "y": G["wy0"], "w": G["ww"], "h": G["wy1"] - G["wy0"], "cx": cx, "cy": G["rowY"]}
    return win(fire_x), win(port_x), G


PB = {"W": 110, "H": 78, "T": 9, "U": 1.6}   # FR121: page size (book units) · one lookup (s) · the server's update before it (s)


def book_geom(n, b):   # FR119 / FR121: the CLOSED book, centred above its label (lines attach to it) — mirrors flow.js bookGeom
    lh = len([l for l in str(n.get("label", "")).split("\n") if l]) * 15
    h = max(30, b[3] - lh - (6 if lh else 0))
    s = min(h / (PB["H"] + 7), b[2] / (2 * (PB["W"] + 5)))
    w, bh = (PB["W"] + 5) * s, (PB["H"] + 7) * s
    return {"x": b[0] + (b[2] - w) / 2, "y": b[1] + (h - bh) / 2, "w": w, "h": bh, "s": s, "ty": b[1] + h + 16}


def book_lights(n, B, epoly, edges):   # FR121: the lines n.lights names, oriented far end → book (in) / book → far end (out) — mirrors flow.js bookLights
    L = n.get("lights") or {}
    by = {e["id"]: e for e in edges}

    def ride(eid, inward):
        e = by.get(eid) if eid else None
        p = epoly.get(eid) if e else None
        if not p or len(p) < 2 or n["id"] not in (e.get("from"), e.get("to")):   # gone, hidden, or not at this book
            return None
        return {"poly": list(p) if (e.get("to") == n["id"]) == inward else list(reversed(p)), "far": e["to"] if e.get("from") == n["id"] else e["from"]}
    ask, answer, update = ride(L.get("ask"), True), ride(L.get("answer"), False), ride(L.get("update"), True)
    d = 1   # 1 = spine left, opens to the left; -1 = spine right — the cover opens toward the line the question comes in on
    if ask:
        sd = side_of(ask["poly"][-1], (B["x"], B["y"], B["w"], B["h"]))
        d = -1 if sd == "e" else 1 if sd == "w" else (-1 if ask["poly"][0][0] > B["x"] + B["w"] / 2 else 1)
    return {"ask": ask, "answer": answer, "update": update, "dir": d}


def through_box(p, q, R, c=None):   # FR93: orthogonal p (on R's outline) → c (R's centre / its gate, FR100) → q — mirrors flow.js throughBox
    c = c or center(R)
    into = lambda z: (c[0], z[1]) if (abs(z[0] - R[0]) < 0.5 or abs(z[0] - R[0] - R[2]) < 0.5) else (z[0], c[1])
    return [p, into(p), c, into(q), q]


def longest_mid(poly):   # FR93: a through-route's label sits on its longest LEVEL stretch (FR118: never across an upright
    best = lvl = None    # pipe); with none level, on its longest stretch — beside the pipe when that one is upright (v)
    for i in range(1, len(poly)):
        (ax, ay), (bx, by) = poly[i - 1][:2], poly[i][:2]
        L = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
        m = (L, (ax + bx) / 2.0, (ay + by) / 2.0, abs(bx - ax) < 0.5)
        if best is None or L > best[0]:
            best = m
        if L and abs(by - ay) < 0.5 and (lvl is None or L > lvl[0]):
            lvl = m
    s = lvl or best
    return s[1:] if s else (poly[0][0], poly[0][1], False)


GATE_GAP = 20


def gate_r(e):   # FR102: the gate badge's radius (resizable) — mirrors flow.js gateR
    return e["gr"] if isinstance(e.get("gr"), (int, float)) else GATE_GAP


def gate_point(e, R):   # FR100: the open gate = the box's centre + (gx, gy), kept inside the box — mirrors flow.js gatePoint
    c = center(R)
    def cl(v, L):
        m = max(0, L / 2 - gate_r(e))
        return max(-m, min(m, v if isinstance(v, (int, float)) else 0))
    return (c[0] + cl(e.get("gx"), R[2]), c[1] + cl(e.get("gy"), R[3]))


def gate_split(poly, e, gate_box):   # FR93: the pipe is interrupted at the gate — mirrors flow.js gateSplit
    if not gate_box:
        return None
    c = gate_point(e, gate_box)
    k = next((i for i, p in enumerate(poly) if abs(p[0] - c[0]) < 0.5 and abs(p[1] - c[1]) < 0.5), -1)
    if k <= 0 or k >= len(poly) - 1:
        return None
    return c, trim_end(poly[:k + 1], "end", gate_r(e)), trim_end(poly[k:], "start", gate_r(e))


def zroute(a, b, e=None):   # orthogonal route anchored at side-MIDPOINTS (H/V, 90° only), snap-straight — mirrors flow.js zRouteSegs
    e = e or {}
    o = lambda k: e[k] if isinstance(e.get(k), (int, float)) else 0   # FR79 dragged offsets so/eo/mo/ss/es
    horiz = route_axis(a, b, e)
    U = (lambda q: q) if horiz else (lambda q: (q[1], q[0], q[3], q[2]))   # (u, v, wu, wv): u = main axis
    A, B = U(a), U(b)
    cau, cbu = A[0] + A[2] / 2, B[0] + B[2] / 2
    su = A[0] + A[2] if cbu >= cau else A[0]
    eu = B[0] if cbu >= cau else B[0] + B[2]
    sv, ev = A[1] + A[3] / 2 + o("so"), B[1] + B[3] / 2 + o("eo")
    if abs(sv - ev) <= EDGE_SNAP and o("so") == o("eo"):   # a set attachment (FR81) stays exact
        v = (sv + ev) / 2
        pts = [(su, v), (eu, v)]
    else:
        mu = (su + eu) / 2 + o("mo")
        dn = 1 if cbu >= cau else -1
        in_v = lambda q, v: q[1] <= v <= q[1] + q[3]
        within = lambda q, near: 0.5 < (mu - near) * dn < q[2] - 0.5   # elbow lands inside q's main-axis extent
        if within(B, eu) and in_v(B, ev) and not in_v(B, sv):   # FR102: end on the box's side it runs into — mirrors flow.js
            pts = [(su, sv), (mu, sv), (mu, B[1] if sv < B[1] else B[1] + B[3])]
        elif within(A, su - dn * A[2]) and in_v(A, sv) and not in_v(A, ev):
            pts = [(mu, A[1] if ev < A[1] else A[1] + A[3]), (mu, ev), (eu, ev)]
        else:
            pts = [(su, sv), (mu, sv), (mu, ev), (eu, ev)]

    def stub(q, v, off, far):   # v beyond the box's side → enter via its top/bottom (left/right) side instead
        if q[1] <= v <= q[1] + q[3]:   # returned points run from the box outward; the last one is (u, v)
            return None
        half = q[2] / 2
        if abs(off) <= half + 0.5:
            u = q[0] + half + max(-half, min(half, off))
            return [(u, q[1] if v < q[1] else q[1] + q[3]), (u, v)]
        u = q[0] + half + off   # FR92: dragged past the far edge → wrap round to that side (one more bend)
        side = q[0] + q[2] if off > 0 else q[0]
        ve = q[1] + q[3] / 2 + max(-q[3] / 2, min(q[3] / 2, far))
        return [(side, ve), (u, ve), (u, v)]
    s0 = stub(A, pts[0][1], o("ss"), o("sf"))
    if s0:
        pts = s0 + pts[1:]
    s1 = stub(B, pts[-1][1], o("es"), o("ef"))
    if s1:
        pts = pts[:-1] + s1[::-1]
    return [(u, v) if horiz else (v, u) for u, v in pts]


def arrow_head(poly, which, size, color, fb):   # hand-drawn triangle at the box edge — mirrors flow.js
    if not poly:
        return ""
    end = which == "end"
    tip = poly[-1] if end else poly[0]
    prev = (poly[-2] if end else poly[1]) if len(poly) >= 2 else None
    if prev:
        dx, dy = tip[0] - prev[0], tip[1] - prev[1]
    else:
        dx, dy = (fb[0], fb[1]) if end else (-fb[0], -fb[1])
    L = (dx * dx + dy * dy) ** 0.5 or 1.0
    dx, dy = dx / L, dy / L
    bx, by, px, py, half = tip[0] - dx * size, tip[1] - dy * size, -dy, dx, size * 0.55
    return (f'<polygon points="{tip[0]:.1f},{tip[1]:.1f} {bx + px * half:.1f},{by + py * half:.1f} '
            f'{bx - px * half:.1f},{by - py * half:.1f}" fill="{color}"/>')


# FR82: three block types told apart by SHAPE (mirrors flow.js NODE_TYPES). Untyped = plain box.
NODE_TYPES = {
    "action": {"label": "action — something you do", "rx": lambda b: min(b[3] / 2.0, 26), "sw": 2},
    "info": {"label": "information", "rx": lambda b: 8, "sw": 1.6, "dash": "2 4"},
    "device": {"label": "(hardware) device", "rx": lambda b: 2, "sw": 3.5},
}
DOG = 14
LEGEND_W = 360


def dog_ear_svg(b, stroke, bg):   # folded "document" corner, top-right of an info block — mirrors flow.js drawDogEar
    x, y = b[0] + b[2], b[1]
    return (f'<path d="M {x - DOG:g} {y:g} L {x:g} {y + DOG:g} L {x:g} {y:g} Z" fill="{bg}"/>'
            f'<path d="M {x - DOG:g} {y:g} L {x - DOG:g} {y + DOG:g} L {x:g} {y + DOG:g} Z" fill="{stroke}" fill-opacity="0.5" '
            f'stroke="{stroke}" stroke-width="1.2"/>')


EBADGE = 30   # FR89: size of the icon drawn on an arrow (mirrors flow.js)
HALO = ' paint-order="stroke" stroke="#0b0e14" stroke-width="3" stroke-linejoin="round"'


def icon_boxes():   # FR92: icon → (x, y, w, h) of its drawn glyph in the 24-grid (data-bbox in icons.svg)
    out = {}
    for m in re.finditer(r'<symbol id="ic-([a-z0-9-]+)" data-bbox="([^"]+)"', open(ICONS, encoding="utf-8").read()):
        out[m.group(1)] = tuple(float(v) for v in m.group(2).split())
    return out


ICON_BOX = icon_boxes()


def anchor_box(n, b, vis, vis_ids, state):   # FR92: lines attach to a pictogram's DRAWN icon (mirrors flow.js anchorBox)
    if n and b and n.get("nodeType") == "phonebook":   # FR119: the book
        B = book_geom(n, b)
        return (B["x"], B["y"], B["w"], B["h"])
    if not n or not b or not (n.get("nodeType") == "device" and n.get("icon") and not is_container(n, vis, vis_ids, state)):
        return b
    s_, ix, iy, _ = picto_geom(b, str(n.get("label", "")).split("\n"))
    bb = ICON_BOX.get(n["icon"], (0, 0, 24, 24))
    k = s_ / 24.0
    return (ix + bb[0] * k, iy + bb[1] * k, bb[2] * k, bb[3] * k)


def icon_svg(icon, x, y, s, color, images):   # FR114: a sprite, or "img:<key>" = a picture kept in meta.images — mirrors flow.js drawIcon
    if str(icon).startswith("img:") and images.get(icon[4:]):
        return f'<image href="{html.escape(images[icon[4:]], quote=True)}" x="{x:.1f}" y="{y:.1f}" width="{s:.1f}" height="{s:.1f}" preserveAspectRatio="xMidYMid meet"/>'
    return f'<use href="#ic-{icon}" x="{x:.1f}" y="{y:.1f}" width="{s:.1f}" height="{s:.1f}" style="color:{color}"/>'


def picto_geom(b, lines):   # FR89: icon fills the box above the label lines (mirrors flow.js pictoGeom)
    lh = len([l for l in lines if l]) * 15
    gap = 6 if lh else 0
    s = max(16, min(b[2], b[3] - lh - gap))
    y = b[1] + (b[3] - s - lh - gap) / 2.0
    return s, b[0] + (b[2] - s) / 2.0, y, y + s + 16


# FR90: four line types = what a line MEANS, told apart by PATTERN (mirrors flow.js LINE_ROLES / roleOf).
LINE_ROLES = {
    "link": "link — physically connected",
    "tunnel": "tunnel — a route carrying traffic",
    "action": "action — you do this, to that",
    "info": "information going in / out",
}
MEDIUM = ("cable", "lan", "wifi", "usb")


def role_of(e):
    return e.get("role") or ("tunnel" if e.get("kind") == "pipe" else "link" if e.get("kind") in MEDIUM else None)


def line_width(role, kind):
    return 3 if role == "action" else 2 if role == "info" else (3 if kind in ("cable", "lan") else 2)


def line_dash(role, kind, lw):   # None = legacy look (wifi/tunnel/tor dashed)
    if role == "link":
        return "6 4" if kind == "wifi" else "none"
    if role == "action":
        return f"{lw * 3:g} {lw * 2:g}"
    if role == "info":
        return f"0.1 {lw * 2.6:g}"
    return None


def chevron(poly, which, size, color, lw, fb):   # FR90: an OPEN "V" head = an action — mirrors flow.js drawChevron
    if not poly:
        return ""
    end = which == "end"
    tip = poly[-1] if end else poly[0]
    prev = (poly[-2] if end else poly[1]) if len(poly) >= 2 else None
    dx, dy = ((tip[0] - prev[0], tip[1] - prev[1]) if prev else ((fb[0], fb[1]) if end else (-fb[0], -fb[1])))
    L = (dx * dx + dy * dy) ** 0.5 or 1.0
    dx, dy = dx / L, dy / L
    bx, by, px, py, half = tip[0] - dx * size, tip[1] - dy * size, -dy, dx, size * 0.6
    return (f'<polyline points="{bx + px * half:.1f},{by + py * half:.1f} {tip[0]:.1f},{tip[1]:.1f} {bx - px * half:.1f},{by - py * half:.1f}" '
            f'fill="none" stroke="{color}" stroke-width="{max(2, lw):g}" stroke-linecap="round" stroke-linejoin="round"/>')


# FR103: the COLOUR of an action / information line says what it costs you (mirrors flow.js COST)
COST = {
    "paid": ("#e5484d", "costs money"),
    "central": ("#f97316", "at a company you depend on (Cloudflare, Tailscale, DuckDNS…)"),
    "free": ("#eab308", "free & in your own hands (e.g. your router)"),
}


def line_color(e):   # an explicit colour still wins
    return e.get("color") or (COST[e["cost"]][0] if e.get("cost") in COST else None)


def legend_height(types, roles, costs=False):
    h = 6
    if types:
        h += 14 + 20 * len(NODE_TYPES)
    if roles:
        h += 14 + 20 * len(LINE_ROLES)
    if costs:
        h += 14 + 20 * len(COST)
    return h


def line_sample(role, x, y):   # the legend's 34x18 picture of each FR90 line type
    C, cy = "#8b949e", y + 9
    if role == "tunnel":
        return mario_pipe_svg([(x + 4, cy), (x + 30, cy)], C, 7)
    w = line_width(role, "plain")
    x2 = x + (32 if role == "link" else 31 if role == "action" else 24)
    dash = line_dash(role, "plain", w)
    attrs = (f' stroke-dasharray="{dash}"' if dash and dash != "none" else "") + (' stroke-linecap="round"' if role == "info" else "")
    out = f'<line x1="{x + 2:g}" y1="{cy:g}" x2="{x2:g}" y2="{cy:g}" stroke="{C}" stroke-width="{w:g}"{attrs}/>'
    if role == "link":
        out += f'<circle cx="{x + 17:g}" cy="{cy:g}" r="4" fill="#0b0e14" stroke="{C}" stroke-width="1.5"/>'
    if role == "action":
        out += chevron([(x + 2, cy), (x + 32, cy)], "end", 7, C, 2, (1, 0))
    if role == "info":
        out += arrow_head([(x + 2, cy), (x + 32, cy)], "end", 8, C, (1, 0))
    return out


def legend_svg(lx, ly, types, roles, costs=False):   # small key: box shapes (FR82) + line types (FR90); the live page draws the same overlay
    out = [f'<g><rect x="{lx:g}" y="{ly:g}" width="{LEGEND_W}" height="{legend_height(types, roles, costs)}" rx="6" fill="#14181f" fill-opacity="0.88" stroke="#30363d"/>']
    cy = ly + 6
    cap = lambda t, y: f'<text x="{lx + 9:g}" y="{y + 9:g}" font-size="9" letter-spacing="0.6" fill="#6e7681">{t}</text>'
    rows = []
    if types:
        out.append(cap("BOXES", cy)); cy += 14
        rows = list(NODE_TYPES.items())
    for i, (k, T) in enumerate(rows):
        bx, by = lx + 9, cy + i * 20
        b = (bx, by, 31, 15)
        r = min(T["rx"](b), 7.5)
        dash = f' stroke-dasharray="{T["dash"]}"' if T.get("dash") else ""
        if k == "device":   # FR89: devices are pictograms
            out.append(f'<use href="#ic-laptop" x="{bx + 6.5:g}" y="{by - 1.5:g}" width="18" height="18" style="color:#8b949e"/>'
                       f'<text x="{bx + 40:g}" y="{by + 11.5:g}" font-size="11" fill="{DIM}">{html.escape(T["label"])}</text>')
            continue
        out.append(f'<rect x="{bx:g}" y="{by:g}" width="31" height="15" rx="{r:g}" fill="#14181f" stroke="#8b949e" '
                   f'stroke-width="{min(T["sw"], 2.5):g}"{dash}/>')
        if k == "info":
            ex = bx + 31
            out.append(f'<path d="M {ex - 6:g} {by:g} L {ex - 6:g} {by + 6:g} L {ex:g} {by + 6:g} Z" fill="#8b949e"/>')
        out.append(f'<text x="{bx + 40:g}" y="{by + 11.5:g}" font-size="11" fill="{DIM}">{html.escape(T["label"])}</text>')
    cy += 20 * len(rows)
    if roles:
        out.append(cap("LINES", cy)); cy += 14
        for i, (k, label) in enumerate(LINE_ROLES.items()):
            by = cy + i * 20
            out.append(line_sample(k, lx + 9, by - 1.5))
            out.append(f'<text x="{lx + 49:g}" y="{by + 11.5:g}" font-size="11" fill="{DIM}">{html.escape(label)}</text>')
        cy += 20 * len(LINE_ROLES)
    if costs:   # FR103
        out.append(cap("LINE COLOUR — ACTIONS + INFO", cy)); cy += 14
        for i, (k, (col, label)) in enumerate(COST.items()):
            by = cy + i * 20
            out.append(f'<line x1="{lx + 11:g}" y1="{by + 7.5:g}" x2="{lx + 41:g}" y2="{by + 7.5:g}" stroke="{col}" stroke-width="3" stroke-dasharray="7 4"/>')
            out.append(f'<text x="{lx + 49:g}" y="{by + 11.5:g}" font-size="11" fill="{DIM}">{html.escape(label)}</text>')
    out.append("</g>")
    return "".join(out)


def trim_end(poly, which, length):   # shorten the last (or first) segment by length — mirrors flow.js trimEnd
    if not poly or len(poly) < 2:
        return poly
    p = [tuple(q) for q in poly]
    i, j = (len(p) - 1, len(p) - 2) if which == "end" else (0, 1)
    dx, dy = p[i][0] - p[j][0], p[i][1] - p[j][1]
    L = (dx * dx + dy * dy) ** 0.5
    if not L:
        return p
    t = min(length, L) / L
    p[i] = (p[i][0] - dx * t, p[i][1] - dy * t)
    return p


def mid_of_poly(poly):   # point at half the total polyline length (label/icon placement) — mirrors flow.js
    if not poly or len(poly) < 2:
        return poly[0] if poly else (0, 0)
    seg = [((poly[i][0] - poly[i - 1][0]) ** 2 + (poly[i][1] - poly[i - 1][1]) ** 2) ** 0.5 for i in range(1, len(poly))]
    half = sum(seg) / 2
    for i in range(1, len(poly)):
        if half <= seg[i - 1]:
            t = half / seg[i - 1] if seg[i - 1] else 0
            return (poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t)
        half -= seg[i - 1]
    return poly[-1]


def pipe_spot_box(spec, edges, box, state, anc=None, vbs=None):   # FR80/81 an edge end ON a pipe — mirrors flow.js onPipeBox
    pid, _, key = str(spec).partition(":")
    pe = next((x for x in edges if x["id"] == pid), None)
    if not pe or role_of(pe) != "tunnel" or pe.get("fromOn") or pe.get("toOn") or not shown(pe, state):
        return None
    a, b = (anc(pe["from"]), anc(pe["to"])) if anc else (box.get(pe["from"]), box.get(pe["to"]))   # FR92: as drawn
    if not a or not b:
        return None
    if key in ("gate", "firewall"):   # FR118: the arrow ends on that gate's window
        pipe_poly(a, b, pe, vbs(pe) if vbs else None)
        gh = GH.get(pe["id"]) if pe.get("gate") else None
        if not gh:
            return None
        fire, port, _ = gate_wins(gh)
        w = fire if key == "firewall" or not (gate_mode(pe) == "lane" or "port" in (pe.get("open") or [])) else port
        return (w["x"], w["y"], w["w"], w["h"])
    poly = _dedupe(pipe_poly(a, b, pe, vbs(pe) if vbs else None))
    m = re.match(r"^s(\d+)@([\d.]+)$", key)
    if m and int(m.group(1)) < len(poly) - 1:
        (ax, ay), (bx, by), t = poly[int(m.group(1))], poly[int(m.group(1)) + 1], float(m.group(2))
        p = (ax + (bx - ax) * t, ay + (by - ay) * t)
    else:
        an = [("c%d" % i, poly[i]) for i in range(1, len(poly) - 1)]
        an += [("m%d" % (i - 1), ((poly[i - 1][0] + poly[i][0]) / 2, (poly[i - 1][1] + poly[i][1]) / 2)) for i in range(1, len(poly))]
        p = next((q for k, q in an if k == key), None) or next((q for k, q in an if k[0] == "m"), None)
        if not p:
            return None
    r = (pe.get("pw") or 22) / 2 + 3
    return (p[0] - r, p[1] - r, 2 * r, 2 * r)


LEG_START, LEG_END = ("so", "ss", "sf"), ("eo", "es", "ef")


def leg_offsets(e, ids, i):   # FR95 — mirrors flow.js legO: the route's own start/end offsets shape the first/last leg;
    last = len(ids) - 2       # everything else (each leg's elbow, the via boxes' exit/entry points) is e.legs["from>to"]
    own = (LEG_START if i == 0 else ()) + (LEG_END if i == last else ())
    o = {k: v for k, v in ((e.get("legs") or {}).get(ids[i] + ">" + ids[i + 1]) or {}).items() if k not in own}
    o.update({k: e[k] for k in own if k in e})
    return o


def pipe_poly(a, b, e, vb=None):   # vb = (id, box) of each of e["via"] that is shown (FR93 through-route)
    return pipe_legs(a, b, e, vb)[0]


def pipe_legs(a, b, e, vb=None):   # (pts, [(from, to, first, last) per leg]) — NT2: legs let a link sleeve one stretch
    p = e.get("path")
    if isinstance(p, list) and len(p) >= 2:
        pts = [(q["x"], q["y"]) for q in p]
        return pts, [(e["from"], e["to"], 0, len(pts) - 1)]
    if not vb:
        pts = zroute(a, b, e)
        return pts, [(e["from"], e["to"], 0, len(pts) - 1)]
    boxes = [a] + [x[1] for x in vb] + [b]
    ids = [e["from"]] + [x[0] for x in vb] + [e["to"]]
    last = len(boxes) - 2
    pts, legs = [], []
    for i in range(last + 1):
        o = leg_offsets(e, ids, i)
        oo = o
        leg = zroute(boxes[i], boxes[i + 1], o)
        if i > 0 and side_of(pts[-1], boxes[i]) == side_of(leg[0], boxes[i]):   # dead end → leave on the other axis
            oo = dict(o, _H=not route_axis(boxes[i], boxes[i + 1], o))
            leg = zroute(boxes[i], boxes[i + 1], oo)
        if i > 0 and ids[i] == e.get("gate") and route_axis(boxes[i], boxes[i + 1], oo) and "so" not in o:
            G = gate_geo(boxes[i])   # FR118: leave the gatehouse level with its row / lane (unless dragged)
            Y = G["laneY"] if gate_mode(e) == "lane" else G["rowY"]
            leg = zroute(boxes[i], boxes[i + 1], dict(oo, _H=True, so=Y - (boxes[i][1] + boxes[i][3] / 2)))
        if i == 0:
            s0, pts = 0, leg
        else:
            if ids[i] == e.get("gate"):   # FR118: through the gatehouse — along the gate row, or over the gates in the lane
                cross, mp, mq = gate_cross(pts[-1], leg[0], boxes[i], gate_mode(e))
                GH[e["id"]] = {"R": boxes[i], "mode": gate_mode(e), "mp": mp, "mq": mq}
            else:
                cross = through_box(pts[-1], leg[0], boxes[i])
            s0 = len(pts) - 1 + len(cross) - 1
            pts = pts[:-1] + cross + leg[1:]
        legs.append((ids[i], ids[i + 1], s0, len(pts) - 1))
    return pts, legs


GH_T = 8   # FR118: one loop — your friend gets in through the gates you opened, then a request bounces off a shut fire wall


def _smil(tag, **a):
    a = {k.replace("_", "-") if k not in ("keyPoints", "keyTimes", "calcMode", "attributeName", "repeatCount") else k: v for k, v in a.items()}
    return f'<{tag} dur="{GH_T}s" repeatCount="indefinite" ' + " ".join(f'{k}="{v}"' for k, v in a.items()) + "/>"


def _poly_len(poly):
    return sum(((poly[i][0] - poly[i - 1][0]) ** 2 + (poly[i][1] - poly[i - 1][1]) ** 2) ** 0.5 for i in range(1, len(poly)))


def _poly_at(poly, dist):   # the point at a distance along a polyline — mirrors flow.js polyAt
    for i in range(1, len(poly)):
        L = ((poly[i][0] - poly[i - 1][0]) ** 2 + (poly[i][1] - poly[i - 1][1]) ** 2) ** 0.5
        if dist <= L or i == len(poly) - 1:
            t = max(0, min(1, dist / L)) if L else 0
            return (poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t)
        dist -= L
    return poly[-1]


def _dist_to(poly, pt):   # distance along the polyline to its point nearest pt — mirrors flow.js distTo (projPoly)
    best = None
    for i in range(1, len(poly)):
        (ax, ay), (bx, by) = poly[i - 1], poly[i]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = max(0, min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / L2)) if L2 else 0
        d = ((pt[0] - ax - dx * t) ** 2 + (pt[1] - ay - dy * t) ** 2) ** 0.5
        if best is None or d < best[0]:
            best = (d, i - 1, t)
    _, k, t = best
    return _poly_len(poly[:k + 1]) + t * _poly_len(poly[k:k + 2])


def gatehouse_under_svg(lst, R_w):   # FR118: dark windows (+ for tunnels the faint unused front door) under the pipes — mirrors gatehouseUnder
    e = lst[0][0]
    gh = GH[e["id"]]
    fire, port, G = gate_wins(gh)
    sw = max(1.5, gh["R"][2] * 0.008)
    ports = any(gate_mode(x) == "lane" or "port" in (x.get("open") or []) for x, _ in lst)
    o = [f'<rect x="{w["x"]:.1f}" y="{w["y"]:.1f}" width="{w["w"]:.1f}" height="{w["h"]:.1f}" rx="{w["w"] * 0.1:.1f}" fill="#0b0e14" stroke="#6e7681" stroke-width="{sw:g}"/>'
         for w in ([fire, port] if ports else [fire])]
    if all(gate_mode(x) == "lane" for x, _ in lst):
        o.append(f'<line x1="{gh["mp"]:.1f}" y1="{G["rowY"]:.1f}" x2="{gh["mq"]:.1f}" y2="{G["rowY"]:.1f}" stroke="#3a414b" stroke-width="{max(3, (e.get("pw") or 22) * 0.25):g}"/>')
    fs = max(9, min(15, gh["R"][2] * 0.042))
    lbl = lambda w, t: f'<text x="{w["cx"]:.1f}" y="{w["y"] - fs * 0.6:.1f}" text-anchor="middle" font-size="{fs:.1f}" fill="#c9d1d9">{t}</text>'
    o.append(lbl(fire, "🔥 fire wall"))
    if ports:
        o.append(lbl(port, "🚧 port 443"))
    else:
        for i, t in enumerate(("no", "receptionist")):
            o.append(f'<text x="{port["cx"]:.1f}" y="{G["rowY"] + (e.get("pw") or 22) / 2 + 6 + fs * (1 + i * 1.15):.1f}" text-anchor="middle" font-size="{fs * 0.9:.1f}" fill="#8b949e">{t}</text>')
    return "".join(o)


def flame_svg(x, y, s, begin):   # FR118: a small flickering flame on the bricks — mirrors flow.js flame
    return (f'<g transform="translate({x:.1f} {y:.1f}) scale({s:.3f})"><g>'
            '<path d="M0 0 C-4 0 -5 -3 -4 -6 C-3 -8 -1 -9 0 -12 C1 -9 4 -8 4 -5 C5 -2 3 0 0 0 Z" fill="#f97316" stroke="#7c2d12" stroke-width="0.6"/>'
            '<path d="M0 0 C-2 0 -2.5 -2 -2 -3.5 C-1.5 -4.5 -0.5 -5 0 -7 C0.5 -5 2 -4.5 2 -3 C2.5 -1.5 1.5 0 0 0 Z" fill="#fde047"/>'
            f'<animateTransform attributeName="transform" type="scale" values="1 1;1.12 0.88;0.92 1.12;1 1" dur="0.8s" begin="{begin}s" repeatCount="indefinite"/>'
            '</g></g>')


def gatehouse_gates_svg(rid, lst):   # FR118: the fire wall + port barrier over the pipes, and the moving lights — mirrors gatehouseGates
    e, poly = lst[0]
    gh = GH[e["id"]]
    F, Pw, G = gate_wins(gh)
    ports = any(gate_mode(x) == "lane" or "port" in (x.get("open") or []) for x, _ in lst)
    row = gate_mode(e) == "row"
    o = [f'<g class="gatehouse"><style>@media (prefers-reduced-motion: reduce){{.gh-anim{{display:none}}}}</style><clipPath id="ghc-{rid}"><rect x="{F["x"] + 1:.1f}" y="{F["y"] + 1:.1f}" width="{F["w"] - 2:.1f}" height="{F["h"] - 2:.1f}"/></clipPath>',
         f'<g clip-path="url(#ghc-{rid})"><g>']
    wall_start = len(o) - 1
    bw, bh = F["w"] - 4, F["h"] - 4
    rh = bh / 6
    o.append(f'<rect x="{F["x"] + 2:.1f}" y="{F["y"] + 2:.1f}" width="{bw:.1f}" height="{bh:.1f}" fill="#8a3b2a" stroke="#0a140a" stroke-width="1.2"/>')
    for r in range(6):
        y = F["y"] + 2 + r * rh
        o.append(f'<line x1="{F["x"] + 2:.1f}" y1="{y:.1f}" x2="{F["x"] + 2 + bw:.1f}" y2="{y:.1f}" stroke="#5a2418" stroke-width="1.2"/>')
        for f in ((1 / 6, 1 / 2, 5 / 6) if r % 2 else (1 / 3, 2 / 3)):
            o.append(f'<line x1="{F["x"] + 2 + f * bw:.1f}" y1="{y:.1f}" x2="{F["x"] + 2 + f * bw:.1f}" y2="{y + rh:.1f}" stroke="#5a2418" stroke-width="1.2"/>')
    fsc = F["w"] / 36
    o += [flame_svg(F["x"] + F["w"] * 0.27, F["y"] + F["h"] * 0.25, fsc, 0), flame_svg(F["x"] + F["w"] * 0.73, F["y"] + F["h"] * 0.38, fsc, 0.3),
          flame_svg(F["x"] + F["w"] * 0.45, F["y"] + F["h"] * 0.9, fsc, 0.55)]
    if row:   # the fire wall slides down for your friend, then shuts again
        o.append(_smil("animateTransform", attributeName="transform", type="translate", values=f'0 0;0 0;0 {F["h"]:.1f};0 {F["h"]:.1f};0 0;0 0', keyTimes="0;0.1;0.15;0.33;0.38;1"))
    o.append("</g></g>")
    hx, hy = Pw["x"] + Pw["w"] * 0.125, G["rowY"]
    opens_port = "port" in (e.get("open") or [])
    if ports:
        o.append(f'<rect x="{Pw["x"] + Pw["w"] * 0.03:.1f}" y="{hy + Pw["w"] * 0.15:.1f}" width="{Pw["w"] * 0.17:.1f}" height="{max(4, Pw["y"] + Pw["h"] - 2 - (hy + Pw["w"] * 0.15)):.1f}" rx="2" fill="#c9d1d9"/>')
        o.append("<g>" + f'<rect x="{Pw["x"] + Pw["w"] * 0.075:.1f}" y="{hy - Pw["w"] * 0.1:.1f}" width="{Pw["w"] * 0.85:.1f}" height="{Pw["w"] * 0.2:.1f}" rx="{Pw["w"] * 0.07:.1f}" fill="#a3c55a" stroke="#0a140a" stroke-width="1"/>'
                 + "".join(f'<rect x="{Pw["x"] + Pw["w"] * f:.1f}" y="{hy - Pw["w"] * 0.1:.1f}" width="{Pw["w"] * 0.1:.1f}" height="{Pw["w"] * 0.2:.1f}" fill="#0b0e14"/>' for f in (0.32, 0.55, 0.78))
                 + (_smil("animateTransform", attributeName="transform", type="rotate", values=";".join(f"{v} {hx:.1f} {hy:.1f}" for v in (0, 0, -80, -80, 0, 0)), keyTimes="0;0.21;0.26;0.38;0.43;1") if row and opens_port else "")
                 + "</g>")
        o.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="{Pw["w"] * 0.075:.1f}" fill="#0b0e14"/>')
    pw = e.get("pw") or 22
    R1, R2 = pw * 0.45, pw * 0.22
    d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in poly)
    L = _poly_len(poly) or 1
    f3 = lambda v: f"{max(0, min(1, v)):.4f}"
    light = lambda anims: (f'<g class="gh-anim" pointer-events="none"><circle r="{R1:.1f}" fill="#ffffff" opacity="0.3">{anims[0]}</circle>'
                           f'<circle r="{R2:.1f}" fill="#ffffff">{anims[0]}</circle>' + "".join(anims[1:]) + "</g>")
    red = lambda t: _smil("animate", attributeName="fill", values="#ffffff;#ffffff;#ff5c5c;#ff5c5c", keyTimes=f"0;{t};{t + 0.02:.2f};1")
    def cross(pt, t0):
        return (f'<text x="{pt[0]:.1f}" y="{pt[1] - R1 * 1.6:.1f}" text-anchor="middle" font-size="{max(14, R1 * 2.2):.1f}" fill="#ff5c5c" opacity="0" pointer-events="none">✕'
                + _smil("animate", attributeName="opacity", values="0;0;1;1;0;0", keyTimes=f"0;{t0};{t0 + 0.02:.2f};{t0 + 0.12:.2f};{t0 + 0.16:.2f};1") + "</text>")
    gap = G["ww"] / 2 + R1 + 2
    if row:   # your friend's request comes in from the far (internet) end
        dF, dP = _dist_to(poly, (F["cx"], F["cy"])), _dist_to(poly, (Pw["cx"], Pw["cy"]))
        fF, fP = f3((dF + gap) / L), f3((dP + gap) / L)
        mv = (_smil("animateMotion", path=d, keyPoints=f"1;{fF};{fF};{fP};{fP};0;0", keyTimes="0;0.1;0.15;0.21;0.26;0.42;1", calcMode="linear") if opens_port
              else _smil("animateMotion", path=d, keyPoints=f"1;{fF};{fF};0;0", keyTimes="0;0.1;0.15;0.42;1", calcMode="linear"))
        o.append(light(["", mv, _smil("animate", attributeName="opacity", values="1;1;0;0", keyTimes="0;0.42;0.45;1")]))
        fB = f3((dF + gap + 60) / L)
        o.append(light([red(0.67), _smil("animateMotion", path=d, keyPoints=f"1;1;{fF};{fB};{fB}", keyTimes="0;0.55;0.68;0.75;1", calcMode="linear"),
                        _smil("animate", attributeName="opacity", values="0;0;1;1;0;0", keyTimes="0;0.54;0.56;0.72;0.78;1")]))
        o.append(cross(_poly_at(poly, dF + gap), 0.68))
    else:   # a tunnel: your server calls out over the gates, your friend comes back in on that line
        o.append(light(["", _smil("animateMotion", path=d, keyPoints="0;0;1;1;1;0;0", keyTimes="0;0.04;0.26;0.3;0.34;0.58;1", calcMode="linear"),
                        _smil("animate", attributeName="opacity", values="0;1;1;0;0;1;1;0;0", keyTimes="0;0.04;0.25;0.28;0.33;0.35;0.57;0.61;1")]))
        fr = [(gh["mq"], G["rowY"]), (gh["mp"], G["rowY"])]
        Lr = abs(gh["mq"] - gh["mp"]) or 1
        fS, fSb = f3((abs(gh["mq"] - F["cx"]) - gap) / Lr), f3((abs(gh["mq"] - F["cx"]) - gap - 40) / Lr)
        o.append(light([red(0.78), _smil("animateMotion", path=f"M {fr[0][0]:.1f} {fr[0][1]:.1f} L {fr[1][0]:.1f} {fr[1][1]:.1f}", keyPoints=f"0;0;{fS};{fSb};{fSb}", keyTimes="0;0.66;0.79;0.86;1", calcMode="linear"),
                        _smil("animate", attributeName="opacity", values="0;0;1;1;0;0", keyTimes="0;0.65;0.67;0.83;0.89;1")]))
        o.append(cross(_poly_at(fr, abs(gh["mq"] - F["cx"]) - gap), 0.79))
    o.append("</g>")
    return "".join(o)


def phonebook_svg(n, B, col, lt, under, over):   # FR121: the DNS book + one lookup loop — mirrors flow.js drawPhonebook
    W, H, D, s = PB["W"], PB["H"], lt["dir"], B["s"]
    DARK, PAGE, INK, BAR, EDGE, GRAY = "#0a140a", "#f6f1e3", "#1f2328", "#d6cfbd", "#b9b2a2", "#9aa3ad"
    INSIDE, BAND, CY, MONO = shade(col, 0.7), shade(col, 1.3), H / 2 - 3, "ui-monospace, monospace"
    F = lambda v: format(round(v, 4), "g")
    lines = str(n.get("entry", "")).split("\n")
    url = lines[0]
    host = re.sub(r"/$", "", re.sub(r"^https?://", "", url))
    m = re.search(r"\d{1,3}(\.\d{1,3}){3}", " ".join(lines[1:]))
    ip = m.group(0) if m else "?"
    off = PB["U"] if lt["update"] else 0
    T = PB["T"] + off
    k = lambda d: round((off + d * PB["T"]) / T, 4)   # demo fraction → this loop

    def keys(kv):
        v = ([(0, kv[0][1])] if off else []) + [(k(d), x) for d, x in kv]
        return ";".join(F(t) for t, _ in v), ";".join(x if isinstance(x, str) else F(x) for _, x in v)

    def anim(**a):
        tag = "animateMotion" if "path" in a else "animateTransform" if "type" in a else "animate"
        return f'<{tag} dur="{F(T)}s" repeatCount="indefinite" ' + " ".join(f'{q}="{v}"' for q, v in a.items()) + "/>"

    def fade(kv):
        kt, vs = keys(kv)
        return anim(attributeName="opacity", keyTimes=kt, values=vs)
    path_of = lambda pts: "M " + " L ".join(f"{F(x)} {F(y)}" for x, y in pts)

    def motion(pts, kv):
        kt, vs = keys(kv)
        return anim(path=path_of(pts), keyPoints=vs, keyTimes=kt, calcMode="linear")
    X = lambda x0, w: x0 if D == 1 else -(x0 + w)   # book units: the spine at x 0, the page top at y 0 (text never mirrors)
    hx, py = (B["x"] if D == 1 else B["x"] + B["w"]), B["y"] + 3 * s

    def R(x, y, w, h, **a):
        a = {q.replace("_", "-"): v for q, v in a.items()}
        return f'<rect x="{F(x)}" y="{F(y)}" width="{F(w)}" height="{F(h)}" ' + " ".join(f'{q}="{v}"' for q, v in a.items()) + "/>"

    def txt(x, y, t, inner="", **a):
        a = {q.replace("_", "-"): v for q, v in a.items()}
        return f'<text x="{F(x)}" y="{F(y)}" ' + " ".join(f'{q}="{v}"' for q, v in a.items()) + f">{html.escape(t)}{inner}</text>"

    def page(pl, letter=None):
        return R(pl, 0, W, H, fill=PAGE, stroke=EDGE, stroke_width=0.8) + (txt(pl + W / 2, 11, letter, text_anchor="middle", font_size=9, font_weight=700, fill="#9a917d") if letter else "")

    def rows(pl, ys):   # other people: name … number
        return "".join(R(pl + 7, y, 24 + (i * 11) % 22, 2.4, rx=1, fill=BAR) + R(pl + W - 33, y, 26, 2.4, rx=1, fill=BAR) for i, y in enumerate(ys))
    ROWS, pl0, plO = [19 + i * 8 for i in range(7)], X(0, W), X(-W, W)   # the closed side's page / the open side's

    def cover():
        c = [R(X(0, W), -3, W, H, rx=4, fill=col, stroke=DARK, stroke_width=1.5), R(X(0, 11), -3, 11, H, rx=4, fill=INSIDE, stroke=DARK, stroke_width=1.5)]
        c += [f'<line x1="{D * 2}" y1="{F(y)}" x2="{D * 9}" y2="{F(y)}" stroke="{BAND}" stroke-width="1.5"/>' for y in (7, H - 13)]
        c += [txt(D * (11 + (W - 11) / 2), y, t, text_anchor="middle", font_size=fs, font_weight=700, letter_spacing=1.5, fill="#ffffff") for t, fs, y in (("DNS", 15, CY - 1), ("PHONEBOOK", 10.5, CY + 13))]
        if n.get("childDiagram"):   # FR85
            c.append(txt(W - 6 if D == 1 else 6 - W, H - 9, "⊕ open", text_anchor="end" if D == 1 else "start", font_size=11, fill="rgba(255,255,255,0.8)", **{"class": "drill"}))
        return "".join(c)
    AT, HALF, C0, C1, C2 = (0.18, 0.25, 0.30, 0.35), (0.03, 0.022, 0.022, 0.022), 0.55, 0.58, 0.61   # turn i (0 = the cover) starts at AT[i]; shut C0 → C2

    def turn(i, side, face):   # a turn folds a closed-side face into the spine, then unfolds its open-side face
        a, h = AT[i], HALF[i]
        kv = ([(0, "0 1"), (a + h, "0 1"), (a + 2 * h, "1 1"), (C0, "1 1"), (C1, "0 1"), (1, "0 1")] if side == "open"
              else [(0, "1 1"), (a, "1 1"), (a + h, "0 1"), (C2, "0 1"), (C2 + 0.005, "1 1"), (1, "1 1")] if i
              else [(0, "1 1"), (a, "1 1"), (a + h, "0 1"), (C1, "0 1"), (C2, "1 1"), (1, "1 1")])
        kt, vs = keys(kv)
        rest = ' transform="scale(0 1)"' if side == "open" else ""   # an open-side face starts folded away
        return f'<g class="pb-anim"{rest}>' + face + anim(attributeName="transform", type="scale", keyTimes=kt, values=vs) + "</g>"
    o = ['<g class="phonebook"><style>.pb-still{display:none}@media (prefers-reduced-motion: reduce){.pb-anim{display:none}.pb-still{display:inline}}</style>',
         f'<g transform="translate({F(hx)} {F(py)}) scale({F(s)})">',
         R(X(0, W + 5), -3, W + 5, H + 7, rx=4, fill=INSIDE, stroke=DARK, stroke_width=1.5),   # the back cover
         page(pl0, "Y"), rows(pl0, [55, 62, 69])]   # the last page: your entry
    o.append(f'<rect x="{F(pl0 + 5)}" y="17" width="{W - 10}" height="31" rx="3" fill="#fde68a" opacity="0" class="pb-anim">'
             + fade([(0, 0), (0.40, 0), (0.42, 1), (C2, 1), (C2 + 0.01, 0), (1, 0)]) + "</rect>")
    fs = min(9, (W - 24) / (max(len(host), len(ip) + 3, 1) * 0.6))
    o.append(txt(pl0 + 19, 30, host, font_size=F(fs), fill=INK, font_family=MONO))
    o.append(txt(pl0 + 19, 42, "ip " + ip, font_size=F(fs), fill=INK, font_family=MONO, font_weight=700))
    kt, vs = keys([(0, 9), (0.39, 9), (0.42, 3.4), (1, 3.4)])
    o.append(f'<circle cx="{F(pl0 + 12)}" cy="27" r="9" fill="#ffffff" stroke="{INK}" stroke-width="1" opacity="0" class="pb-anim">'   # the white light, landed
             + fade([(0, 0), (0.39, 0), (0.40, 1), (C2, 1), (C2 + 0.01, 0), (1, 0)]) + anim(attributeName="r", keyTimes=kt, values=vs) + "</circle>")
    for i, l in ((3, "P"), (2, "H"), (1, "A")):
        o.append(turn(i, "closed", page(pl0, l) + rows(pl0, ROWS)))
    o.append(turn(0, "closed", cover()))
    o.append(turn(0, "open", R(X(-W - 5, W + 5), -3, W + 5, H + 7, rx=4, fill=INSIDE, stroke=DARK, stroke_width=1.5)))
    for i in (1, 2, 3):
        o.append(turn(i, "open", page(plO) + rows(plO, ROWS)))
    o.append('<g class="pb-still">' + cover() + "</g>")   # prefers-reduced-motion: a still, shut book
    if n.get("badge") == "snail":   # slow
        o.append(f'<g transform="translate({F(X(W - 39, 44))} -19)">'
                 f'<path d="M2 22 Q6 15 16 16 L34 16 Q39 16 38 22 Z" fill="#c9b38f" stroke="{DARK}" stroke-width="1.2"/>'
                 f'<circle cx="16" cy="11" r="9" fill="#b07a3c" stroke="{DARK}" stroke-width="1.2"/>'
                 f'<path d="M16 11 m-3 0 a3 3 0 1 1 3 3 a5.5 5.5 0 1 1 5.5 -5.5" fill="none" stroke="{DARK}" stroke-width="1.1"/>'
                 + "".join(f'<line x1="34" y1="16" x2="{x2}" y2="{y2}" stroke="#c9b38f" stroke-width="1.4"/><circle cx="{x2}" cy="{y2}" r="1.8" fill="#c9b38f"/>' for x2, y2 in ((37, 7), (41, 10)))
                 + "</g>")
    elif n.get("badge") == "bolt":   # fast
        bx0 = X(W - 22, 17)
        pts = " ".join(f"{F(bx0 + a)},{c - 19}" for a, c in ((9, 0), (0, 15), (7, 15), (3, 28), (16, 10), (9, 10), (13, 0)))
        o.append(f'<polygon points="{pts}" fill="#fde047" stroke="{DARK}" stroke-width="1.2"/>')
    # found: the white light's address matches an ip
    spans = "".join(f'<tspan fill="{c}">{html.escape(t)}</tspan>' for t, c in (("✓ ", "#3fb950"), (url, "#ffffff"), (" matches ", "#8b949e"), ("ip " + ip, GRAY)))
    o.append(txt(0, -24, "", spans + fade([(0, 0), (0.41, 0), (0.43, 1), (0.62, 1), (0.65, 0), (1, 0)]), text_anchor="middle", font_size=12, opacity=0, **{"class": "pb-anim"}))
    o.append("</g></g>")

    # the lights ride the lines (diagram units): under the book coming in, over everything going out
    def light(c, tag, g_anims, halo_r=9 * s, halo_a="", core_r=4.5 * s, core_a="", tag_a=""):
        return (f'<g class="pb-anim" opacity="0" pointer-events="none"><circle r="{F(halo_r)}" fill="{c}" opacity="0.3">{halo_a}</circle>'
                f'<circle r="{F(core_r)}" fill="{c}">{core_a}</circle>'
                f'<text x="0" y="{F(-14 * s)}" text-anchor="middle" font-size="{F(10 * s)}" fill="{c}" font-family="ui-sans-serif, system-ui, sans-serif">{html.escape(tag)}{tag_a}</text>'
                + g_anims + "</g>")

    def inside(pts):   # …and on under the closed book
        q, c = pts[-1], (B["x"] + B["w"] / 2, B["y"] + B["h"] / 2)
        L = ((c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2) ** 0.5 or 1
        t = min(1, 30 * s / L)
        return list(pts) + [(q[0] + (c[0] - q[0]) * t, q[1] + (c[1] - q[1]) * t)]
    if lt["update"]:   # your server updates its own entry: its ip comes in first
        f = lambda t: F(round(t / T, 4))
        under.append(light(GRAY, "ip " + ip, anim(path=path_of(inside(lt["update"]["poly"])), keyPoints="0;0;1;1", keyTimes=f"0;{f(0.1)};{f(PB['U'] - 0.3)};1", calcMode="linear")
                           + anim(attributeName="opacity", values="0;1;1;0;0", keyTimes=f"0;{f(0.15)};{f(PB['U'] - 0.35)};{f(PB['U'] - 0.15)};1")))
    if lt["ask"]:
        under.append(light("#ffffff", url, motion(inside(lt["ask"]["poly"]), [(0, 0), (0.15, 1), (1, 1)]) + fade([(0, 0), (0.02, 1), (0.15, 1), (0.17, 0), (1, 0)])))
    if lt["answer"]:   # the ip, packed into a gray light (its halo shrinks onto it), travels on to the far end
        st = (hx + (pl0 + 60) * s, py + 39 * s)
        hk, hv = keys([(0, 26 * s), (0.48, 26 * s), (0.53, 9 * s), (1, 9 * s)])
        ck, cv = keys([(0, 0), (0.49, 0), (0.53, 4.5 * s), (1, 4.5 * s)])
        over.append(light(GRAY, "ip " + ip, motion([st] + list(lt["answer"]["poly"]), [(0, 0), (C0, 0), (0.78, 1), (1, 1)]) + fade([(0, 0), (0.47, 0), (0.48, 1), (0.78, 1), (0.80, 0), (1, 0)]),
                          halo_r=26 * s, halo_a=anim(attributeName="r", keyTimes=hk, values=hv), core_a=anim(attributeName="r", keyTimes=ck, values=cv),
                          tag_a=fade([(0, 0), (0.635, 0), (0.655, 1), (1, 1)])))   # the tag shows once it is clear of the book
        if lt.get("glow"):
            gx, gy = lt["glow"]
            over.append(f'<circle cx="{F(gx)}" cy="{F(gy)}" r="{F(26 * s)}" fill="#fff3a0" opacity="0" class="pb-anim" pointer-events="none">'
                        + fade([(0, 0), (0.78, 0), (0.80, 0.55), (0.88, 0), (1, 0)]) + "</circle>")
    return "".join(o)


USB_T, USB_KT, USB_S = 6, "0;0.1;0.45;0.55;0.9;1", 1.8   # NT10 / NT12 — mirrors flow.js usbTrip


def usb_trip_svg(poly, a, b, R):   # R = moving stick radius (usbS × line width)   # NT10: the stick carries a light from the source box into the target box, then returns
    if not poly or len(poly) < 2:
        return ""
    f = lambda v: format(round(v, 4), "g") if abs(v) < 1e15 else str(v)
    ca, cb = center(a), center(b)
    seg = lambda p: sum(((p[i][0] - p[i - 1][0]) ** 2 + (p[i][1] - p[i - 1][1]) ** 2) ** 0.5 for i in range(1, len(p)))
    d = lambda p: "M " + " L ".join(f"{f(x)} {f(y)}" for x, y in p)
    L0 = ((poly[0][0] - ca[0]) ** 2 + (poly[0][1] - ca[1]) ** 2) ** 0.5
    Lp = seg(poly)
    Lt = (L0 + Lp + ((cb[0] - poly[-1][0]) ** 2 + (cb[1] - poly[-1][1]) ** 2) ** 0.5) or 1
    mo = lambda path, kp: (f'<animateMotion dur="{USB_T}s" repeatCount="indefinite" path="{path}" keyPoints="{kp}" '
                           f'keyTimes="{USB_KT}" calcMode="linear"/>')
    return ('<g class="usb-trip" pointer-events="none"><style>@media (prefers-reduced-motion: reduce){.usb-trip{display:none}}</style>'
            f'<g><circle r="{f(R)}" fill="#0b0e14" stroke="#c9d1d9" stroke-width="1.5"/>'
            f'<use href="#ic-usb" x="{f(-0.82 * R)}" y="{f(-0.82 * R)}" width="{f(1.64 * R)}" height="{f(1.64 * R)}" style="color:#c9d1d9"/>' + mo(d(poly), "0;0;1;1;0;0") + "</g>"
            f'<g><circle r="{f(0.82 * R)}" fill="#fff3a0" opacity="0.35"/><circle r="{f(0.36 * R)}" fill="#fffbe0"/>'
            + mo(d([ca] + list(poly) + [cb]), f"0;{f(L0 / Lt)};{f((L0 + Lp) / Lt)};1;1;1")
            + f'<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.55;1" dur="{USB_T}s" repeatCount="indefinite"/></g></g>')


CBL = {"headL": 1.26, "headW": 1.52, "straightL": 1.7, "ribsL": 2.43, "neckL": 3.39, "step": 0.1,
       "DARK": "#1f2328", "HEAD": "#e9edf1", "LATCH": "#d3dae1", "GOLD": "#c9a43a"}   # NT13 — mirrors flow.js CBL


def cable_svg(poly, color, c):   # NT13: the LAN-cable sleeve (flat cable + moulded boot + RJ45 head + latch) — mirrors flow.js drawCable
    K = CBL
    j0 = trim_poly(poly, "start", K["neckL"] * c - 1)
    jacket = j0 and trim_poly(j0, "end", K["neckL"] * c - 1)
    pts = _dedupe(jacket or poly)
    d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts)
    o = [f'<path d="{d}" fill="none" stroke="{K["DARK"]}" stroke-width="{2 * c + 3:g}" stroke-linejoin="miter"/>',
         f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{2 * c:g}" stroke-linejoin="miter"/>']
    if not jacket:
        return "".join(o)

    def end(P, Q):
        L = ((P[0] - Q[0]) ** 2 + (P[1] - Q[1]) ** 2) ** 0.5 or 1
        return P, ((P[0] - Q[0]) / L, (P[1] - Q[1]) / L)
    for P, u in (end(poly[0], poly[1]), end(poly[-1], poly[-2])):
        f = lambda a, b: (P[0] - u[0] * a * c - u[1] * b * c, P[1] - u[1] * a * c + u[0] * b * c)
        pg = lambda q, attrs: '<polygon points="' + " ".join(f"{x:.1f},{y:.1f}" for x, y in q) + f'" {attrs}/>'

        def ln(a1, b1, a2, b2, s, w):
            (x1, y1), (x2, y2) = f(a1, b1), f(a2, b2)
            return f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{s}" stroke-width="{w:g}"/>'
        ola = f'stroke="{K["DARK"]}" stroke-width="1.4"'
        hw, rw, nw = K["headW"] - 0.04, K["headW"] - 0.1, 1 + K["step"]
        o.append(pg([f(K["headL"], -hw), f(K["straightL"], -hw), f(K["ribsL"], -rw), f(K["neckL"], -nw),
                     f(K["neckL"], nw), f(K["ribsL"], rw), f(K["straightL"], hw), f(K["headL"], hw)], f'fill="{color}" {ola}'))
        for k in range(6):
            a = K["straightL"] + 0.04 + k * (K["ribsL"] - K["straightL"] - 0.08) / 5
            h = K["headW"] - 0.09 - (a - K["straightL"]) / (K["ribsL"] - K["straightL"]) * 0.06
            o.append(ln(a, -h, a, h, K["DARK"], 0.07 * c))
        o.append(pg([f(0, -K["headW"]), f(K["headL"], -K["headW"]), f(K["headL"], K["headW"]), f(0, K["headW"])], f'fill="{K["HEAD"]}" {ola}'))
        for k in range(8):
            b = -1.13 + k * 0.323
            o.append(ln(0.07, b, 0.39, b, K["GOLD"], max(0.8, 0.08 * c)))
        o.append(pg([f(0.48, -0.39), f(0.48, 0.39), f(1.52, 0.5), f(1.61, 0.5), f(1.61, -0.5), f(1.52, -0.5)], f'fill="{K["LATCH"]}" stroke="{K["DARK"]}" stroke-width="1.5"'))
        o.append(ln(0.48, -0.39, 0.48, 0.39, K["DARK"], 2))
    return "".join(o)


NEST = {"nestA": 1, "nestB": 2, "nestW": 1.9, "nestOp": 0.4}   # NT1–NT5 — mirrors flow.js NEST


def nest_p(e, k, own=False):   # own = a LAN cable carrying no tunnel (NT14): solid by default — mirrors flow.js nestP
    return e[k] if isinstance(e.get(k), (int, float)) else (1 if k == "nestOp" and own else NEST[k])


def trim_poly(poly, which, length):   # cut length off one end across segments (None = nothing left) — mirrors flow.js trimPoly
    p = list(reversed(poly)) if which == "end" else list(poly)
    left = length
    if left < 0 and len(p) >= 2:   # NT8: negative = lengthen the end segment outward — mirrors flow.js
        L = ((p[0][0] - p[1][0]) ** 2 + (p[0][1] - p[1][1]) ** 2) ** 0.5 or 1
        p[0] = (p[0][0] + (p[0][0] - p[1][0]) / L * -left, p[0][1] + (p[0][1] - p[1][1]) / L * -left)
        return list(reversed(p)) if which == "end" else p
    while len(p) >= 2:
        L = ((p[1][0] - p[0][0]) ** 2 + (p[1][1] - p[0][1]) ** 2) ** 0.5
        if L > left:
            t = left / L
            p[0] = (p[0][0] + (p[1][0] - p[0][0]) * t, p[0][1] + (p[1][1] - p[0][1]) * t)
            break
        left -= L
        p = p[1:]
    if len(p) < 2:
        return None
    return list(reversed(p)) if which == "end" else p


def mario_pipe_svg(poly, color, body_w=None, casing=False):
    # body_w (edge.pw, default 22) = pipe width; casing = translucent wide outer tube so the two thin inner
    # pipes drawn on the same lane stay visible — "two tunnels within one tunnel" (FR59). Mirrors flow.js.
    pts = _dedupe(poly)
    if len(pts) < 2:
        return ""
    W = body_w or 22
    dark, light, OL = shade(color, 0.5), shade(color, 1.55), "#0a140a"
    off, sw, rimH, rimOL, rimC, rimL = W * 0.3, max(3, W * 0.18), W * 0.86, W * 0.82, W * 0.59, max(2, W * 0.14)
    bop = ' stroke-opacity="0.35"' if casing else ""
    sop = ' stroke-opacity="0.5"' if casing else ""
    d = "M " + " L ".join(f"{p[0]:.1f} {p[1]:.1f}" for p in pts)
    out = [f'<path d="{d}" fill="none" stroke="{OL}" stroke-width="{W + 6}" stroke-linejoin="round"/>',
           f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{W}" stroke-linejoin="round"{bop}/>']
    ln = lambda x1, y1, x2, y2, s, w, op="": f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{s}" stroke-width="{w}"{op}/>'
    for i in range(1, len(pts)):
        A, B = pts[i - 1], pts[i]
        if abs(A[1] - B[1]) < 0.5:
            out.append(ln(A[0], A[1] - off, B[0], B[1] - off, light, sw, sop)); out.append(ln(A[0], A[1] + off, B[0], B[1] + off, dark, sw, sop))
        else:
            out.append(ln(A[0] - off, A[1], B[0] - off, B[1], light, sw, sop)); out.append(ln(A[0] + off, A[1], B[0] + off, B[1], dark, sw, sop))
    def rim(p, q):
        dx, dy = p[0] - q[0], p[1] - q[1]
        L = (dx * dx + dy * dy) ** 0.5 or 1.0
        px, py = -dy / L * rimH, dx / L * rimH
        return (ln(p[0] - px, p[1] - py, p[0] + px, p[1] + py, OL, rimOL)
                + ln(p[0] - px * 0.9, p[1] - py * 0.9, p[0] + px * 0.9, p[1] + py * 0.9, color, rimC)
                + ln(p[0] - px * 0.9, p[1] - py * 0.9, p[0] + px * 0.9, p[1] + py * 0.9, light, rimL))
    out.append(rim(pts[0], pts[1])); out.append(rim(pts[-1], pts[-2]))
    return "".join(out)


def ground_svg(gy, x0, x1):
    mortar, H = "#5c2f0d", 90
    out = [f'<rect x="{x0}" y="{gy}" width="{x1 - x0}" height="{H}" fill="#9a5523"/>',
           f'<rect x="{x0}" y="{gy}" width="{x1 - x0}" height="5" fill="{mortar}"/>',
           f'<line x1="{x0}" y1="{gy + 44}" x2="{x1}" y2="{gy + 44}" stroke="{mortar}" stroke-width="3"/>']
    bx = x0
    while bx < x1:
        out.append(f'<line x1="{bx:.0f}" y1="{gy}" x2="{bx:.0f}" y2="{gy + 44}" stroke="{mortar}" stroke-width="3"/>'); bx += 56
    bx = x0 + 28
    while bx < x1:
        out.append(f'<line x1="{bx:.0f}" y1="{gy + 44}" x2="{bx:.0f}" y2="{gy + H}" stroke="{mortar}" stroke-width="3"/>'); bx += 56
    return "".join(out)


def icon_defs():
    try:
        with open(ICONS) as f:
            txt = f.read()
        return "".join(re.findall(r"<symbol[\s\S]*?</symbol>", txt))
    except Exception:
        return ""


# ---- toggle default state (mirrors flow.js normalizeToggles) ----
def active_options(t, state):
    opts = t.get("options", [])
    for dep, mp in (t.get("optionsWhen") or {}).items():
        allowed = mp.get(state.get(dep), [])
        opts = [o for o in opts if o["value"] in allowed]
    return opts


def default_state(toggles):
    state = {t["id"]: t.get("default") for t in toggles}
    for _ in range(2):
        for t in toggles:
            vals = [o["value"] for o in active_options(t, state)]
            if not vals:
                state[t["id"]] = None
            elif state.get(t["id"]) not in vals:
                state[t["id"]] = t.get("default") if t.get("default") in vals else vals[0]
    return state


CANON = {}   # FR115: toggle id → {value: the first value of its sameLayout group}; set per diagram in render()


def shown(o, state):   # FR113: showWhen matches and the item isn't hidden in this exact view — mirrors flow.js visible
    key = ";".join(f"{k}={CANON.get(k, {}).get(v, v)}" for k, v in state.items() if v is not None)   # state is built in toggle order
    return when_ok(o.get("showWhen"), state) and key not in (o.get("hideIn") or [])


def when_ok(when, state):
    if not when:
        return True
    return all(state.get(k) in vals for k, vals in when.items())


def active_container(n, state):
    c = n.get("container")
    return c if (c and when_ok(n.get("containerWhen"), state)) else None


def side_mid(b, s):
    x, y, w, h = b
    return {"n": (x + w / 2.0, y), "s": (x + w / 2.0, y + h), "w": (x, y + h / 2.0)}.get(s, (x + w, y + h / 2.0))


def rbox(n, nodes_by_id, vis_ids, state, depth=0):
    x, y, w, h = n["x"], n["y"], n["w"], n["h"]
    c = active_container(n, state)
    if c and depth < 6 and c in nodes_by_id:
        p = nodes_by_id[c]
        if n.get("snapSide"):   # FR75: centre pinned on the parent's side-midpoint
            mx, my = side_mid(rbox(p, nodes_by_id, vis_ids, state, depth + 1), n["snapSide"])
            x, y = mx - w / 2.0, my - h / 2.0
        else:
            x = p["x"] + n.get("cdx", 16)
            y = p["y"] + n.get("cdy", 56)
    for k in nodes_by_id.values():   # edge-snapped children sit ON the border → don't grow for them
        if k["id"] in vis_ids and active_container(k, state) == n["id"] and not k.get("snapSide"):
            r = rbox(k, nodes_by_id, vis_ids, state, depth + 1)
            w = max(w, r[0] + r[2] + 14 - x)
            h = max(h, r[1] + r[3] + 14 - y)
    return (x, y, w, h)


def center(b):
    return (b[0] + b[2] / 2.0, b[1] + b[3] / 2.0)


def border(fr, to):
    ax, ay = center(fr)
    bx, by = center(to)
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ax, ay
    t = min(fr[2] / 2.0 / abs(dx or 1e-9), fr[3] / 2.0 / abs(dy or 1e-9))
    return ax + dx * t, ay + dy * t


def is_container(n, nodes, vis_ids, state):
    return any(k["id"] in vis_ids and active_container(k, state) == n["id"] for k in nodes)


def auto_see_through(n, nodes, edges, vis_ids, state):
    """FR76: a box holding a child that has drawn pipes/arrows turns translucent (derived, not saved)."""
    drawn = [e for e in edges if shown(e, state) and e["from"] in vis_ids and e["to"] in vis_ids]
    return any(k["id"] in vis_ids and active_container(k, state) == n["id"]
               and any(k["id"] in (e["from"], e["to"]) for e in drawn) for k in nodes)


def render(d):
    CANON.clear()
    for t in (d.get("meta") or {}).get("toggles") or []:   # FR115: values sharing one layout share their view key
        for g in t.get("sameLayout") or []:
            CANON.setdefault(t["id"], {}).update({v: g[0] for v in g})
    images = (d.get("meta") or {}).get("images") or {}   # FR114: uploaded pictures used as icons
    GH.clear()   # FR118: crossings are recomputed for this view
    toggles = (d.get("meta") or {}).get("toggles", [])
    state = default_state(toggles)
    nodes = d.get("nodes", [])
    edges = d.get("edges", [])
    by_id = {n["id"]: n for n in nodes}
    vis = [n for n in nodes if shown(n, state)]
    vis_ids = {n["id"] for n in vis}
    box = {n["id"]: rbox(n, by_id, vis_ids, state) for n in vis}

    pad = 30
    if box:
        xs = [b[0] for b in box.values()] + [b[0] + b[2] for b in box.values()]
        ys = [b[1] for b in box.values()] + [b[1] + b[3] for b in box.values()]
        x0, y0, x1, y1 = min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad
    else:
        x0, y0, x1, y1 = 0, 0, 400, 200
    used_types = [t for t in NODE_TYPES if any(n.get("nodeType") == t for n in nodes)]
    used_roles = any(role_of(e) for e in edges)
    used_costs = any(e.get("cost") in COST for e in edges)
    if used_types or used_roles or used_costs:
        y0 -= legend_height(used_types, used_roles, used_costs) + 8   # room for the key above the content (top-right)
    w, h = int(round(x1 - x0)), int(round(y1 - y0))

    o = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{int(round(x0))} {int(round(y0))} {w} {h}" '
        f'width="{w}" height="{h}" font-family="ui-sans-serif, system-ui, sans-serif">',
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{DIM}"/></marker>' + icon_defs() + "</defs>",
        f'<rect x="{int(round(x0))}" y="{int(round(y0))}" width="{w}" height="{h}" fill="{(d.get("meta") or {}).get("background") or "#0b0e14"}"/>',
    ]
    bg = (d.get("meta") or {}).get("background") or "#0b0e14"   # read now: `d` is reused as a path string below
    _gy = (d.get("meta") or {}).get("ground")
    if isinstance(_gy, (int, float)):
        o.append(ground_svg(_gy, int(round(x0)), int(round(x1))))

    front = []   # FR96: z "front" lines, drawn above the boxes (below the badges) — mirrors flow.js gFront
    epoly, pb_under, pb_over = {}, [], []   # FR121: lines the book lights ride · lights under the books · over everything
    anc = lambda nid: anchor_box(by_id.get(nid), box.get(nid), vis, vis_ids, state)   # FR92: a pictogram's drawn icon
    vbs = lambda ed: [(i, anchor_box(by_id[i], box[i], vis, vis_ids, state)) for i in (ed.get("via") or []) if i in box]   # FR93: (id, box)

    def nest_host(e):   # NT1–NT5: the tunnel stretch this link carries, oriented e.from → e.to — mirrors flow.js nestHost
        if e.get("nest") is False or role_of(e) != "link" or e.get("fromOn") or e.get("toOn"):
            return None
        for t in edges:
            if role_of(t) != "tunnel" or t.get("fromOn") or t.get("toOn") or not shown(t, state):
                continue
            ta, tb = anc(t["from"]), anc(t["to"])
            if not ta or not tb:
                continue
            pts, legs = pipe_legs(ta, tb, t, vbs(t))
            for f, to, i, j in legs:
                if (f, to) in ((e["from"], e["to"]), (e["to"], e["from"])):
                    seg = _dedupe(pts[i:j + 1])
                    return t, (seg if f == e["from"] else list(reversed(seg)))
        return None

    houses = {}   # FR118: gatehouse router id → [(route, poly)] — its body + windows go UNDER the pipes, its gates over them
    for e in edges:
        if role_of(e) != "tunnel" or not e.get("gate") or e.get("path") or not shown(e, state):
            continue
        ea = pipe_spot_box(e["fromOn"], edges, box, state, anc, vbs) if e.get("fromOn") else anc(e["from"])
        eb = pipe_spot_box(e["toOn"], edges, box, state, anc, vbs) if e.get("toOn") else anc(e["to"])
        if ea and eb:
            poly_ = _dedupe(pipe_poly(ea, eb, e, vbs(e)))
            if e["id"] in GH:
                houses.setdefault(e["gate"], []).append((e, poly_))
    for rid, lst in houses.items():
        n = by_id.get(rid)
        if n and rid in box and n.get("nodeType") == "device" and n.get("icon") and not is_container(n, vis, vis_ids, state):
            s_, ix, iy, _ = picto_geom(box[rid], str(n.get("label", "")).split("\n"))
            o.append(icon_svg(n["icon"], ix, iy, s_, PALETTE.get(n.get("color"), PALETTE["note"])[1], images))
            o.append(gatehouse_under_svg(lst, box[rid][2]))

    sleeves = []   # NT3: drawn after every tunnel, still under the boxes
    for e in edges:
        if not shown(e, state):
            continue
        mark = len(o)
        a = pipe_spot_box(e["fromOn"], edges, box, state, anc, vbs) if e.get("fromOn") else anc(e["from"])
        b = pipe_spot_box(e["toOn"], edges, box, state, anc, vbs) if e.get("toOn") else anc(e["to"])
        if not a or not b:
            continue
        kind = e.get("kind", "plain")
        role = role_of(e)
        tube = role == "tunnel"
        badge, aside = None, 0
        nh, nh_poly, nh_r = nest_host(e), None, 0
        own_ = not nh and kind in ("cable", "lan") and role == "link" and not e.get("fromOn") and not e.get("toOn") and e.get("nest") is not False   # NT14
        if nh or own_:
            nh_r = nest_p(e, "nestW") * ((nh[0].get("pw") or 22) if nh else 22) / 2
            s_ = trim_poly(nh[1] if nh else _dedupe(pipe_poly(a, b, e)), "start", nest_p(e, "nestA") * nh_r)
            nh_poly = s_ and trim_poly(s_, "end", nest_p(e, "nestB") * nh_r)
        if tube:
            poly = _dedupe(pipe_poly(a, b, e, vbs(e)))
            col = e.get("color") or "#8b949e"
            o.append(mario_pipe_svg(poly, col, e.get("pw"), e.get("casing")))   # FR118: whole — its gates are drawn over it
            mx, my, up = longest_mid(poly) if e.get("via") else (*poly[max(1, len(poly) // 2) - 1], False)
            if up:
                aside = (e.get("pw") or 22) / 2 + 6   # upright stretch: the label goes beside the pipe, not across it
        elif nh_poly:   # NT1–NT4: the link as a see-through sleeve around the tunnel it carries (mirrors flow.js)
            lan_ = kind in ("cable", "lan")
            col_ = line_color(e) or ("#7b828a" if lan_ else "#8b949e")
            body_ = cable_svg(nh_poly, col_, nh_r) if lan_ else mario_pipe_svg(nh_poly, col_, 2 * nh_r)   # NT13
            o.append(f'<g opacity="{nest_p(e, "nestOp", own_):g}">' + body_ + "</g>")
            mx, my = mid_of_poly(nh_poly)
            badge = EDGE_ICON.get(kind)
            if badge:
                o.append(f'<circle cx="{mx:.1f}" cy="{my:.1f}" r="{EBADGE / 2 + 5:g}" fill="#0b0e14" stroke="{line_color(e) or "#6e7681"}" stroke-width="2"/>'
                         f'<use href="#ic-{badge}" x="{mx - EBADGE / 2:.1f}" y="{my - EBADGE / 2:.1f}" width="{EBADGE}" height="{EBADGE}" style="color:#c9d1d9"/>')
        else:
            # arrows connect side-MIDPOINT → side-midpoint, straight or 90° only (mirrors flow.js)
            poly = _dedupe(pipe_poly(a, b, e))
            epoly[e["id"]] = poly
            lw = e.get("lw") if isinstance(e.get("lw"), (int, float)) else line_width(role, kind)
            _dir = "none" if role == "link" else e.get("dir", "to")   # FR90: a link has no direction
            ah = max(e.get("ah") if isinstance(e.get("ah"), (int, float)) else 12, lw * 2.5)   # head never thinner than the line
            cut = lw * 0.6 if role == "action" else ah * 0.8
            wp = poly   # line stops at the head's base (mirrors flow.js trimEnd)
            if _dir in ("to", "both"):
                wp = trim_end(wp, "end", cut)
            if _dir in ("from", "both"):
                wp = trim_end(wp, "start", cut)
            d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in wp)
            ld = line_dash(role, kind, lw)
            if ld is None:
                dash = ' stroke-dasharray="6 4"' if kind in ("wifi", "tunnel", "tor") else ""
            else:
                dash = (f' stroke-dasharray="{ld}"' if ld != "none" else "") + (' stroke-linecap="round"' if role == "info" else "")
            stroke = line_color(e) or DIM
            o.append(f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{lw}"{dash}/>')
            fb = (center(b)[0] - center(a)[0], center(b)[1] - center(a)[1])
            head = (lambda pl, w: chevron(pl, w, ah, stroke, lw, fb)) if role == "action" else (lambda pl, w: arrow_head(pl, w, ah, stroke, fb))
            if _dir in ("to", "both"):
                o.append(head(poly, "end"))
            if _dir in ("from", "both"):
                o.append(head(poly, "start"))
            mx, my = mid_of_poly(poly)
            badge = EDGE_ICON.get(kind) or ("doc" if role == "info" else None)   # FR90: info carries a document
            if badge:   # FR89: a large badge ON the line says what the arrow is (mirrors flow.js)
                o.append(f'<circle cx="{mx:.1f}" cy="{my:.1f}" r="{EBADGE / 2 + 5:g}" fill="#0b0e14" stroke="{line_color(e) or "#6e7681"}" stroke-width="2"/>'
                         f'<use href="#ic-{badge}" x="{mx - EBADGE / 2:.1f}" y="{my - EBADGE / 2:.1f}" width="{EBADGE}" height="{EBADGE}" style="color:#c9d1d9"/>')
            if kind == "usb":
                o.append(usb_trip_svg(poly, a, b, (e["usbS"] if isinstance(e.get("usbS"), (int, float)) else USB_S) * lw))   # NT10 / NT12
        if e.get("label"):
            dy = 18 if tube else (EBADGE / 2 + 12 if badge else 4)
            halo = HALO if badge else ""
            xy = f'x="{mx + aside:.1f}" y="{my + 4:.1f}" text-anchor="start"' if aside else f'x="{mx:.1f}" y="{my - dy:.1f}" text-anchor="middle"'
            o.append(f'<text {xy} font-size="11"{halo} fill="{FG if tube else DIM}">{html.escape(e["label"])}</text>')
        if e.get("z") == "front":
            front.extend(o[mark:])
            del o[mark:]
        elif nh_poly:
            sleeves.extend(o[mark:])
            del o[mark:]
    o.extend(sleeves)
    nodes_at = len(o)   # FR121: the lights coming into a book go here — over the lines, UNDER the books

    rank = lambda n: 2 if active_container(n, state) else (0 if is_container(n, vis, vis_ids, state) else 1)
    for n in sorted(vis, key=rank):
        fill, stroke = PALETTE.get(n.get("color"), PALETTE["note"])
        bx = box[n["id"]]
        see = n.get("seeThrough") or auto_see_through(n, vis, edges, vis_ids, state)
        op = ' fill-opacity="0.3"' if see else (' fill-opacity="0.55"' if is_container(n, vis, vis_ids, state) else "")
        T = NODE_TYPES.get(n.get("nodeType"))   # FR82: block shape = what the box IS
        r = T["rx"](bx) if T else 8
        cx = bx[0] + bx[2] / 2.0
        lines = str(n.get("label", "")).split("\n")
        if n.get("nodeType") == "phonebook":   # FR119 / FR121: drawn as the DNS book (⊕ open on its cover), its label below
            B = book_geom(n, bx)
            lt = book_lights(n, B, epoly, edges)
            far = lt["answer"] and lt["answer"]["far"]
            if far and far in box:   # where the answer lands
                fb = anc(far)
                lt["glow"] = (fb[0] + fb[2] / 2.0, fb[1] + fb[3] / 2.0)
            o.append(phonebook_svg(n, B, stroke, lt, pb_under, pb_over))
            for i, ln in enumerate(lines):
                o.append(f'<text x="{cx:.1f}" y="{B["ty"] + i * 15:.1f}" text-anchor="middle" font-size="12"{HALO} fill="{FG}">{html.escape(ln)}</text>')
            continue
        if n.get("nodeType") == "device" and n.get("icon") and not is_container(n, vis, vis_ids, state):
            # FR89: a device IS its icon (pictogram) — no box drawn; the box still sizes + anchors it
            s_, ix, iy, ty = picto_geom(bx, lines)
            if n["id"] not in houses:   # FR118: a gatehouse router was drawn under the pipes already
                o.append(icon_svg(n["icon"], ix, iy, s_, stroke, images))
            for i, ln in enumerate(lines):
                o.append(f'<text x="{cx:.1f}" y="{ty + i * 15:.1f}" text-anchor="middle" font-size="12"{HALO} fill="{FG}">{html.escape(ln)}</text>')
            if n.get("childDiagram"):
                o.append(f'<text x="{bx[0] + bx[2] - 8:.0f}" y="{bx[1] + 14:.0f}" text-anchor="end" font-size="11" fill="{DIM}">⊕ open</text>')
            continue
        sw = T["sw"] if T else 2
        dash = f' stroke-dasharray="{T["dash"]}"' if T and T.get("dash") else ""
        o.append(f'<rect x="{bx[0]:.0f}" y="{bx[1]:.0f}" width="{bx[2]:.0f}" height="{bx[3]:.0f}" rx="{r:g}" ry="{r:g}" '
                 f'fill="{fill}"{op} stroke="{stroke}" stroke-width="{sw}"{dash}/>')
        if n.get("nodeType") == "info":
            o.append(dog_ear_svg(bx, stroke, bg))
        if n.get("icon"):
            isz = 34 if n.get("nodeType") == "device" else 24   # FR89: a container device keeps its box, bigger icon
            o.append(icon_svg(n["icon"], cx - isz / 2, bx[1] + 6, isz, stroke, images))
            ty = bx[1] + isz + 18
        else:
            ty = bx[1] + bx[3] / 2.0 + 4
        start_y = ty if n.get("icon") else ty - (len(lines) - 1) * 8
        for i, ln in enumerate(lines):
            o.append(f'<text x="{cx:.1f}" y="{start_y + i * 15:.1f}" text-anchor="middle" font-size="12" fill="{FG}">{html.escape(ln)}</text>')
        if n.get("childDiagram"):
            o.append(f'<text x="{bx[0] + bx[2] - max(8, r * 0.7):.0f}" y="{bx[1] + 14:.0f}" text-anchor="end" font-size="11" fill="{DIM}">⊕ open</text>')
    for rid, lst in houses.items():   # FR118: the gates + moving lights, over the pipes (mirrors flow.js gatehouseGates)
        if rid in vis_ids:
            o.append(gatehouse_gates_svg(rid, lst))
    o.extend(front)   # FR102: "front" lines go above the gate badges too
    o[nodes_at:nodes_at] = pb_under   # FR121 (mirrors flow.js pbUnder / pbOver)
    o.extend(pb_over)
    if used_types or used_roles or used_costs:
        o.append(legend_svg(x1 - LEGEND_W - 8, y0 + 8, used_types, used_roles, used_costs))
    o.append("</svg>")
    return "\n".join(o) + "\n"


def main():
    if not os.path.isdir(DIAG):
        return
    for fn in sorted(glob.glob(os.path.join(DIAG, "*.json"))):
        base = os.path.basename(fn)[:-5]
        if base == "index":
            continue
        with open(fn) as f:
            d = json.load(f)
        with open(os.path.join(DIAG, base + ".svg"), "w") as f:
            f.write(render(d))
        print(f"  flow: {base}.json -> {base}.svg")


if __name__ == "__main__":
    main()
