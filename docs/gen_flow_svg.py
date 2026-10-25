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


def zroute(a, b):   # orthogonal border-to-border route (H/V, 90° only) — mirrors flow.js zRoute
    cax, cay, cbx, cby = a[0] + a[2] / 2, a[1] + a[3] / 2, b[0] + b[2] / 2, b[1] + b[3] / 2
    if abs(cbx - cax) >= abs(cby - cay):
        sx = a[0] + a[2] if cbx >= cax else a[0]
        ex = b[0] if cbx >= cax else b[0] + b[2]
        mx = (sx + ex) / 2
        return [(sx, cay), (mx, cay), (mx, cby), (ex, cby)]
    sy = a[1] + a[3] if cby >= cay else a[1]
    ey = b[1] if cby >= cay else b[1] + b[3]
    my = (sy + ey) / 2
    return [(cax, sy), (cax, my), (cbx, my), (cbx, ey)]


def pipe_poly(a, b, e):
    p = e.get("path")
    if isinstance(p, list) and len(p) >= 2:
        return [(q["x"], q["y"]) for q in p]
    return zroute(a, b)


def mario_pipe_svg(poly, color):
    pts = _dedupe(poly)
    if len(pts) < 2:
        return ""
    dark, light, OL, BODY = shade(color, 0.5), shade(color, 1.55), "#0a140a", 22
    d = "M " + " L ".join(f"{p[0]:.1f} {p[1]:.1f}" for p in pts)
    out = [f'<path d="{d}" fill="none" stroke="{OL}" stroke-width="{BODY + 6}" stroke-linejoin="round"/>',
           f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{BODY}" stroke-linejoin="round"/>']
    ln = lambda x1, y1, x2, y2, s, w: f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{s}" stroke-width="{w}"/>'
    for i in range(1, len(pts)):
        A, B = pts[i - 1], pts[i]
        if abs(A[1] - B[1]) < 0.5:
            out.append(ln(A[0], A[1] - 6, B[0], B[1] - 6, light, 4)); out.append(ln(A[0], A[1] + 7, B[0], B[1] + 7, dark, 4))
        else:
            out.append(ln(A[0] - 6, A[1], B[0] - 6, B[1], light, 4)); out.append(ln(A[0] + 7, A[1], B[0] + 7, B[1], dark, 4))
    def rim(p, q):
        dx, dy = p[0] - q[0], p[1] - q[1]
        L = (dx * dx + dy * dy) ** 0.5 or 1.0
        px, py = -dy / L * 19, dx / L * 19
        return (ln(p[0] - px, p[1] - py, p[0] + px, p[1] + py, OL, 18)
                + ln(p[0] - px * 0.9, p[1] - py * 0.9, p[0] + px * 0.9, p[1] + py * 0.9, color, 13)
                + ln(p[0] - px * 0.9, p[1] - py * 0.9, p[0] + px * 0.9, p[1] + py * 0.9, light, 3))
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


def rbox(n, nodes_by_id, vis_ids, state, depth=0):
    x, y, w, h = n["x"], n["y"], n["w"], n["h"]
    c = active_container(n, state)
    if c and depth < 6 and c in nodes_by_id:
        p = nodes_by_id[c]
        x = p["x"] + n.get("cdx", 16)
        y = p["y"] + n.get("cdy", 56)
    for k in nodes_by_id.values():
        if k["id"] in vis_ids and active_container(k, state) == n["id"]:
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
            o.append(mario_pipe_svg(poly, e.get("color") or "#8b949e"))
            mp = poly[max(1, len(poly) // 2) - 1]
            mx, my = mp[0], mp[1]
        else:
            p1, p2 = border(a, b), border(b, a)
            sw = 3 if kind in ("cable", "lan") else 1.6
            dash = ' stroke-dasharray="6 4"' if kind in ("wifi", "tunnel", "tor") else ""
            stroke = e.get("color") or DIM
            o.append(f'<line x1="{p1[0]:.1f}" y1="{p1[1]:.1f}" x2="{p2[0]:.1f}" y2="{p2[1]:.1f}" '
                     f'stroke="{stroke}" stroke-width="{sw}"{dash} marker-end="url(#arrow)"/>')
            mx, my = (p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0
            if kind in EDGE_ICON:
                o.append(f'<use href="#ic-{EDGE_ICON[kind]}" x="{mx - 9:.1f}" y="{my - 20:.1f}" width="18" height="18" style="color:#8b949e"/>')
        if e.get("label"):
            dy = 18 if kind == "pipe" else 4
            o.append(f'<text x="{mx:.1f}" y="{my - dy:.1f}" text-anchor="middle" font-size="11" fill="{FG if kind == "pipe" else DIM}">{html.escape(e["label"])}</text>')

    rank = lambda n: 2 if active_container(n, state) else (0 if is_container(n, vis, vis_ids, state) else 1)
    for n in sorted(vis, key=rank):
        fill, stroke = PALETTE.get(n.get("color"), PALETTE["note"])
        bx = box[n["id"]]
        op = ' fill-opacity="0.3"' if n.get("seeThrough") else (' fill-opacity="0.55"' if is_container(n, vis, vis_ids, state) else "")
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
