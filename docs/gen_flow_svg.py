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
    "red": ("#2a1113", "#e5484d"),
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


def zroute(a, b):   # orthogonal route anchored at side-MIDPOINTS (H/V, 90° only), snap-straight — mirrors flow.js
    cax, cay, cbx, cby = a[0] + a[2] / 2, a[1] + a[3] / 2, b[0] + b[2] / 2, b[1] + b[3] / 2
    if abs(cbx - cax) >= abs(cby - cay):
        sx = a[0] + a[2] if cbx >= cax else a[0]
        ex = b[0] if cbx >= cax else b[0] + b[2]
        if abs(cay - cby) <= EDGE_SNAP:
            y = (cay + cby) / 2
            return [(sx, y), (ex, y)]
        mx = (sx + ex) / 2
        return [(sx, cay), (mx, cay), (mx, cby), (ex, cby)]
    sy = a[1] + a[3] if cby >= cay else a[1]
    ey = b[1] if cby >= cay else b[1] + b[3]
    if abs(cax - cbx) <= EDGE_SNAP:
        x = (cax + cbx) / 2
        return [(x, sy), (x, ey)]
    my = (sy + ey) / 2
    return [(cax, sy), (cax, my), (cbx, my), (cbx, ey)]


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


def pipe_poly(a, b, e):
    p = e.get("path")
    if isinstance(p, list) and len(p) >= 2:
        return [(q["x"], q["y"]) for q in p]
    return zroute(a, b)


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
    w, h = int(round(x1 - x0)), int(round(y1 - y0))

    o = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{int(round(x0))} {int(round(y0))} {w} {h}" '
        f'width="{w}" height="{h}" font-family="ui-sans-serif, system-ui, sans-serif">',
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{DIM}"/></marker>' + icon_defs() + "</defs>",
        f'<rect x="{int(round(x0))}" y="{int(round(y0))}" width="{w}" height="{h}" fill="{(d.get("meta") or {}).get("background") or "#0b0e14"}"/>',
    ]
    _gy = (d.get("meta") or {}).get("ground")
    if isinstance(_gy, (int, float)):
        o.append(ground_svg(_gy, int(round(x0)), int(round(x1))))

    for e in edges:
        if not when_ok(e.get("showWhen"), state):
            continue
        a, b = box.get(e["from"]), box.get(e["to"])
        if not a or not b:
            continue
        kind = e.get("kind", "plain")
        if kind == "pipe":
            poly = _dedupe(pipe_poly(a, b, e))
            o.append(mario_pipe_svg(poly, e.get("color") or "#8b949e", e.get("pw"), e.get("casing")))
            mp = poly[max(1, len(poly) // 2) - 1]
            mx, my = mp[0], mp[1]
        else:
            # arrows connect side-MIDPOINT → side-midpoint, straight or 90° only (mirrors flow.js)
            poly = _dedupe(pipe_poly(a, b, e))
            lw = e.get("lw") if isinstance(e.get("lw"), (int, float)) else (3 if kind in ("cable", "lan") else 2)
            _dir = e.get("dir", "to")
            ah = max(e.get("ah") if isinstance(e.get("ah"), (int, float)) else 12, lw * 2.5)   # head never thinner than the line
            wp = poly   # line stops at the head's base (mirrors flow.js trimEnd)
            if _dir in ("to", "both"):
                wp = trim_end(wp, "end", ah * 0.8)
            if _dir in ("from", "both"):
                wp = trim_end(wp, "start", ah * 0.8)
            d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in wp)
            dash = ' stroke-dasharray="6 4"' if kind in ("wifi", "tunnel", "tor") else ""
            stroke = e.get("color") or DIM
            o.append(f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{lw}"{dash}/>')
            fb = (center(b)[0] - center(a)[0], center(b)[1] - center(a)[1])
            if _dir in ("to", "both"):
                o.append(arrow_head(poly, "end", ah, stroke, fb))
            if _dir in ("from", "both"):
                o.append(arrow_head(poly, "start", ah, stroke, fb))
            mx, my = mid_of_poly(poly)
            if kind in EDGE_ICON:
                o.append(f'<use href="#ic-{EDGE_ICON[kind]}" x="{mx - 9:.1f}" y="{my - 20:.1f}" width="18" height="18" style="color:#8b949e"/>')
        if e.get("label"):
            dy = 18 if kind == "pipe" else 4
            o.append(f'<text x="{mx:.1f}" y="{my - dy:.1f}" text-anchor="middle" font-size="11" fill="{FG if kind == "pipe" else DIM}">{html.escape(e["label"])}</text>')

    rank = lambda n: 2 if active_container(n, state) else (0 if is_container(n, vis, vis_ids, state) else 1)
    for n in sorted(vis, key=rank):
        fill, stroke = PALETTE.get(n.get("color"), PALETTE["note"])
        bx = box[n["id"]]
        see = n.get("seeThrough") or auto_see_through(n, vis, edges, vis_ids, state)
        op = ' fill-opacity="0.3"' if see else (' fill-opacity="0.55"' if is_container(n, vis, vis_ids, state) else "")
        o.append(f'<rect x="{bx[0]:.0f}" y="{bx[1]:.0f}" width="{bx[2]:.0f}" height="{bx[3]:.0f}" rx="8" ry="8" '
                 f'fill="{fill}"{op} stroke="{stroke}" stroke-width="2"/>')
        cx = bx[0] + bx[2] / 2.0
        if n.get("icon"):
            o.append(f'<use href="#ic-{n["icon"]}" x="{cx - 12:.1f}" y="{bx[1] + 8:.0f}" width="24" height="24" style="color:{stroke}"/>')
            ty = bx[1] + 40
        else:
            ty = bx[1] + bx[3] / 2.0 + 4
        lines = str(n.get("label", "")).split("\n")
        start_y = ty if n.get("icon") else ty - (len(lines) - 1) * 8
        for i, ln in enumerate(lines):
            o.append(f'<text x="{cx:.1f}" y="{start_y + i * 15:.1f}" text-anchor="middle" font-size="12" fill="{FG}">{html.escape(ln)}</text>')
        if n.get("childDiagram"):
            o.append(f'<text x="{bx[0] + bx[2] - 8:.0f}" y="{bx[1] + 14:.0f}" text-anchor="end" font-size="11" fill="{DIM}">⊕ open</text>')
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
