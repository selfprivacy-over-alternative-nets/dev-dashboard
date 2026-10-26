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


def through_box(p, q, R, c=None):   # FR93: orthogonal p (on R's outline) → c (R's centre / its gate, FR100) → q — mirrors flow.js throughBox
    c = c or center(R)
    into = lambda z: (c[0], z[1]) if (abs(z[0] - R[0]) < 0.5 or abs(z[0] - R[0] - R[2]) < 0.5) else (z[0], c[1])
    return [p, into(p), c, into(q), q]


def longest_mid(poly):   # FR93: a through-route's label sits on its longest straight stretch
    best = None
    for i in range(1, len(poly)):
        L = ((poly[i][0] - poly[i - 1][0]) ** 2 + (poly[i][1] - poly[i - 1][1]) ** 2) ** 0.5
        if best is None or L > best[0]:
            best = (L, (poly[i][0] + poly[i - 1][0]) / 2.0, (poly[i][1] + poly[i - 1][1]) / 2.0)
    return (best[1], best[2]) if best else poly[0]


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
    if not n or not b or not (n.get("nodeType") == "device" and n.get("icon") and not is_container(n, vis, vis_ids, state)):
        return b
    s_, ix, iy, _ = picto_geom(b, str(n.get("label", "")).split("\n"))
    bb = ICON_BOX.get(n["icon"], (0, 0, 24, 24))
    k = s_ / 24.0
    return (ix + bb[0] * k, iy + bb[1] * k, bb[2] * k, bb[3] * k)


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
    if not pe or role_of(pe) != "tunnel" or pe.get("fromOn") or pe.get("toOn") or not when_ok(pe.get("showWhen"), state):
        return None
    a, b = (anc(pe["from"]), anc(pe["to"])) if anc else (box.get(pe["from"]), box.get(pe["to"]))   # FR92: as drawn
    if not a or not b:
        return None
    if key == "gate":   # FR100: the arrow ends on the open gate's badge
        g = pe.get("gate")
        gb = next((x[1] for x in (vbs(pe) if vbs else []) if x[0] == g), None)
        if not gb:
            return None
        p, r = gate_point(pe, gb), gate_r(pe) + 1
        return (p[0] - r, p[1] - r, 2 * r, 2 * r)
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
    p = e.get("path")
    if isinstance(p, list) and len(p) >= 2:
        return [(q["x"], q["y"]) for q in p]
    if not vb:
        return zroute(a, b, e)
    boxes = [a] + [x[1] for x in vb] + [b]
    ids = [e["from"]] + [x[0] for x in vb] + [e["to"]]
    last = len(boxes) - 2
    pts = []
    for i in range(last + 1):
        o = leg_offsets(e, ids, i)
        leg = zroute(boxes[i], boxes[i + 1], o)
        if i > 0 and side_of(pts[-1], boxes[i]) == side_of(leg[0], boxes[i]):   # dead end → leave on the other axis
            leg = zroute(boxes[i], boxes[i + 1], dict(o, _H=not route_axis(boxes[i], boxes[i + 1], o)))
        c = gate_point(e, boxes[i]) if i > 0 and ids[i] == e.get("gate") else None   # FR100: the pipe crosses at the gate
        pts = leg if i == 0 else pts[:-1] + through_box(pts[-1], leg[0], boxes[i], c) + leg[1:]
    return pts


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
    drawn = [e for e in edges if when_ok(e.get("showWhen"), state) and e["from"] in vis_ids and e["to"] in vis_ids]
    return any(k["id"] in vis_ids and active_container(k, state) == n["id"]
               and any(k["id"] in (e["from"], e["to"]) for e in drawn) for k in nodes)


def render(d):
    toggles = (d.get("meta") or {}).get("toggles", [])
    state = default_state(toggles)
    nodes = d.get("nodes", [])
    edges = d.get("edges", [])
    by_id = {n["id"]: n for n in nodes}
    vis = [n for n in nodes if when_ok(n.get("showWhen"), state)]
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

    gates = []   # FR93: open-port badges, drawn after the device icons
    front = []   # FR96: z "front" lines, drawn above the boxes (below the badges) — mirrors flow.js gFront
    for e in edges:
        if not when_ok(e.get("showWhen"), state):
            continue
        mark = len(o)
        anc = lambda nid: anchor_box(by_id.get(nid), box.get(nid), vis, vis_ids, state)   # FR92: a pictogram's drawn icon
        vbs = lambda ed: [(i, anchor_box(by_id[i], box[i], vis, vis_ids, state)) for i in (ed.get("via") or []) if i in box]   # FR93: (id, box)
        a = pipe_spot_box(e["fromOn"], edges, box, state, anc, vbs) if e.get("fromOn") else anc(e["from"])
        b = pipe_spot_box(e["toOn"], edges, box, state, anc, vbs) if e.get("toOn") else anc(e["to"])
        if not a or not b:
            continue
        kind = e.get("kind", "plain")
        role = role_of(e)
        tube = role == "tunnel"
        badge = None
        if tube:
            poly = _dedupe(pipe_poly(a, b, e, vbs(e)))
            col = e.get("color") or "#8b949e"
            g = e.get("gate")
            gs = gate_split(poly, e, anc(g) if g and g in box and g in (e.get("via") or []) else None)
            if gs:   # FR93: port-forward = the pipe is broken open at the router; the badge is drawn above the icons
                o.append(mario_pipe_svg(gs[1], col, e.get("pw"), e.get("casing")))
                o.append(mario_pipe_svg(gs[2], col, e.get("pw"), e.get("casing")))
                gates.append((gs[0], col, gate_r(e)))
            else:
                o.append(mario_pipe_svg(poly, col, e.get("pw"), e.get("casing")))
            mx, my = longest_mid(poly) if e.get("via") else poly[max(1, len(poly) // 2) - 1]
        else:
            # arrows connect side-MIDPOINT → side-midpoint, straight or 90° only (mirrors flow.js)
            poly = _dedupe(pipe_poly(a, b, e))
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
        if e.get("label"):
            dy = 18 if tube else (EBADGE / 2 + 12 if badge else 4)
            halo = HALO if badge else ""
            o.append(f'<text x="{mx:.1f}" y="{my - dy:.1f}" text-anchor="middle" font-size="11"{halo} fill="{FG if tube else DIM}">{html.escape(e["label"])}</text>')
        if e.get("z") == "front":
            front.extend(o[mark:])
            del o[mark:]

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
        if n.get("nodeType") == "device" and n.get("icon") and not is_container(n, vis, vis_ids, state):
            # FR89: a device IS its icon (pictogram) — no box drawn; the box still sizes + anchors it
            s_, ix, iy, ty = picto_geom(bx, lines)
            o.append(f'<use href="#ic-{n["icon"]}" x="{ix:.1f}" y="{iy:.1f}" width="{s_:.1f}" height="{s_:.1f}" style="color:{stroke}"/>')
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
            o.append(f'<use href="#ic-{n["icon"]}" x="{cx - isz / 2:.1f}" y="{bx[1] + 6:.0f}" width="{isz}" height="{isz}" style="color:{stroke}"/>')
            ty = bx[1] + isz + 18
        else:
            ty = bx[1] + bx[3] / 2.0 + 4
        start_y = ty if n.get("icon") else ty - (len(lines) - 1) * 8
        for i, ln in enumerate(lines):
            o.append(f'<text x="{cx:.1f}" y="{start_y + i * 15:.1f}" text-anchor="middle" font-size="12" fill="{FG}">{html.escape(ln)}</text>')
        if n.get("childDiagram"):
            o.append(f'<text x="{bx[0] + bx[2] - max(8, r * 0.7):.0f}" y="{bx[1] + 14:.0f}" text-anchor="end" font-size="11" fill="{DIM}">⊕ open</text>')
    for c, col, gr in gates:   # FR93: the gap in the pipe shows an opened port (mirrors flow.js)
        s = gr * 1.5
        o.append(f'<circle cx="{c[0]:.1f}" cy="{c[1]:.1f}" r="{gr - 1:g}" fill="#0b0e14" stroke="{col}" stroke-width="3"/>'
                 f'<use href="#ic-barrier" x="{c[0] - s / 2:.1f}" y="{c[1] - s / 2:.1f}" width="{s:g}" height="{s:g}" style="color:{col}"/>')
    o.extend(front)   # FR102: "front" lines go above the gate badges too
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
