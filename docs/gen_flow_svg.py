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
IP_RE = re.compile(r"\d{1,3}(\.\d{1,3}){3}|[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}", re.I)   # FR122: an IPv4 or an IPv6 address


def entry_of(n, state):   # FR122: the entry text, per view (n.entryWhen = {toggle: {value: entry}}), else n.entry — mirrors flow.js entryOf
    for t, by_v in (n.get("entryWhen") or {}).items():
        if isinstance((by_v or {}).get(state.get(t)), str):
            return by_v[state[t]]
    return str(n.get("entry") or "")


def book_geom(n, b):   # FR119 / FR121: the CLOSED book, centred above its label (lines attach to it) — mirrors flow.js bookGeom
    lh = len([l for l in str(n.get("label", "")).split("\n") if l]) * 15
    h = max(30, b[3] - lh - (6 if lh else 0))
    s = min(h / (PB["H"] + 7), b[2] / (2 * (PB["W"] + 5)))
    w, bh = (PB["W"] + 5) * s, (PB["H"] + 7) * s
    return {"x": b[0] + (b[2] - w) / 2, "y": b[1] + (h - bh) / 2, "w": w, "h": bh, "s": s, "ty": b[1] + h + 16}


def book_lights(n, B, epoly, edges):   # FR121: the lines n.lights names, oriented far end → book (in) / book → far end (out) — mirrors flow.js bookLights
    L = n.get("lights") or {}
    by = {e["id"]: e for e in edges}

    def ride(ids, inward):   # FR122: one line id, or a CHAIN of them joined at shared boxes — mirrors flow.js
        lst = ids if isinstance(ids, list) else [ids] if ids else []
        if not lst:
            return None
        at, pts = n["id"], []
        for eid in (list(reversed(lst)) if inward else lst):   # walk outward from the book
            e = by.get(eid)
            p = epoly.get(eid) if e else None
            if not p or len(p) < 2 or at not in (e.get("from"), e.get("to")):   # gone, hidden, or not joined to the last one
                return None
            pts += list(p) if e.get("from") == at else list(reversed(p))
            at = e["to"] if e.get("from") == at else e["from"]
        return {"poly": list(reversed(pts)) if inward else pts, "far": at}
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


def icon_screens():   # FR127: icon → (x, y, w, h) of its screen in the 24-grid (data-screen in icons.svg) — mirrors flow.js ICON_SCREEN
    out = {}
    for m in re.finditer(r'<symbol id="ic-([a-z0-9-]+)"[^>]*? data-screen="([^"]+)"', open(ICONS, encoding="utf-8").read()):
        out[m.group(1)] = tuple(float(v) for v in m.group(2).split())
    return out


ICON_SCREEN = icon_screens()


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


def gatehouse_gates_svg(rid, lst, quiet=False, story=False):   # FR118: the fire wall + port barrier over the pipes, and the moving lights — mirrors gatehouseGates
    # FR126: quiet = nobody comes in in this step: no lights, the wall and the barrier stay shut and still
    # FR134: story = a step of the view's story: the server's call out over a tunnel isn't shown again — only your friend comes in
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
    if row and not quiet:   # the fire wall slides down for your friend, then shuts again
        o.append(_smil("animateTransform", attributeName="transform", type="translate", values=f'0 0;0 0;0 {F["h"]:.1f};0 {F["h"]:.1f};0 0;0 0', keyTimes="0;0.1;0.15;0.33;0.38;1"))
    o.append("</g></g>")
    hx, hy = Pw["x"] + Pw["w"] * 0.125, G["rowY"]
    opens_port = "port" in (e.get("open") or [])
    if ports:
        o.append(f'<rect x="{Pw["x"] + Pw["w"] * 0.03:.1f}" y="{hy + Pw["w"] * 0.15:.1f}" width="{Pw["w"] * 0.17:.1f}" height="{max(4, Pw["y"] + Pw["h"] - 2 - (hy + Pw["w"] * 0.15)):.1f}" rx="2" fill="#c9d1d9"/>')
        o.append("<g>" + f'<rect x="{Pw["x"] + Pw["w"] * 0.075:.1f}" y="{hy - Pw["w"] * 0.1:.1f}" width="{Pw["w"] * 0.85:.1f}" height="{Pw["w"] * 0.2:.1f}" rx="{Pw["w"] * 0.07:.1f}" fill="#a3c55a" stroke="#0a140a" stroke-width="1"/>'
                 + "".join(f'<rect x="{Pw["x"] + Pw["w"] * f:.1f}" y="{hy - Pw["w"] * 0.1:.1f}" width="{Pw["w"] * 0.1:.1f}" height="{Pw["w"] * 0.2:.1f}" fill="#0b0e14"/>' for f in (0.32, 0.55, 0.78))
                 + (_smil("animateTransform", attributeName="transform", type="rotate", values=";".join(f"{v} {hx:.1f} {hy:.1f}" for v in (0, 0, -80, -80, 0, 0)), keyTimes="0;0.21;0.26;0.38;0.43;1") if row and opens_port and not quiet else "")
                 + "</g>")
        o.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="{Pw["w"] * 0.075:.1f}" fill="#0b0e14"/>')
    if quiet:
        o.append("</g>")
        return "".join(o)
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
    elif not story:   # a tunnel: your server calls out over the gates, your friend comes back in on that line
        o.append(light(["", _smil("animateMotion", path=d, keyPoints="0;0;1;1;1;0;0", keyTimes="0;0.04;0.26;0.3;0.34;0.58;1", calcMode="linear"),
                        _smil("animate", attributeName="opacity", values="0;1;1;0;0;1;1;0;0", keyTimes="0;0.04;0.25;0.28;0.33;0.35;0.57;0.61;1")]))
    # (FR134 / FR136: in a story step neither — a runner (Jazz) takes your friend's way through the tunnel)
    if not row:   # …and a stranger at the front door
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
    lines = lt["entry"].split("\n")
    url = lines[0]
    host = re.sub(r"/$", "", re.sub(r"^https?://", "", url))
    m = IP_RE.search(" ".join(lines[1:]))
    ip = m.group(0) if m else "?"
    off = PB["U"] if lt["update"] else 0
    T = PB["T"] + off
    k = lambda d: round((off + d * PB["T"]) / T, 4)   # demo fraction → this loop

    def keys(kv):
        v = ([(0, kv[0][1])] if off else []) + [(k(d), x) for d, x in kv]
        return ";".join(F(t) for t, _ in v), ";".join(x if isinstance(x, str) else F(x) for _, x in v)

    wr = lt.get("write")   # FR129: written by a runner in this step — the book plays once, from then (no update light: the runner brings the entry)
    once = wr or lt.get("read")   # FR136: or read
    rc = f'repeatCount="1" fill="freeze" begin="{_f3(once["t"])}s"' if once else 'repeatCount="indefinite"'

    def anim(**a):
        if lt.get("still"):   # FR136: shut, nothing moves
            return ""
        tag = "animateMotion" if "path" in a else "animateTransform" if "type" in a else "animate"
        return f'<{tag} dur="{F(T)}s" {rc} ' + " ".join(f'{q}="{v}"' for q, v in a.items()) + "/>"

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
             + ((fade([(0, 0), (0.39, 0), (0.40, 1), (C2, 1), (C2 + 0.01, 0), (1, 0)]) + anim(attributeName="r", keyTimes=kt, values=vs)) if lt["ask"] else "")   # FR124: only when someone looks the name up
             + "</circle>")
    if wr:   # FR129: the entry is written while the book is open — a pencil goes along each line, a page-coloured cover slides off behind it — mirrors flow.js
        x0, w1, w2 = pl0 + 19, min(W - 24, len(host) * 0.6 * fs), min(W - 24, (len(ip) + 3) * 0.6 * fs)
        for y0, d0, d1 in ((19, 0.42, 0.48), (31, 0.48, 0.54)):
            kx, vx = keys([(0, _f3(pl0 + 15)), (d0, _f3(pl0 + 15)), (d1, _f3(pl0 + W - 5)), (1, _f3(pl0 + W - 5))])
            kw, vw = keys([(0, W - 20), (d0, W - 20), (d1, 0), (1, 0)])
            o.append(f'<rect x="{F(pl0 + 15)}" y="{y0}" width="{W - 20}" height="13" fill="{PAGE}" class="pb-anim">'
                     + anim(attributeName="x", keyTimes=kx, values=vx) + anim(attributeName="width", keyTimes=kw, values=vw) + "</rect>")
        kt, vs = keys([(0, f"{_f3(x0)} 28"), (0.42, f"{_f3(x0)} 28"), (0.48, f"{_f3(x0 + w1)} 28"), (0.485, f"{_f3(x0)} 40"), (0.54, f"{_f3(x0 + w2)} 40"), (1, f"{_f3(x0 + w2)} 40")])
        o.append(f'<g class="pb-anim" opacity="0"><path d="M 0 0 L 2 -5 L 11 -14 L 14 -11 L 5 -2 Z" fill="#facc15" stroke="{DARK}" stroke-width="0.8"/>'
                 f'<path d="M 11 -14 L 13 -16 L 16 -13 L 14 -11 Z" fill="#f472b6" stroke="{DARK}" stroke-width="0.8"/>'
                 + anim(attributeName="transform", type="translate", keyTimes=kt, values=vs)
                 + fade([(0, 0), (0.41, 0), (0.42, 1), (0.54, 1), (0.56, 0), (1, 0)]) + "</g>")
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
    # found: the white light's address matches an ip — or, with no lookup (FR124), the entry was written
    cap_t = ((("✓ ", "#3fb950"), (url, "#ffffff"), (" matches ", "#8b949e"), ("ip " + ip, GRAY)) if lt["ask"] or lt.get("read")
             else (("✎ ", "#f97316"), (url, "#ffffff"), (" → ", "#8b949e"), ("ip " + ip, GRAY), (" written", "#8b949e")))
    spans = "".join(f'<tspan fill="{c}">{html.escape(t)}</tspan>' for t, c in cap_t)
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


STEP_SET = None   # FR124: with a step active, the ids (boxes + lines) that step shows; None = the whole view — mirrors flow.js inStep


def shown(o, state):   # FR113: showWhen matches and the item isn't hidden in this exact view — mirrors flow.js visible
    key = ";".join(f"{k}={CANON.get(k, {}).get(v, v)}" for k, v in state.items() if v is not None)   # state is built in toggle order
    return when_ok(o.get("showWhen"), state) and key not in (o.get("hideIn") or []) and (STEP_SET is None or o.get("id") in STEP_SET)


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


# ---- FR124: step mode — a runner acts out a step (mirrors flow.js ACT / ACT_ITEMS / VAULT / actorPlan / drawActor) ----
ACT = {"V": 240, "FADE": 0.4, "HOP": 0.32, "MIN": 1.2, "MAX": 5, "STAND": 8, "WALK": 0.6, "SIZE": 26, "BLOW": 0.5,   # px/s · s — mirrors flow.js ACT
       "T": {"get": 0.9, "pop": 0.9, "hammer": 3, "give": 0.7, "scene": 0.4, "unscene": 0.3, "put": 0.8, "putIn": 0.7, "open": 0.6, "close": 0.5, "fire": 0.8, "take": 0.6, "unlock": 0.5,
             "throw": 1.0, "copy": 1.2, "write": 6.0, "hand": 0.8, "show": 0.6, "burn": 3.2}}
ACT_ITEMS = {   # what a runner can carry: how it looks and where it sits above its feet (keys left, the light right, texts on top) — mirrors flow.js
    "key":     {"icon": "key", "color": "#f97316", "dx": -14, "dy": -32, "tag": "auth key"},
    "idkey":   {"icon": "key", "color": "#3fb950", "dx": -14, "dy": -32, "tag": "own key"},
    "light":   {"light": True, "color": "#fff3a0", "dx": 20, "dy": -32},   # (FR140: right of the vault above its head)
    "vault":   {"vault": "keepass", "color": "#c9d1d9", "dx": 0, "dy": -40},   # FR130: a small safe locked with the KeePass logo, above its head
    "ip":      {"text": "Your SelfPrivacy IP address:\n192.42.69.314", "color": "#9aa3ad", "dx": 0, "dy": -74},   # FR132: two lines, the last one at dy
    "domain":  {"text": "selfprivacy.tail1234.ts.net", "color": "#f97316", "dx": 0, "dy": -60},
    "answer":  {"book": True, "color": "#9aa3ad", "dx": 0, "dy": -74},   # FR136: the address a book gives for a name — its text comes from the book's entry
    "jitsi":   {"img": "jitsi", "color": "#4aa3ff", "dx": 0, "dy": -40, "tag": "Jitsi call"},   # FR136: the call — the Jitsi Meet logo on a blue badge
    "backup":  {"icon": "backup", "color": "#58a6ff", "dx": -24, "dy": -18},   # FR140: your server's SelfPrivacy backup (low on its left, clear of the vault)
    "olddomain": {"text": "old: selfprivacy.tail1234.ts.net", "color": "#8b949e", "dx": 0, "dy": -60},   # FR139: the old machine's name, still at Tailscale
    "oldip":   {"text": "old machine's IP address:\n192.42.69.314", "color": "#8b949e", "dx": 0, "dy": -100},   # FR139: …and its address (above your own IP)
}
VAULT = {"w": 34, "h": 28, "inset": 3, "lock": 14, "IN": {"x": -2, "y": 0, "s": 0.7}}   # FR135: the KeePass vault — mirrors flow.js VAULT
BURN_FLAMES = [(-0.34, 0.65, 0), (-0.17, 0.85, 0.3), (0, 1, 0.55), (0.17, 0.85, 0.15), (0.34, 0.65, 0.45)]   # FR140 — mirrors flow.js BURN_FLAMES
ACTORS = ["mario", "yoshi", "jazz"]   # FR129: who acts — "who" in a step's script (mario when left out); sprite #ic-<who>
# FR128 / FR129: the scene the runners work in (a brick ledge, the fire bowl, two safes side by side, a shelf with two boards) — mirrors flow.js SCENE
# FR132: the safes a safe's width further right, the shelf big enough to read (it ends left of the pipe from the internet, at x ≈ 304)
SCENE = {"x0": -84, "x1": 284, "top": -72, "h": 12, "OPEN": -0.35, "safe": {"w": 44, "h": 52, "inset": 5, "lock": 17},
         "A": {"x": 16, "hinge": "l", "mark": 0}, "B": {"x": 78, "hinge": "r", "mark": 137}, "F": {"x": -68},
         "S": {"x": 160, "w": 114, "h": 72, "mark": 148, "rows": ["top", "bottom"]}, "IN": {"safe": 0.22, "shelf": 0.8, "icon": 0.8}}
_num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)   # JS typeof v === "number"
_r1 = lambda v: int(v * 10 + 0.5) / 10   # tenths, halves up (v ≥ 0) — flow.js r1
_dist = lambda p, q: ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2) ** 0.5


def _kv_at(kv, t):   # FR139: a key-framed value at t (linear, held at the ends) — mirrors flow.js kvAt
    v = 0
    for i, (a, x) in enumerate(kv):
        if a > t:
            if i:
                b, y = kv[i - 1]
                v = float(_f4(y + (x - y) * (t - b) / (a - b))) if a > b else x
            return v
        v = x
    return v


def _f3(v):   # a number the way flow.js writes +v.toFixed(3) (FR129)
    s = ("%.3f" % v).rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def _f4(v):   # a number the way flow.js writes +v.toFixed(4): up to 4 decimals, no trailing zeros, no "-0"
    s = ("%.4f" % v).rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def scene_geo(O):   # where the ledge, the safes, the fire bowl and the shelf are — mirrors flow.js sceneGeo
    s, top = SCENE["safe"], O[1] + SCENE["top"]
    g = {"O": O, "top": top, "x0": O[0] + SCENE["x0"], "x1": O[0] + SCENE["x1"], "fire": (O[0] + SCENE["F"]["x"], top)}
    for k in ("A", "B"):
        x, y, dw = O[0] + SCENE[k]["x"], top - s["h"], s["w"] - 2 * s["inset"]
        hx = x + s["inset"] if SCENE[k]["hinge"] == "l" else x + s["inset"] + dw
        lock = (x + s["w"] / 2, y + s["lock"])
        g[k] = {"x": x, "y": y, "hx": hx, "dw": dw, "lock": lock, "open": (hx + SCENE["OPEN"] * (lock[0] - hx), lock[1]),
                "inside": (x + s["w"] / 2, y + s["h"] / 2 + 3), "mark": (O[0] + SCENE[k]["mark"], top)}
    sh = SCENE["S"]
    x, y = O[0] + sh["x"], top - sh["h"]
    rh = sh["h"] / len(sh["rows"])
    g["S"] = {"x": x, "y": y, "w": sh["w"], "h": sh["h"], "rh": rh, "mark": (O[0] + sh["mark"], top)}
    for i, r in enumerate(sh["rows"]):   # where a thing stands on that board
        g["S." + r] = (x + sh["w"] / 2, y + rh * (i + 1) - 7)   # (just above it)
    return g


def actor_plan(step, epoly, edges, start=None, first=True, last=True, box_at=lambda i: None, entry_at=lambda i: "", screen_at=lambda i: None):   # one step's plan — mirrors flow.js actorPlan
    by = {e["id"]: e for e in edges}
    st0 = (start or {}).get("actors") or {}
    T = ACT["FADE"] if first or not st0.get("mario") else 0.0
    W, writes, ACTS, burns = {}, [], {}, []
    reads, shown, texts = [], [], dict((start or {}).get("texts") or {})   # FR136: books looked up, things shown on boxes, texts from books
    sc, n_inst = None, [0]

    def carry(R, i, on):   # (already holding it: nothing changes)
        lst = R["items"].setdefault(i, [])
        if not any(v[1] is None for v in lst):
            lst.append([on, None])

    def drop(R, i, off):
        for iv in R["items"].get(i, []):
            if iv[1] is None:
                iv[1] = off
                break

    def actor(who):   # a runner: where it is, its path, what it holds, which way it faces, when it shows
        if who in ACTS:
            return ACTS[who]
        s0 = st0.get(who)
        fc = s0["face"] if s0 and s0.get("face") else 1
        R = ACTS[who] = {"who": who, "pts": [], "kf": [], "dist": 0.0, "runs": [], "acts": [], "pops": [], "items": {}, "inst": {}, "doors": {}, "inside": {}, "spot": None, "at": None,
                         "facing": fc, "face": [[0, fc]], "op": [[0, 1 if s0 else 0]], "gone": False}
        if s0:
            R["spot"], R["at"] = s0["spot"], s0["at"]
            R["pts"].append(s0["spot"])
            R["kf"].append([0, 0])
            for i in s0["items"]:
                carry(R, i, 0)
        return R

    def turn(R, t, dx):   # it faces where it goes or works
        if abs(dx) <= 1:
            return
        v = 1 if dx > 0 else -1
        if v == R["facing"]:
            return
        R["facing"] = v
        if R["face"][-1][0] == t:
            R["face"][-1][1] = v
        else:
            R["face"].append([t, v])

    def go_to(R, q, dur):
        nonlocal T
        R["kf"].append([T, R["dist"]])
        turn(R, T, q[0] - R["spot"][0])
        L = _dist(R["spot"], q)
        R["pts"].append(q)
        R["runs"].append([T, T + dur])
        T += dur
        R["dist"] += L
        R["kf"].append([T, R["dist"]])
        R["spot"] = q

    hand = lambda R, i: (R["spot"][0] + ACT_ITEMS[i]["dx"], R["spot"][1] + ACT_ITEMS[i]["dy"])
    track = lambda inst: W.setdefault(inst, {"id": inst.split("#")[0], "pts": [], "kf": [], "d": 0, "vis": [], "sc": [], "rot": []})

    def new_inst(i):
        n_inst[0] += 1
        return f"{i}#{n_inst[0]}"

    def inst_of(R, i):   # the copy the runner holds (a new one when it got it by `get`)
        if not R["inst"].get(i):
            R["inst"][i] = new_inst(i)
        return R["inst"][i]

    def kf_add(w, t, d):
        last_ = w["kf"][-1] if w["kf"] else None
        if not last_ or last_[0] != t or last_[1] != d:
            w["kf"].append([t, d])

    def w_move(inst, t0, t1, path):   # the thing goes from where it is along the path, between t0 and t1
        w = track(inst)
        if not w["pts"]:
            w["pts"].append(path[0])
            kf_add(w, t0, 0)
            path = path[1:]
        kf_add(w, t0, w["d"])
        for q in path:
            L = _dist(w["pts"][-1], q)
            if L > 0:
                w["d"] += L
                w["pts"].append(q)
        kf_add(w, t1, w["d"])

    def holder(k):   # inside a safe, or on a shelf board
        if not sc or not (k in ("A", "B") or (k[:2] == "S." and k[2:] in SCENE["S"]["rows"])):
            return None
        return {"at": sc["g"][k]["inside"], "safe": True} if k in ("A", "B") else {"at": sc["g"][k], "safe": False}
    in_scale = lambda i, safe: (SCENE["IN"]["safe"] if safe else SCENE["IN"]["shelf"]) if ACT_ITEMS[i].get("text") else SCENE["IN"]["icon"]
    middle = lambda b: (b[0] + b[2] / 2, b[1] + b[3] / 2)
    # FR138: things stored on a box's screen stay there, into the next steps; a copy can be got off them, a vault with what lies in it
    stored = [dict(v, on=0, off=None) for v in ((start or {}).get("stored") or [])]
    for v in stored:
        shown.append({"id": v["id"], "at": v["at"], "x": v["x"], "y": v["y"], "s": v["s"], "inside": v.get("inside")})
    item_size = lambda i: (VAULT["w"], VAULT["h"]) if ACT_ITEMS[i].get("vault") else (60, 12) if ACT_ITEMS[i].get("text") else (18, 18)

    def slot_on(r, slot, i):   # a place on a screen: the middle, or its left / right half; the thing made to fit it
        half = slot in ("left", "right")
        w = r[2] / 2 if half else r[2]
        iw, ih = item_size(i)
        return (r[0] + (w / 2 if slot == "left" else r[2] - w / 2 if slot == "right" else r[2] / 2), r[1] + r[3] / 2,
                float(_f4(min(0.9 * w / iw, 0.85 * r[3] / ih))))
    if start and start.get("scene"):   # FR129: the scene the step before left standing — as it was, the doors shut, the fire out
        sc = {"g": scene_geo(start["scene"]["O"]), "t0": 0, "fadeIn": False, "t1": None, "doors": {"A": [], "B": []}, "lock": {}, "fire": [], "pops": [],
              "inside": [{"id": v["id"], "k": v["k"], "inst": None, "on": 0, "off": None, "x": v["x"], "y": v["y"], "s": v["s"]} for v in start["scene"]["inside"]]}
    for who in st0:   # the runners the step before left standing
        actor(who)
    for a in step.get("play") or []:
        R = actor(a["who"] if a.get("who") in ACTORS else "mario")
        if a.get("run") is not None:   # one line id, or alternatives (the first one drawn in this view wins: e_cable / e_usb)
            ids = a["run"] if isinstance(a["run"], list) else [a["run"]]
            e = next((by[i] for i in ids if i in by and len(epoly.get(i) or []) >= 2), None)
            p = epoly.get(e["id"]) if e else None
            if not p:
                continue
            p = list(reversed(p)) if a.get("back") else list(p)
            L, seq = _poly_len(p), p
            if not R["pts"]:   # it fades in where it starts
                R["pts"].extend(p)
                R["kf"].extend([[0, 0], [T, 0]])
                if T > ACT["FADE"]:
                    R["op"].append([T - ACT["FADE"], 0])
                R["op"].append([T, 1])
            else:
                q = R["pts"][-1]
                gap = _dist(q, p[0])
                R["kf"].append([T, R["dist"]])
                if gap > 0.5:   # walks across the box to where the next line starts
                    R["pts"].append(p[0])
                    L += gap
                    seq = [q] + p
                R["pts"].extend(p[1:])
            dur = min(ACT["MAX"], max(ACT["MIN"], _r1(L / ACT["V"])))
            c = 0
            for j in range(1, len(seq)):   # each stretch that goes left or right turns it that way
                turn(R, T + (c / L if L else 0) * dur, seq[j][0] - seq[j - 1][0])
                c += _dist(seq[j - 1], seq[j])
            R["runs"].append([T, T + dur])
            T += dur
            R["dist"] += L
            R["kf"].append([T, R["dist"]])
            R["spot"], R["at"] = p[-1], (e["from"] if a.get("back") else e["to"])
        elif a.get("get") is not None and a.get("from") is not None:   # FR136: a copy of what is shown on a box comes off it into its hand
            i = str(a["get"])
            v = next((x for x in shown if x["id"] == i and x["at"] == str(a["from"])), None) if R["spot"] and i in ACT_ITEMS else None
            if not v and R["spot"] and i in ACT_ITEMS:   # FR138: out of the box itself (the light, the backup)
                b = box_at(str(a["from"]))
                if b:
                    v = {"x": middle(b)[0], "y": middle(b)[1], "s": 0.3}
            if not v:
                continue
            if v.get("inside"):   # FR138: the vault's copy holds what the vault holds
                R["inside"][i] = [{"id": x, "on": T + ACT["T"]["show"], "off": None} for x in v["inside"]]
            inst = new_inst(i)
            w, t1 = track(inst), T + ACT["T"]["show"]
            turn(R, T, v["x"] - R["spot"][0])
            w_move(inst, T, T, [(v["x"], v["y"])])
            w_move(inst, T, t1, [hand(R, i)])
            w["vis"].append([T, t1])
            w["sc"] += [[T, v["s"]], [t1, 1]]
            carry(R, i, t1)
            R["inst"][i] = inst
            T = t1 + 0.2
        elif a.get("get") is not None:
            for i in (a["get"] if isinstance(a["get"], list) else [a["get"]]):
                if i in ACT_ITEMS:
                    carry(R, i, T)
            T += ACT["T"]["get"]
        elif a.get("pop") is not None:
            if sc and a.get("at") in ("A", "B"):   # above a safe
                q = sc["g"][a["at"]]
                sc["pops"].append([str(a["pop"]), q["x"] + SCENE["safe"]["w"] / 2, q["y"] - 28, T, T + ACT["T"]["pop"]])
            else:
                R["pops"].append([str(a["pop"]), T, T + ACT["T"]["pop"]])
            T += ACT["T"]["pop"]
        elif a.get("hammer") is not None:
            dur = a["hammer"] if _num(a["hammer"]) and a["hammer"] > 0 else ACT["T"]["hammer"]
            if a.get("at") is not None and str(a["at"]) != R["at"]:   # FR131: it builds only the box it names, once it got there (wifi: no line there)
                drop(R, "light", T)
                continue
            b = box_at(R["at"]) if R["at"] else None
            c = middle(b) if b else None
            lit = any(v[1] is None for v in R["items"].get("light", []))
            if c and R["spot"]:   # it faces the box it builds
                turn(R, T, c[0] - R["spot"][0])
            li = None
            if lit and c and R["spot"]:   # FR131: the install light goes from its hand into the middle of the box first
                li = inst_of(R, "light")
                w, t1 = track(li), T + ACT["T"]["give"]
                R["inst"].pop("light", None)
                drop(R, "light", T)
                w_move(li, T, T, [hand(R, "light")])
                w_move(li, T, t1, [c])
                w["vis"].append([T, None])
                w["sc"] += [[T, 1], [t1, 1.3]]
                T = t1
            elif lit:
                drop(R, "light", T + 0.4)
            t0, t1, blows, k = T, T + dur, [], 0   # the hammer comes down 0.15 s into every swing; each blow builds the box a ring further out of the light
            while t0 + 0.15 + k * ACT["BLOW"] <= t1 - 0.6 + 1e-9:
                blows.append(float(_f4(t0 + 0.15 + k * ACT["BLOW"])))
                k += 1
            R["acts"].append({"kind": "hammer", "t0": t0, "t1": t1, "at": R["at"], "c": c, "blows": blows})
            if li:
                w = track(li)
                for t in blows:   # the light flares with every blow…
                    w["sc"] += [[t, 1.3], [t + 0.06, 1.75], [t + 0.3, 1.3]]
                w["sc"] += [[blows[-1] + 0.3 if blows else t0, 1.3], [t1 - 0.05, 0.3]]   # …and sinks into the finished box
                w["vis"][-1][1] = t1
            T = t1
        elif a.get("appear") is not None:   # FR129: it comes out of a box (Yoshi, out of the Tailscale cloud)
            b = box_at(str(a["appear"]))
            if not b or R["pts"]:
                continue
            R["spot"] = middle(b)
            R["pts"].append(R["spot"])
            R["kf"].append([0, 0])
            R["op"] += [[T, 0], [T + ACT["T"]["scene"], 1]]
            T += ACT["T"]["scene"]
        elif a.get("vanish") and R["pts"]:   # …and goes back in
            R["op"] += [[T, 1], [T + ACT["T"]["scene"], 0]]
            R["gone"] = True
            T += ACT["T"]["scene"]
        elif a.get("scene") is False:   # FR129: the scene fades away
            if sc and sc["t1"] is None:
                sc["t1"] = T + 0.6
            T += ACT["T"]["unscene"]
        elif a.get("scene") and R["spot"]:   # FR128: the ledge, the safes, the fire bowl and the shelf appear here, holding what the script says
            sc = {"g": scene_geo((R["spot"][0], R["spot"][1])), "t0": T, "fadeIn": True, "t1": None, "doors": {"A": [], "B": []}, "lock": {}, "fire": [], "pops": [], "inside": []}
            for k in a["scene"]:
                h = holder(k)
                ids = [i for i in (a["scene"][k] if isinstance(a["scene"][k], list) else [a["scene"][k]]) if i in ACT_ITEMS]
                if not h:
                    continue
                for j, i in enumerate(ids):
                    sc["inside"].append({"id": i, "k": k, "inst": None, "on": T, "off": None, "x": h["at"][0], "y": h["at"][1] + (j - (len(ids) - 1) / 2) * 8, "s": in_scale(i, h["safe"])})
            T += ACT["T"]["scene"]
        elif sc and a.get("walk") in ("O", "A", "B", "S") and R["spot"]:   # to a safe or the shelf, or back down to where the scene started
            q = sc["g"]["O"] if a["walk"] == "O" else sc["g"]["S"]["mark"] if a["walk"] == "S" else sc["g"][a["walk"]]["mark"]
            go_to(R, (q[0], q[1]), max(ACT["WALK"], _r1(_dist(R["spot"], q) / ACT["V"])))
        elif a.get("put") is not None and a["put"] in ACT_ITEMS and R["spot"]:   # into a keyhole ("A.lock"), a safe or onto a shelf board ("B", "S.top"), or into a box ("server")
            i, into = a["put"], str(a.get("in") or "")
            parts = into.split(".")
            k, part = parts[0], (parts[1] if len(parts) > 1 else None)
            lock = bool(part == "lock" and sc and k in ("A", "B"))
            h = None if lock else holder(into)
            b = box_at(into) if not lock and not h else None
            scr = screen_at(into) if b and a.get("screen") else None   # FR138: onto its screen, to stay
            slot = slot_on(scr, a["screen"], i) if scr else None
            to = sc["g"][k]["lock"] if lock else (h["at"][0], h["at"][1] + len([v for v in sc["inside"] if v["k"] == into and v["off"] is None]) * 8) if h else (slot[0], slot[1]) if slot else middle(b) if b else None
            if not to:
                continue
            keep = a.get("copy") is True and not lock   # FR132: {"copy": true} — a copy comes off what it holds and goes there; the runner keeps its own
            inst = new_inst(i) if keep else inst_of(R, i)
            w, t0, t1 = track(inst), T + (0.2 if keep else 0), T + (0.5 if lock else 0.8 if keep else 0.6)
            if not keep:
                R["inst"].pop(i, None)
                drop(R, i, T)
            turn(R, T, to[0] - R["spot"][0])
            w_move(inst, T, T, [hand(R, i)])
            w["vis"].append([T, None])
            w["sc"] += [[T, 0.6], [t0, 1]] if keep else [[T, 1]]
            w_move(inst, t0, t1, [to])
            if lock:
                w["sc"].append([t1, 0.8])
                w["rot"] += [[t1, 0], [T + ACT["T"]["put"], 90]]
                sc["lock"][k] = inst
                T += ACT["T"]["put"]
            elif h:
                s = in_scale(i, h["safe"])
                w["sc"].append([t1, s])
                w["vis"][-1][1] = t1
                sc["inside"].append({"id": i, "k": into, "inst": inst, "on": t1, "off": None, "x": to[0], "y": to[1], "s": s})
                T += ACT["T"]["copy"] if keep else ACT["T"]["putIn"]
            elif slot:   # FR138: it lies on the screen from now on
                inside = [v["id"] for v in R["inside"].get(i, []) if v.get("off") is None]
                w["sc"].append([t1, slot[2]])
                w["vis"][-1][1] = t1
                stored.append({"id": i, "at": into, "x": to[0], "y": to[1], "s": slot[2], "inside": inside, "on": t1, "off": None})
                shown.append({"id": i, "at": into, "x": to[0], "y": to[1], "s": slot[2], "inside": inside})
                T += ACT["T"]["copy"] if keep else ACT["T"]["putIn"]
            else:   # FR130: into a box — it goes in and is kept there
                w["sc"].append([t1, 0.3])
                w["vis"][-1][1] = t1
                T += ACT["T"]["copy"] if keep else ACT["T"]["putIn"]
        elif sc and (a.get("open") if a.get("open") is not None else a.get("close")) in ("A", "B"):   # the door swings open / shut; a key in its lock goes with it
            opening = a.get("open") is not None
            k = a["open"] if opening else a["close"]
            q, d = sc["g"][k], (ACT["T"]["open"] if opening else ACT["T"]["close"])
            sc["doors"][k] += [[T, 1 if opening else SCENE["OPEN"]], [T + d, SCENE["OPEN"] if opening else 1]]
            if sc["lock"].get(k):
                w_move(sc["lock"][k], T, T + d, [q["open"] if opening else q["lock"]])
            T += d
        elif (a.get("open") is not None or a.get("close") is not None) and ACT_ITEMS.get(a["open"] if a.get("open") is not None else a["close"], {}).get("vault") \
                and any(v[1] is None for v in R["items"].get(a["open"] if a.get("open") is not None else a["close"], [])):   # FR135: the door of the vault it holds swings open / shut
            opening = a.get("open") is not None
            i = a["open"] if opening else a["close"]
            d = ACT["T"]["open"] if opening else ACT["T"]["close"]
            R["doors"].setdefault(i, []).extend([[T, 1 if opening else SCENE["OPEN"]], [T + d, SCENE["OPEN"] if opening else 1]])
            T += d
        elif sc and a.get("fire"):   # a fire starts in the bowl (FR139: one still burning goes on)
            v = _kv_at(sc["fire"], T)
            sc["fire"] = [k_ for k_ in sc["fire"] if k_[0] <= T]
            sc["fire"] += [[T, v], [T + ACT["T"]["fire"], 1]]
            T += ACT["T"]["fire"]
        elif a.get("take") is not None and a["take"] in ACT_ITEMS and R["spot"] and ACT_ITEMS.get(str(a.get("from") or ""), {}).get("vault"):   # FR138: out of the vault it holds (over the runner)
            box = str(a["from"])
            v = next((x for x in R["inside"].get(box, []) if x["id"] == a["take"] and x.get("off") is None), None)
            if not v:
                continue
            h, inst = hand(R, box), new_inst(a["take"])
            w, t1 = track(inst), T + ACT["T"]["take"]
            v["off"], w["over"] = T, True
            w_move(inst, T, T, [(h[0] + VAULT["IN"]["x"], h[1] + VAULT["IN"]["y"])])
            w_move(inst, T, t1, [hand(R, a["take"])])
            w["vis"].append([T, t1])
            w["sc"] += [[T, VAULT["IN"]["s"]], [t1, 1]]
            carry(R, a["take"], t1)
            R["inst"][a["take"]] = inst
            T = t1
        elif a.get("take") is not None and a["take"] in ACT_ITEMS and R["spot"]:   # out of a keyhole ("A.lock"), out of a safe or off a shelf board ("A", "S.top")
            i, frm = a["take"], str(a.get("from") or "")
            parts = frm.split(".")
            k, part = parts[0], (parts[1] if len(parts) > 1 else None)
            if part == "lock" and sc and k in ("A", "B"):
                inst = sc["lock"].get(k)
                if not inst:
                    continue
                w, t1 = track(inst), T + ACT["T"]["unlock"]
                turn(R, T, sc["g"][k]["lock"][0] - R["spot"][0])
                w_move(inst, T, t1, [hand(R, i)])
                w["sc"] += [[T, 0.8], [t1, 1]]
                w["rot"] += [[T, 90], [t1, 0]]
                if w["vis"]:
                    w["vis"][-1][1] = t1
                carry(R, i, t1)
                R["inst"][i] = inst
                sc["lock"][k] = None
                T = t1
            else:
                v = next((x for x in sc["inside"] if x["id"] == i and x["k"] == frm and x["off"] is None), None) if sc else None
                if not v:
                    continue
                inst = v["inst"] or new_inst(i)
                w, t1 = track(inst), T + ACT["T"]["take"]
                v["off"] = T
                turn(R, T, v["x"] - R["spot"][0])
                w_move(inst, T, T, [(v["x"], v["y"])])
                w_move(inst, T, t1, [hand(R, i)])
                w["vis"].append([T, t1])
                w["sc"] += [[T, v["s"]], [t1, 1]]
                carry(R, i, t1)
                R["inst"][i] = inst
                T = t1
        elif sc and a.get("throw") is not None and a["throw"] in ACT_ITEMS and R["spot"]:   # tossed into the fire: it shrinks away, the fire flares, then burns down
            i = a["throw"]
            inst = inst_of(R, i)
            w, frm = track(inst), hand(R, i)
            to, t1 = (sc["g"]["fire"][0], sc["g"]["fire"][1] - 12), T + 0.8
            R["inst"].pop(i, None)
            turn(R, T, to[0] - R["spot"][0])
            drop(R, i, T)
            w_move(inst, T, T, [frm])
            w["vis"].append([T, T + ACT["T"]["throw"]])
            w["sc"] += [[T, 1], [t1, 1], [T + ACT["T"]["throw"], 0.3]]
            arc = []
            for j in range(1, 9):
                u = j / 8
                arc.append((frm[0] + (to[0] - frm[0]) * u, frm[1] + (to[1] - frm[1]) * u - 160 * u * (1 - u)))
            w_move(inst, T, t1, arc)
            sc["fire"] = [k_ for k_ in sc["fire"] if k_[0] <= t1]   # (FR139: a second throw flares it again)
            sc["fire"] += [[t1, 1], [t1 + 0.15, 1.5], [t1 + 0.5, 1], [t1 + 1.5, 1], [t1 + 2.5, 0]]
            T += ACT["T"]["throw"]
        elif a.get("copy") is not None and a["copy"] in ACT_ITEMS and str(a.get("in") or "") in ACT_ITEMS and R["spot"]:   # FR130: a copy comes out of a box into what the runner holds (the vault)
            b = box_at(str(a.get("from") or ""))
            if not b:
                continue
            inst = new_inst(a["copy"])
            into = str(a["in"])
            w, frm, h, t1 = track(inst), middle(b), hand(R, into), T + 0.8
            turn(R, T, frm[0] - R["spot"][0])
            w_move(inst, T, T, [frm])
            if ACT_ITEMS[into].get("vault"):   # FR135: into the (open) vault — over the runner, it lands inside and lies there
                w_move(inst, T + 0.2, t1, [(h[0] + VAULT["IN"]["x"], h[1] + VAULT["IN"]["y"])])
                w["vis"].append([T, t1])
                w["sc"] += [[T, 0.6], [T + 0.2, 1], [t1, VAULT["IN"]["s"]]]
                w["over"] = True
                R["inside"].setdefault(into, []).append({"id": a["copy"], "on": t1})
            else:
                w_move(inst, T + 0.2, t1, [h])
                w["vis"].append([T, t1 + 0.2])
                w["sc"] += [[T, 0.6], [T + 0.2, 1], [t1, 1], [t1 + 0.2, 0.3]]
            T += ACT["T"]["copy"]
        elif a.get("write") is not None and R["spot"]:   # FR129: the book opens, what the runner brings goes in, the entry is written
            b = box_at(str(a["write"]))
            if not b:
                continue
            writes.append({"book": str(a["write"]), "t": T + 0.2})
            for i in list(R["items"].keys()):
                if ACT_ITEMS[i].get("text") and any(v[1] is None for v in R["items"][i]):
                    inst = inst_of(R, i)
                    w = track(inst)
                    R["inst"].pop(i, None)
                    drop(R, i, T + 3.4)
                    w_move(inst, T + 3.4, T + 3.4, [hand(R, i)])
                    w_move(inst, T + 3.4, T + 3.9, [middle(b)])
                    w["vis"].append([T + 3.4, T + 3.9])
                    w["sc"] += [[T + 3.4, 1], [T + 3.9, 0.3]]
            T += ACT["T"]["write"]
        elif a.get("lookup") is not None and R["spot"]:   # FR136: the book opens; the name it brings goes in, the address on that line comes out into its hand
            b = box_at(str(a["lookup"]))
            if not b:
                continue
            m = IP_RE.search(" ".join(entry_at(str(a["lookup"])).split("\n")[1:]))
            t0, c = T + 0.2, middle(b)
            reads.append({"book": str(a["lookup"]), "t": t0})
            texts["answer"] = "ip " + (m.group(0) if m else "?")
            turn(R, T, c[0] - R["spot"][0])
            for i in list(R["items"].keys()):   # (once the book is open at the entry)
                if ACT_ITEMS[i].get("text") and any(v[1] is None for v in R["items"][i]):
                    inst = inst_of(R, i)
                    w = track(inst)
                    R["inst"].pop(i, None)
                    drop(R, i, t0 + 3.0)
                    w_move(inst, t0 + 3.0, t0 + 3.0, [hand(R, i)])
                    w_move(inst, t0 + 3.0, t0 + 3.5, [c])
                    w["vis"].append([t0 + 3.0, t0 + 3.5])
                    w["sc"] += [[t0 + 3.0, 1], [t0 + 3.5, 0.3]]
            inst = new_inst("answer")   # (when the book lets the address go, FR121)
            w, u0 = track(inst), t0 + 0.48 * PB["T"]
            u1 = u0 + 0.5
            w_move(inst, u0, u0, [c])
            w_move(inst, u0, u1, [hand(R, "answer")])
            w["vis"].append([u0, u1])
            w["sc"] += [[u0, 0.3], [u1, 1]]
            carry(R, "answer", u1)
            R["inst"]["answer"] = inst
            T = u1 + 0.1
        elif a.get("give") is not None and a["give"] in ACT_ITEMS and R["spot"]:   # FR136: hand to hand, to another runner
            O, i = ACTS.get(a.get("to")), a["give"]
            if not O or not O["spot"] or O is R or not any(v[1] is None for v in R["items"].get(i, [])):
                continue
            inst = inst_of(R, i)
            w, t1 = track(inst), T + ACT["T"]["hand"]
            R["inst"].pop(i, None)
            turn(R, T, O["spot"][0] - R["spot"][0])
            turn(O, T, R["spot"][0] - O["spot"][0])
            drop(R, i, T)
            w_move(inst, T, T, [hand(R, i)])
            w_move(inst, T, t1, [hand(O, i)])
            w["vis"].append([T, t1])
            w["sc"].append([T, 1])
            carry(O, i, t1)
            O["inst"][i] = inst
            T = t1
        elif a.get("show") is not None and a["show"] in ACT_ITEMS and R["spot"]:   # FR136: on a box, for all to see (the call on the server, then on the phone)
            b = box_at(str(a.get("at") or ""))
            if not b:
                continue
            i, to, s = a["show"], middle(b), 1.3
            held = any(v[1] is None for v in R["items"].get(i, []))
            inst = inst_of(R, i) if held else new_inst(i)
            w = track(inst)
            if held:
                R["inst"].pop(i, None)
                turn(R, T, to[0] - R["spot"][0])
                drop(R, i, T)
                w_move(inst, T, T, [hand(R, i)])
                w_move(inst, T, T + ACT["T"]["show"], [to])
                w["sc"] += [[T, 1], [T + ACT["T"]["show"], s]]
            else:
                w_move(inst, T, T, [to])
                w["sc"] += [[T, 0.3], [T + ACT["T"]["show"], s]]
            w["vis"].append([T, None])
            shown.append({"id": i, "at": str(a["at"]), "x": to[0], "y": to[1], "s": s})
            T += ACT["T"]["show"] + 0.2
        elif a.get("burn") is not None:   # FR140: a box burns down — flames over it, and it is gone
            if not box_at(str(a["burn"])):
                continue
            burns.append({"at": str(a["burn"]), "t0": T, "t1": T + ACT["T"]["burn"]})
            T += ACT["T"]["burn"]
        elif _num(a.get("wait")):
            T += max(0, a["wait"])
    all_ = [ACTS[who] for who in ACTORS if who in ACTS and ACTS[who]["pts"]]
    if not all_ and not sc and not stored and not burns:   # (no runner, no scene and nothing stored on a screen)
        return None   # no runner and no scene in this step
    if _num(step.get("dur")):   # standing time
        T = max(T, step["dur"])
    elif not (step.get("play") or []):
        T = max(T, ACT["STAND"])
    for R in all_:
        R["kf"].append([T, R["dist"]])
    if last:
        for R in all_:
            if not R["gone"]:
                R["op"] += [[T, 1], [T + ACT["FADE"], 0]]
        T += ACT["FADE"]
        for R in all_:
            R["kf"].append([T, R["dist"]])
    out = {"T": T, "W": W, "scene": sc, "writes": writes, "reads": reads, "texts": texts, "last": last, "stored": stored, "burns": burns,
           "end": {"actors": {}, "scene": None, "texts": texts, "stored": [{k: v[k] for k in ("id", "at", "x", "y", "s", "inside")} for v in stored if v["off"] is None]},
           "actors": [{"who": R["who"], "pts": R["pts"], "L": _poly_len(R["pts"]), "kf": R["kf"], "runs": R["runs"], "acts": R["acts"], "pops": R["pops"],
                       "items": R["items"], "doors": R["doors"], "inside": R["inside"], "face": R["face"], "op": R["op"]} for R in all_]}
    for R in all_:
        if not R["gone"]:
            out["end"]["actors"][R["who"]] = {"spot": R["spot"], "at": R["at"], "face": R["facing"], "items": [i for i, ivs in R["items"].items() if any(v[1] is None for v in ivs)]}
    if sc and sc["t1"] is None:
        out["end"]["scene"] = {"O": sc["g"]["O"], "inside": [{"id": v["id"], "k": v["k"], "x": v["x"], "y": v["y"], "s": v["s"]} for v in sc["inside"] if v["off"] is None]}
    return out


def step_plans(steps_now, step, epoly, edges, box_at, entry_at=lambda i: "", screen_at=lambda i: None):   # FR125 / FR129: the plans of steps 0…step, each starting where the one before ended — mirrors flow.js stepPlans
    P = prev = None
    durs = []
    for k in range(step + 1):
        P = actor_plan(steps_now[k], epoly, edges, prev, k == 0, k == len(steps_now) - 1, box_at, entry_at, screen_at)
        prev = P["end"] if P else None
        durs.append(P["T"] if P else (steps_now[k]["dur"] if _num(steps_now[k].get("dur")) else ACT["STAND"]))
    return {"P": P, "durs": durs}


def actor_svg(P, anchor_of, bg, images=None):   # the plan, drawn: every animation runs once and freezes at its end — mirrors flow.js drawActor
    T = P["T"]
    images = images or {}
    tk = lambda t: _f4(max(0.0, min(1.0, t / T)))

    def anim(**a):
        tag = "animateMotion" if "path" in a else "animateTransform" if "type" in a else "animate"
        return f'<{tag} dur="{_f4(T)}s" repeatCount="1" fill="freeze" ' + " ".join(f'{k}="{v}"' for k, v in a.items()) + "/>"
    tail = T - ACT["FADE"] if P["last"] else None   # a thing still held at the end goes with the fade-out — or stays, for the next step

    def fade_kv(ivs0):   # opacity 1 during each [on, off] (off None = held to the end), 0.05 s ramps → (constant value or None, markup)
        ivs = [[on, tail if off is None else off] for on, off in ivs0]
        ivs = [[on, off] for on, off in ivs if off is None or off - on >= 0.12]   # (a moment's flash is left out)
        kv, open_ = [[0, 1 if any(on <= 0 for on, _ in ivs) else 0]], False
        for on, off in ivs:
            if off is None:
                if on > 0:
                    kv += [[on, 0], [on + 0.05, 1]]
                open_ = True
                continue
            if on > 0:
                kv += [[on, 0], [on + 0.05, 1]]
            kv += [[off - 0.05, 1], [off, 0]]
        kv.append([T, 1 if open_ else 0])
        ks = [v for i, v in enumerate(kv) if not i or v[0] >= kv[i - 1][0]]   # key times never go back
        if all(v[1] == ks[0][1] for v in ks):
            return ks[0][1], ""
        return None, anim(attributeName="opacity", values=";".join(str(v[1]) for v in ks), keyTimes=";".join(tk(v[0]) for v in ks))

    def fade_iv(ivs):   # …as an opacity attribute + animation for a group opened by the caller with opacity="0"
        c, a = fade_kv(ivs)
        return a if c is None else f'<set attributeName="opacity" to="{c}"/>'

    def keyed(kv0):   # [time, value] key frames over the whole plan (held before the first and after the last) — mirrors flow.js keyed
        kv = ([[0, kv0[0][1]]] + list(kv0)) if kv0 and kv0[0][0] > 0 else list(kv0)
        if kv and kv[-1][0] < T:
            kv.append([T, kv[-1][1]])
        return [v for i, v in enumerate(kv) if not i or v[0] >= kv[i - 1][0]]
    varies = lambda kv: any(v[1] != kv[0][1] for v in kv)

    def look(i, x, y, s, plain, ivs=None, opacity=None, box=None):   # a thing's look at (x, y), scaled: its icon (+ tag, unless plain), the vault (box: its door + inside), or its text
        it = ACT_ITEMS[i]
        c, a = fade_kv(ivs) if ivs is not None else (opacity, "")
        o = [f'<g transform="translate({_f4(x)} {_f4(y)})' + (f' scale({_f4(s)})' if s != 1 else "") + f'" opacity="{0 if c is None else c}">']
        if it.get("icon"):
            o.append(f'<use href="#ic-{it["icon"]}" x="-9" y="-9" width="18" height="18" style="color:{it["color"]}"/>')
        elif it.get("light"):
            o.append(f'<circle r="9" fill="{it["color"]}" opacity="0.35"/><circle r="4.5" fill="#fffbe0"/>')
        elif it.get("vault"):   # FR135: a small safe — its inside, what lies in it, and its door (hinged left) with the KeePass logo as the lock
            V = VAULT
            iw, ih = V["w"] - 2 * V["inset"], V["h"] - 2 * V["inset"]
            lx, ly = iw - V["lock"] - 2, (ih - V["lock"]) / 2
            o.append(f'<rect x="{_f4(-V["w"] / 2)}" y="{_f4(-V["h"] / 2)}" width="{V["w"]}" height="{V["h"]}" rx="3" fill="#2d333b" stroke="{it["color"]}" stroke-width="1.5"/>'
                     f'<rect x="{_f4(-iw / 2)}" y="{_f4(-ih / 2)}" width="{iw}" height="{ih}" fill="#0b0e14"/>')
            for v in (box or {}).get("inside") or []:
                o.append(look(v["id"], V["IN"]["x"], V["IN"]["y"], V["IN"]["s"], True, ivs=[[v["on"], v.get("off")]]))
            o.append(f'<g transform="translate({_f4(-iw / 2)} {_f4(-ih / 2)})"><g>'
                     f'<rect x="0" y="0" width="{iw}" height="{ih}" fill="#3d444d" stroke="#c9d1d9" stroke-width="1"/>')
            src = images.get(it["vault"])
            o.append(f'<image href="{html.escape(src, quote=True)}" x="{_f4(lx)}" y="{_f4(ly)}" width="{V["lock"]}" height="{V["lock"]}"/>' if src
                     else f'<circle cx="{_f4(lx + V["lock"] / 2)}" cy="{_f4(ly + V["lock"] / 2)}" r="3" fill="#facc15"/>')
            dk = keyed((box or {}).get("door") or [])
            if varies(dk):
                o.append(anim(attributeName="transform", type="scale", values=";".join(f"{_f4(v[1])} 1" for v in dk), keyTimes=";".join(tk(v[0]) for v in dk)))
            o.append("</g></g>")
        elif it.get("img"):   # FR136: a logo on a blue badge (Jitsi Meet)
            o.append('<rect x="-9" y="-9" width="18" height="18" rx="4" fill="#1d76ba" stroke="#c9d1d9" stroke-width="1"/>')
            src = images.get(it["img"])
            if src:
                o.append(f'<image href="{html.escape(src, quote=True)}" x="-7" y="-7" width="14" height="14"/>')
        label = it.get("text") or (it.get("book") and (P.get("texts") or {}).get(i)) or (None if plain else it.get("tag"))   # FR136: a book's address carries the text the book gave
        if label:   # FR132: more lines stack upwards, the last one where a single line would be
            ls = label.split("\n")
            body = html.escape(label) if len(ls) == 1 else "".join(f'<tspan x="0" y="{_f4(3.5 - (len(ls) - 1 - j) * 11)}">{html.escape(l)}</tspan>' for j, l in enumerate(ls))
            o.append(f'<text x="0" y="{3.5 if it.get("text") or it.get("book") else -12}" text-anchor="middle" fill="{it["color"]}" font-size="10"{HALO}>{body}</text>')
        o.append(a + "</g>")
        return "".join(o)
    o = ['<g class="actor" pointer-events="none" font-family="ui-sans-serif, system-ui, sans-serif"><style>@media (prefers-reduced-motion: reduce){.actor{display:none}}</style>']
    n_build = 0
    for A in P["actors"]:   # world-fixed things first (under the runners): the build cover
        for a in A["acts"]:
            if a["kind"] == "hammer":
                b = anchor_of(a["at"]) if a.get("at") else None
                if not b:
                    continue
                # FR131: the box is built up out of the light in its middle — a hole in the cover opens there, a ring wider with every blow
                x, y, w, h = b[0] - 2, b[1] - 2, b[2] + 4, b[3] + 4
                c, nb = a.get("c") or (b[0] + b[2] / 2, b[1] + b[3] / 2), len(a["blows"])
                Rm = max(_dist(c, q) for q in ((x, y), (x + w, y), (x, y + h), (x + w, y + h))) + 1
                mid, n_build = f"actbuild{n_build}", n_build + 1
                rk = [[0, 0], [a["t0"], 0]]
                if nb:
                    for i, t in enumerate(a["blows"]):
                        rk += [[t, Rm * i / nb], [t + 0.12, Rm * (i + 1) / nb]]
                else:
                    rk.append([max(a["t0"], a["t1"] - 0.3), Rm])
                rv = keyed(rk)
                box = f'x="{_f4(x)}" y="{_f4(y)}" width="{_f4(w)}" height="{_f4(h)}"'
                o.append(f'<mask id="{mid}" maskUnits="userSpaceOnUse" {box}><rect {box} fill="#fff"/><circle cx="{_f4(c[0])}" cy="{_f4(c[1])}" r="0" fill="#000">'
                         + anim(attributeName="r", values=";".join(_f4(v[1]) for v in rv), keyTimes=";".join(tk(v[0]) for v in rv)) + "</circle></mask>")
                o.append(f'<rect {box} fill="{bg}" mask="url(#{mid})"/>')
    for bn in P.get("burns") or []:   # FR140: flames over the box, which goes
        b = anchor_of(bn["at"])
        if not b:
            continue
        ck = keyed([[0, 0], [bn["t0"] + 1.0, 0], [bn["t0"] + 2.2, 1]])
        o.append(f'<rect x="{_f4(b[0] - 2)}" y="{_f4(b[1] - 2)}" width="{_f4(b[2] + 4)}" height="{_f4(b[3] + 4)}" fill="{bg}" opacity="0">'
                 + anim(attributeName="opacity", values=";".join(_f4(v[1]) for v in ck), keyTimes=";".join(tk(v[0]) for v in ck)) + "</rect>")
        fk = keyed([[0, 0], [bn["t0"], 0], [bn["t0"] + 0.6, 1], [bn["t0"] + 1.4, 1.2], [bn["t1"] - 0.8, 1], [bn["t1"], 0]])
        fs = b[3] * 0.85 / 12
        o.append(f'<g transform="translate({_f4(b[0] + b[2] / 2)} {_f4(b[1] + b[3])})"><g transform="scale(0)">'
                 + anim(attributeName="transform", type="scale", values=";".join(f"{_f4(v[1])} {_f4(v[1])}" for v in fk), keyTimes=";".join(tk(v[0]) for v in fk))
                 + "".join(flame_svg(dx * b[2], 0, fs * k_, ph) for dx, k_, ph in BURN_FLAMES) + "</g></g>")
    for v in P.get("stored") or []:   # FR138: what lies on a screen
        o.append(look(v["id"], v["x"], v["y"], v["s"], True, ivs=[[v["on"], v["off"]]]))
    sc = P["scene"]
    if sc:   # FR128 / FR129: the ledge, the safes, the fire bowl and the shelf — they fade in when the scene starts and out when it ends
        g, s = sc["g"], SCENE["safe"]
        so = keyed(([[0, 0], [sc["t0"], 0], [sc["t0"] + 0.4, 1]] if sc["fadeIn"] else [[0, 1]]) + ([[sc["t1"] - 0.6, 1], [sc["t1"], 0]] if sc["t1"] is not None else []))
        if varies(so):
            o.append('<g opacity="0">' + anim(attributeName="opacity", values=";".join(str(v[1]) for v in so), keyTimes=";".join(tk(v[0]) for v in so)))
        else:
            o.append(f'<g opacity="{so[0][1] if so else 1}">')
        o.append(f'<rect x="{_f4(g["x0"])}" y="{_f4(g["top"])}" width="{_f4(g["x1"] - g["x0"])}" height="{SCENE["h"]}" fill="#9a5523" stroke="#5c2f0d" stroke-width="1.5"/>')   # the ledge (bricks)
        x = g["x0"] + 16
        while x < g["x1"] - 4:
            o.append(f'<line x1="{_f4(x)}" y1="{_f4(g["top"])}" x2="{_f4(x)}" y2="{_f4(g["top"] + SCENE["h"])}" stroke="#5c2f0d" stroke-width="1.5"/>')
            x += 16
        for k in ("A", "B"):
            q = g[k]
            dh = s["h"] - 2 * s["inset"]
            x0 = 0 if SCENE[k]["hinge"] == "l" else -q["dw"]
            kx, ky = x0 + q["dw"] / 2, s["lock"] - s["inset"]
            o.append(f'<rect x="{_f4(q["x"])}" y="{_f4(q["y"])}" width="{s["w"]}" height="{s["h"]}" rx="4" fill="#2d333b" stroke="#c9d1d9" stroke-width="1.5"/>')
            o.append(f'<rect x="{_f4(q["x"] + s["inset"])}" y="{_f4(q["y"] + s["inset"])}" width="{q["dw"]}" height="{dh}" fill="#0b0e14"/>')   # inside
            for v in sc["inside"]:
                if v["k"] == k:
                    o.append(look(v["id"], v["x"], v["y"], v["s"], True, ivs=[[v["on"], v["off"]]]))
            dk = keyed(sc["doors"][k])
            o.append(f'<g transform="translate({_f4(q["hx"])} {_f4(q["y"] + s["inset"])})"><g>'   # the door, turning on its hinge
                     f'<rect x="{x0}" y="0" width="{q["dw"]}" height="{dh}" fill="#3d444d" stroke="#c9d1d9" stroke-width="1"/>'
                     f'<circle cx="{_f4(kx)}" cy="{_f4(ky)}" r="3.4" fill="#facc15"/>'   # the keyhole (yellow, like the logo's)
                     f'<path d="M {_f4(kx - 1.8)} {_f4(ky + 1)} L {_f4(kx + 1.8)} {_f4(ky + 1)} L {_f4(kx + 3)} {_f4(ky + 9)} L {_f4(kx - 3)} {_f4(ky + 9)} Z" fill="#facc15"/>'
                     + (anim(attributeName="transform", type="scale", values=";".join(f"{_f4(v[1])} 1" for v in dk), keyTimes=";".join(tk(v[0]) for v in dk)) if varies(dk) else "")
                     + "</g></g>")
        SH = g["S"]   # FR129: the shelf — a frame with its boards (FR132: two), and what stands on them
        o.append(f'<rect x="{_f4(SH["x"])}" y="{_f4(SH["y"])}" width="{SH["w"]}" height="{SH["h"]}" fill="#2b1d12" stroke="#8b5a2b" stroke-width="1.5"/>')
        for i in range(1, len(SCENE["S"]["rows"]) + 1):
            o.append(f'<line x1="{_f4(SH["x"])}" y1="{_f4(SH["y"] + SH["rh"] * i)}" x2="{_f4(SH["x"] + SH["w"])}" y2="{_f4(SH["y"] + SH["rh"] * i)}" stroke="#8b5a2b" stroke-width="2.5"/>')
        for v in sc["inside"]:
            if v["k"].startswith("S."):
                o.append(look(v["id"], v["x"], v["y"], v["s"], True, ivs=[[v["on"], v["off"]]]))
        fk = keyed(sc["fire"])   # the fire bowl; the fire starts, flares, burns down
        o.append(f'<g transform="translate({_f4(g["fire"][0])} {_f4(g["fire"][1])})">'
                 '<path d="M -13 -9 L 13 -9 L 9 0 L -9 0 Z" fill="#6e7681" stroke="#2d333b" stroke-width="1.2"/>'
                 '<g transform="translate(0 -9)">'
                 + ('<g>' + anim(attributeName="transform", type="scale", values=";".join(f"{_f4(v[1])} {_f4(v[1])}" for v in fk), keyTimes=";".join(tk(v[0]) for v in fk))
                    if varies(fk) else f'<g transform="scale({_f4(fk[0][1]) if fk else 0})">')
                 + flame_svg(-6, 0, 1.2, 0) + flame_svg(0, 0, 1.7, 0.3) + flame_svg(6, 0, 1.2, 0.55) + "</g></g></g>")
        o.append("</g>")
    def track_svg(w):   # things away from the runners — into a keyhole, a safe, a shelf, the fire or a box, and back
        kk, sk, rk = keyed(w["kf"]), keyed(w["sc"]), keyed(w["rot"])
        c, fa = fade_kv(w["vis"])
        o.append(f'<g opacity="{0 if c is None else c}"' + ("" if w["d"] > 0 else f' transform="translate({_f4(w["pts"][0][0])} {_f4(w["pts"][0][1])})"') + ">")
        if w["d"] > 0:
            o.append(anim(path="M " + " L ".join(f"{_f4(x)} {_f4(y)}" for x, y in w["pts"]), keyPoints=";".join(_f4(min(1.0, v[1] / w["d"])) for v in kk),
                          keyTimes=";".join(tk(v[0]) for v in kk), calcMode="linear"))
        o.append(fa + "<g>")   # it shrinks into a keyhole / safe / box and turns in a lock
        if varies(sk):
            o.append(anim(attributeName="transform", type="scale", values=";".join(f"{_f4(v[1])} {_f4(v[1])}" for v in sk), keyTimes=";".join(tk(v[0]) for v in sk)))
        o.append("<g>")
        if varies(rk):
            o.append(anim(attributeName="transform", type="rotate", values=";".join(_f4(v[1]) for v in rk), keyTimes=";".join(tk(v[0]) for v in rk)))
        o.append(look(w["id"], 0, 0, 1, True, opacity=1) + "</g></g></g>")
    for w in P["W"].values():   # (FR135: what lands in a vault a runner holds goes over the runner)
        if not w.get("over"):
            track_svg(w)
    for A in P["actors"]:   # the runners: along their paths, or standing where the step before left them
        ro = keyed(A["op"])   # it fades in / out where it appears and vanishes, and at the story's ends
        const_o = None if varies(ro) else (ro[0][1] if ro else 1)
        o.append(f'<g opacity="{0 if const_o is None else const_o}"' + (f' transform="translate({_f4(A["pts"][0][0])} {_f4(A["pts"][0][1])})"' if len(A["pts"]) < 2 else "") + ">")
        if len(A["pts"]) >= 2:
            path = "M " + " L ".join(f"{_f4(x)} {_f4(y)}" for x, y in A["pts"])
            o.append(anim(path=path, keyPoints=";".join(_f4(min(1.0, k[1] / A["L"])) for k in A["kf"]), keyTimes=";".join(tk(k[0]) for k in A["kf"]), calcMode="linear"))
        if const_o is None:
            o.append(anim(attributeName="opacity", values=";".join(str(v[1]) for v in ro), keyTimes=";".join(tk(v[0]) for v in ro)))
        hop = [[0, 0]]   # hops while running: up 4 every half hop
        for t0, t1 in A["runs"]:
            hop.append([t0, 0])
            k, t = 1, t0 + ACT["HOP"] / 2
            while t < t1 - 0.05:
                hop.append([t, -4 if k % 2 else 0])
                k += 1
                t = t0 + k * ACT["HOP"] / 2
            hop.append([t1, 0])
        hop.append([T, 0])
        o.append("<g>" + (anim(attributeName="transform", type="translate", values=";".join(f"0 {h[1]}" for h in hop), keyTimes=";".join(tk(h[0]) for h in hop)) if A["runs"] else ""))
        fv, sz = keyed(A["face"]), ACT["SIZE"]   # the sprite faces where it goes (what it holds doesn't turn)
        if varies(fv):
            o.append("<g>" + anim(attributeName="transform", type="scale", values=";".join(f"{v[1]} 1" for v in fv), keyTimes=";".join(tk(v[0]) for v in fv), calcMode="discrete"))
        else:
            o.append('<g transform="scale(-1 1)">' if fv and fv[0][1] == -1 else "<g>")
        o.append(f'<use href="#ic-{A["who"]}" x="{-sz / 2:g}" y="{-sz}" width="{sz}" height="{sz}"/>')
        for a in A["acts"]:
            if a["kind"] == "hammer":   # FR131: a real hammer in its right hand (it turns with the sprite): down fast, up slowly, a blow every BLOW s
                o.append('<g transform="translate(9 -16)" opacity="0">' + fade_iv([[a["t0"], a["t1"]]])
                         + '<use href="#ic-claw-hammer" x="-11" y="-18.33" width="22" height="22"/>'
                         f'<animateTransform attributeName="transform" type="rotate" additive="sum" values="-25;70;-25" keyTimes="0;0.3;1" dur="{ACT["BLOW"]:g}s"'
                         f' begin="{_f4(a["t0"])}s" repeatCount="indefinite"/></g>')
        o.append("</g>")
        for i, ivs in A["items"].items():
            o.append(look(i, ACT_ITEMS[i]["dx"], ACT_ITEMS[i]["dy"], 1, False, ivs=ivs, box={"door": A.get("doors", {}).get(i), "inside": A.get("inside", {}).get(i)}))
        for text, t0, t1 in A["pops"]:
            o.append(f'<text x="0" y="-46" text-anchor="middle" fill="#3fb950" font-size="12" font-weight="700" opacity="0"{HALO}>{html.escape(text)}' + fade_iv([[t0, t1]]) + "</text>")
        o.append("</g></g>")
    for w in P["W"].values():
        if w.get("over"):
            track_svg(w)
    if sc:
        for text, x, y, t0, t1 in sc["pops"]:   # a sign above a safe
            o.append(f'<text x="{_f4(x)}" y="{_f4(y)}" text-anchor="middle" fill="#3fb950" font-size="12" font-weight="700" opacity="0"{HALO}>{html.escape(text)}' + fade_iv([[t0, t1]]) + "</text>")
    o.append("</g>")
    return "".join(o)


def caption_lines(s):   # FR124: the caption wrapped at 58 characters
    words, lines, cur = (s.get("caption") or "").split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > 58:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(cur)
    return lines


def caption_height(s):
    return 30 + 16 * len(caption_lines(s))


def caption_svg(s, i, x1, y1):   # FR124: the step's caption, a box bottom-right of the drawing (the editor shows the same text in #stepcap)
    lines = caption_lines(s)
    W, lh = 400, 16
    H = caption_height(s)
    x, y = x1 - W - 8, y1 - H - 8
    o = [f'<g class="stepcap"><rect x="{x:.0f}" y="{y:.0f}" width="{W}" height="{H}" rx="6" fill="#14181f" fill-opacity="0.92" stroke="{DIM}"/>',
         f'<text x="{x + 12:.0f}" y="{y + 17:.0f}" font-size="10" fill="{DIM}" letter-spacing="0.6">STEP {i}</text>',
         f'<text x="{x + 58:.0f}" y="{y + 17:.0f}" font-size="12" fill="{FG}" font-weight="700">{html.escape(s.get("title") or s.get("id", ""))}</text>']
    for k, ln in enumerate(lines):
        o.append(f'<text x="{x + 12:.0f}" y="{y + 36 + k * lh:.0f}" font-size="12" fill="{FG}">{html.escape(ln)}</text>')
    o.append("</g>")
    return "".join(o)


def render(d):
    CANON.clear()
    for t in (d.get("meta") or {}).get("toggles") or []:   # FR115: values sharing one layout share their view key
        for g in t.get("sameLayout") or []:
            CANON.setdefault(t["id"], {}).update({v: g[0] for v in g})
    images = (d.get("meta") or {}).get("images") or {}   # FR114: uploaded pictures used as icons
    GH.clear()   # FR118: crossings are recomputed for this view
    toggles = (d.get("meta") or {}).get("toggles", [])
    state = dict(default_state(toggles))
    global STEP_SET   # FR124: render_state.py may ask for one step of this view's story ("step": i in the state)
    step = state.pop("step", None)
    steps_now = [s for s in d.get("steps") or [] if when_ok(s.get("showWhen"), state)]
    STEP_SET = None
    if step is not None and steps_now:
        step = min(max(0, int(step)), len(steps_now) - 1)
        STEP_SET = {i for s in steps_now[:step + 1] for i in (s.get("show") or [])}
    else:
        step = None
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
    if step is not None:
        y1 += caption_height(steps_now[step]) + 16   # FR124: the caption gets its own room below the drawing
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
    NEW = set(steps_now[step].get("show") or []) if step is not None else set()   # FR125: what this step adds fades in (mirrors flow.js NEW_SET)
    if NEW:
        o.append("<style>.stepnew{animation:stepfade .7s ease-out both}@keyframes stepfade{from{opacity:0}}"
                 "@media (prefers-reduced-motion: reduce){.stepnew{animation:none}}</style>")
    wrap_new = lambda i, mark: o.__setitem__(slice(mark, None), ['<g class="stepnew">'] + o[mark:] + ["</g>"]) if i in NEW else None

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
            mark = len(o)
            o.append(icon_svg(n["icon"], ix, iy, s_, PALETTE.get(n.get("color"), PALETTE["note"])[1], images))
            o.append(gatehouse_under_svg(lst, box[rid][2]))
            wrap_new(rid, mark)

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
            epoly[e["id"]] = poly   # FR122: a book's light can ride a tunnel too (your friend's pipe to the internet)
            col = e.get("color") or "#8b949e"
            o.append(mario_pipe_svg(poly, col, e.get("pw"), e.get("casing")))   # FR118: whole — its gates are drawn over it
            mx, my, up = longest_mid(poly) if e.get("via") else (*poly[max(1, len(poly) // 2) - 1], False)
            if up:
                aside = (e.get("pw") or 22) / 2 + 6   # upright stretch: the label goes beside the pipe, not across it
        elif nh_poly:   # NT1–NT4: the link as a see-through sleeve around the tunnel it carries (mirrors flow.js)
            epoly[e["id"]] = list(nh_poly)   # FR124: the step mode's runner can walk a cable
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
        wrap_new(e["id"], mark)   # FR125
        if e.get("z") == "front":
            front.extend(o[mark:])
            del o[mark:]
        elif nh_poly:
            sleeves.extend(o[mark:])
            del o[mark:]
    o.extend(sleeves)
    top_line = min((y for pl in epoly.values() for _, y in pl), default=None)   # FR130: the legend goes above the highest line too
    if top_line is not None and (used_types or used_roles or used_costs):
        y0n = top_line - pad - legend_height(used_types, used_roles, used_costs) - 8
        if int(round(y0n)) < int(round(y0)):   # grow the drawing upwards: the svg tag and the background follow
            y0, h = y0n, h + int(round(y0)) - int(round(y0n))
            o[0] = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{int(round(x0))} {int(round(y0))} {w} {h}" '
                    f'width="{w}" height="{h}" font-family="ui-sans-serif, system-ui, sans-serif">')
            o[2] = f'<rect x="{int(round(x0))}" y="{int(round(y0))}" width="{w}" height="{h}" fill="{bg}"/>'
    nodes_at = len(o)   # FR121: the lights coming into a book go here — over the lines, UNDER the books
    nodes_by = {n["id"]: n for n in nodes}
    def screen_at(nid):   # FR138: a box's screen (the laptop's) — mirrors flow.js screenAt
        n, b = nodes_by.get(nid), box.get(nid)
        q = n and ICON_SCREEN.get(n.get("icon"))
        if not b or not q or not (n.get("nodeType") == "device" and n.get("icon") and not is_container(n, vis, vis_ids, state)):
            return None
        s_, ix, iy, _ = picto_geom(b, str(n.get("label", "")).split("\n"))
        k = s_ / 24.0
        return (ix + q[0] * k, iy + q[1] * k, q[2] * k, q[3] * k)
    SP = (step_plans(steps_now, step, epoly, edges, lambda nid: anc(nid) if nid in box else None,
                     lambda nid: entry_of(nodes_by[nid], state) if nid in nodes_by else "", screen_at)   # FR136: a runner may look a name up in a book
          if step is not None else None)   # FR129: before the books are drawn (a runner may write one)

    rank = lambda n: 2 if active_container(n, state) else (0 if is_container(n, vis, vis_ids, state) else 1)
    open_new = False   # FR125: a box this step adds is wrapped in <g class="stepnew"> (closed at the next box, or after the loop)
    for n in sorted(vis, key=rank):
        if open_new:
            o.append("</g>")
            open_new = False
        if n["id"] in NEW:
            o.append('<g class="stepnew">')
            open_new = True
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
            lt["entry"] = entry_of(n, state)
            wr = next((w for w in SP["P"]["writes"] if w["book"] == n["id"]), None) if SP and SP["P"] else None
            if wr:   # FR129: a runner writes it in this step
                lt["update"], lt["write"] = None, wr
            rd = next((w for w in SP["P"]["reads"] if w["book"] == n["id"]), None) if SP and SP["P"] else None
            if rd:   # FR136: a runner looks it up in this step (it is the lights)
                lt["ask"] = lt["answer"] = lt["update"] = None
                lt["read"] = rd
            if any(a.get("write") == n["id"] for st in steps_now for a in st.get("play") or []):   # FR133: it opens the way it was written
                lt["dir"] = 1
                if step is not None:   # FR134: in the story the runner brought the entry — no update light on any step
                    lt["update"] = None
                if step is not None and not wr and not rd:   # FR136: …and it only opens to be written or read
                    lt["ask"] = lt["answer"] = None
                    lt["still"] = True
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
            sc, scr = ICON_SCREEN.get(n["icon"]), str(n.get("screen") or "")
            if sc and scr.startswith("img:") and images.get(scr[4:]) and n["id"] not in houses:   # FR127: a picture on the icon's screen, under its outline
                k24 = s_ / 24
                o.append(f'<image href="{html.escape(images[scr[4:]], quote=True)}" x="{ix + sc[0] * k24:.1f}" y="{iy + sc[1] * k24:.1f}" '
                         f'width="{sc[2] * k24:.1f}" height="{sc[3] * k24:.1f}" preserveAspectRatio="xMidYMid meet"/>')
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
    if open_new:
        o.append("</g>")
    for rid, lst in houses.items():   # FR118: the gates + moving lights, over the pipes (mirrors flow.js gatehouseGates)
        if rid in vis_ids:
            mark = len(o)
            o.append(gatehouse_gates_svg(rid, lst, quiet=step is not None and not steps_now[step].get("visitors"), story=step is not None))   # FR126 / FR134
            wrap_new(rid, mark)
    o.extend(front)   # FR102: "front" lines go above the gate badges too
    o[nodes_at:nodes_at] = pb_under   # FR121 (mirrors flow.js pbUnder / pbOver)
    o.extend(pb_over)
    if step is not None:   # FR124: the active step's runner (over everything) and its caption, bottom-right
        s = steps_now[step]   # FR125: this step's runners follow on from the previous steps' (the end of one is the start of the next)
        if SP and SP["P"]:
            o.append(actor_svg(SP["P"], lambda nid: anc(nid) if nid in box else None, bg, images))
        o.append(caption_svg(s, step, x1, y1))
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
