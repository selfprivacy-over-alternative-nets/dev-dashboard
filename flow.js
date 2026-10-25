/* flow.js v2 — zero-dependency SVG diagram editor with toggles, conditional visibility, containment,
 * device icons, edge kinds, and drill-down. Source of truth = docs/diagrams/<id>.json (flow_requirements
 * .md FR8, FR26-FR41). GUI drag-edits AND Claude text-edits share ONE deterministic file.
 *   - localhost (`./dash serve`): Save POSTs to /api/diagram/<id> → written to disk → Claude reads it.
 *   - static Pages: no backend → Save = download + "copy JSON".
 */
(() => {
  const SVGNS = "http://www.w3.org/2000/svg";
  const DIAG_DIR = "docs/diagrams";

  // Shared colour key (requirements.md req 165).
  const PALETTE = {
    host:    { fill: "#13233a", stroke: "#58a6ff", label: "your computer" },
    cli:     { fill: "#1c1430", stroke: "#a371f7", label: "cli step" },
    web:     { fill: "#1a1d23", stroke: "#8b949e", label: "website" },
    target:  { fill: "#2a1d10", stroke: "#e3882d", label: "server/target" },
    created: { fill: "#10231a", stroke: "#3fb950", label: "created / reachable" },
    input:   { fill: "#2a2410", stroke: "#d6a015", label: "input" },
    note:    { fill: "#14181f", stroke: "#6e7681", label: "note" },
    red:     { fill: "#2a1113", stroke: "#e5484d", label: "alert / name-only" },
  };
  const COLOR_KEYS = Object.keys(PALETTE);
  const ICONS = ["laptop", "server", "router", "cloud", "phone", "usb", "ethernet", "wifi", "safe", "relay",
    "tor", "onion", "gear", "block", "pipe", "gate", "warn", "tag", "cart", "tornode"];
  const EDGE_KINDS = ["plain", "cable", "wifi", "usb", "lan", "internet", "tunnel", "tor"];

  const $ = (id) => document.getElementById(id);
  const svg = $("svg"), gViewport = $("viewport"), gNodes = $("nodes"), gEdges = $("edges");

  const S = {
    id: null, data: null, index: { diagrams: [], root: "overview" },
    backend: false, dirty: false,
    sel: null, selEdge: null,
    toggle: {},                       // active toggle state {toggleId: value}
    view: { x: 40, y: 40, k: 1 },
    mode: "idle", pending: null, drag: null, panStart: null, resize: null, draw: null, rubber: null, ctrl: false,
    panelOff: { x: 0, y: 0 },          // user drag offset of the arrow box from its default anchor (FR78)
  };

  /* ---------- deterministic serialisation (mirrors the Python writer in `dash`) ---------- */
  function sortDeep(v) {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]); return o;
    }
    return v;
  }
  function serialize(data) {
    const d = JSON.parse(JSON.stringify(data));
    for (const n of d.nodes) for (const k of ["x", "y", "w", "h", "cdx", "cdy"])
      if (typeof n[k] === "number") n[k] = Math.round(n[k]);
    return JSON.stringify(sortDeep(d), null, 2) + "\n";
  }

  function status(m) { $("status").innerHTML = m; }
  function markDirty(on) { S.dirty = on; document.body.classList.toggle("dirty", on); }
  function node(id) { return S.data.nodes.find((n) => n.id === id); }
  function nodeAtWorld(wp) {   // topmost visible node whose box contains the world point (for edge-draw targeting)
    const hit = S.data.nodes.filter(visible).filter((n) => { const b = rbox(n);
      return wp.x >= b.x && wp.x <= b.x + b.w && wp.y >= b.y && wp.y <= b.y + b.h; });
    return hit.length ? hit[hit.length - 1].id : null;
  }

  /* ---------- toggle logic (FR34 + FR29 dependent options) ---------- */
  function toggles() { return (S.data.meta && S.data.meta.toggles) || []; }
  function activeOptions(t) {
    let opts = t.options || [];
    if (t.optionsWhen) {
      for (const dep in t.optionsWhen) {
        const allowed = t.optionsWhen[dep][S.toggle[dep]] || [];
        opts = opts.filter((o) => allowed.includes(o.value));
      }
    }
    return opts;
  }
  function normalizeToggles() {
    // two passes so dependent option lists settle
    for (let pass = 0; pass < 2; pass++) {
      for (const t of toggles()) {
        const opts = activeOptions(t);
        if (!opts.length) { S.toggle[t.id] = null; continue; }
        if (!opts.some((o) => o.value === S.toggle[t.id]))
          S.toggle[t.id] = t.default && opts.some((o) => o.value === t.default) ? t.default : opts[0].value;
      }
    }
  }
  function whenMatches(when) {
    if (!when) return true;
    for (const k in when) if (!when[k].includes(S.toggle[k])) return false;
    return true;
  }
  const visible = (o) => whenMatches(o.showWhen);
  const activeContainerOf = (n) => (n.container && whenMatches(n.containerWhen)) ? n.container : null;

  /* ---------- geometry with containment (FR36) ---------- */
  function rbox(n, depth) {
    depth = depth || 0;
    let x = n.x, y = n.y, w = n.w, h = n.h;
    const c = activeContainerOf(n);
    if (c && depth < 6) { const p = node(c); if (p) {
      if (n.snapSide) { const m = sideMid(rbox(p, depth + 1), n.snapSide); x = m.x - w / 2; y = m.y - h / 2; }   // FR75: centre pinned on the parent's side-midpoint
      else { x = p.x + (typeof n.cdx === "number" ? n.cdx : 16);
        y = p.y + (typeof n.cdy === "number" ? n.cdy : 56); } } }
    // grow to enclose active contained children (if this node is a container); edge-snapped ones sit ON the border
    for (const k of S.data.nodes) {
      if (!visible(k) || activeContainerOf(k) !== n.id || k.snapSide) continue;
      const r = rbox(k, depth + 1);
      w = Math.max(w, r.x + r.w + 14 - x);
      h = Math.max(h, r.y + r.h + 14 - y);
    }
    return { x, y, w, h };
  }
  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  function sideMid(b, s) {
    return s === "n" ? { x: b.x + b.w / 2, y: b.y } : s === "s" ? { x: b.x + b.w / 2, y: b.y + b.h }
         : s === "w" ? { x: b.x, y: b.y + b.h / 2 } : { x: b.x + b.w, y: b.y + b.h / 2 };
  }
  function onSide(b, P, s) {   // FR75: is box b dropped ON side s of P? (line through b's middle half) → perp distance, else -1
    const c = center(b);
    if (s === "n" || s === "s") { const ly = s === "n" ? P.y : P.y + P.h, d = Math.abs(c.y - ly);
      return d <= b.h / 4 && c.x >= P.x && c.x <= P.x + P.w ? d : -1; }
    const lx = s === "w" ? P.x : P.x + P.w, d = Math.abs(c.x - lx);
    return d <= b.w / 4 && c.y >= P.y && c.y <= P.y + P.h ? d : -1;
  }
  function border(fromB, toB) {
    const a = center(fromB), b = center(toB);
    let dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) return a;
    const t = Math.min(fromB.w / 2 / Math.abs(dx || 1e-9), fromB.h / 2 / Math.abs(dy || 1e-9));
    return { x: a.x + dx * t, y: a.y + dy * t };
  }
  function toWorld(ev) {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left - S.view.x) / S.view.k, y: (ev.clientY - r.top - S.view.y) / S.view.k };
  }

  /* ---------- render ---------- */
  function applyView() { gViewport.setAttribute("transform", `translate(${S.view.x},${S.view.y}) scale(${S.view.k})`);
    if (S.selEdge && S.data) updateEdgePanel(); }   // zoom/pan/fit: the arrow box follows its arrow (FR78)
  function el(name, attrs, parent) {
    const e = document.createElementNS(SVGNS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e); return e;
  }
  function isContainer(n) { return S.data.nodes.some((k) => visible(k) && activeContainerOf(k) === n.id); }
  const edgeDrawn = (e) => visible(e) && [e.from, e.to].every((id) => { const x = node(id); return x && visible(x); });
  // FR76: a box holding a child that has pipes/arrows attached turns translucent automatically (derived, not saved)
  const autoSeeThrough = (n) => S.data.nodes.some((k) => visible(k) && activeContainerOf(k) === n.id &&
    S.data.edges.some((e) => (e.from === k.id || e.to === k.id) && edgeDrawn(e)));

  // Super-Mario-style warp pipes (FR42/FR52): ORTHOGONAL routing (H/V, 90° elbows — never diagonal),
  // authentic lip + shaded body + black outline. Routing: explicit e.path if given, else an auto Z-route.
  function shade(hex, f) {
    const m = (hex || "#8b949e").replace("#", "");
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    const h = (v) => Math.max(0, Math.min(255, Math.round(v * f))).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }
  function dedupe(pts) { const o = []; for (const p of pts) { const q = o[o.length - 1]; if (!q || Math.abs(q.x - p.x) > 0.5 || Math.abs(q.y - p.y) > 0.5) o.push({ x: p.x, y: p.y }); } return o; }
  const EDGE_SNAP = 28;    // within this perpendicular gap a near-aligned connector snaps to a straight line
  const ofs = (v) => typeof v === "number" ? v : 0;
  const zRoute = (a, b, e) => zRouteSegs(a, b, e || {}).pts;
  // Orthogonal route anchored at side-MIDPOINTS (H-V-H / V-H-V), 90° only, snap-straight. FR79: segments are
  // draggable; the drag is stored as offsets on the edge so the route stays attached when boxes move:
  // so/eo = start/end attachment shifted along its side, mo = middle elbow shifted, ss/es = where the extra
  // stub leaves/enters the box once the line is dragged past the side's extent (one more 90° bend).
  // segs[i] names the offset that segment i drives (for the drag); u = main axis, v = cross axis.
  function zRouteSegs(a, b, e) {
    const H = Math.abs(b.x + b.w / 2 - a.x - a.w / 2) >= Math.abs(b.y + b.h / 2 - a.y - a.h / 2);
    const U = (q) => H ? { u: q.x, v: q.y, wu: q.w, wv: q.h } : { u: q.y, v: q.x, wu: q.h, wv: q.w };
    const A = U(a), B = U(b), cau = A.u + A.wu / 2, cbu = B.u + B.wu / 2;
    const su = cbu >= cau ? A.u + A.wu : A.u, eu = cbu >= cau ? B.u : B.u + B.wu;
    const sv = A.v + A.wv / 2 + ofs(e.so), ev = B.v + B.wv / 2 + ofs(e.eo);
    let pts, segs;   // snap-straight only when both ends share one offset: a set attachment (FR81) stays exact
    if (Math.abs(sv - ev) <= EDGE_SNAP && ofs(e.so) === ofs(e.eo)) { const v = (sv + ev) / 2; pts = [[su, v], [eu, v]]; segs = ["so+eo"]; }
    else { const mu = (su + eu) / 2 + ofs(e.mo); pts = [[su, sv], [mu, sv], [mu, ev], [eu, ev]]; segs = ["so", "mo", "eo"]; }
    const stub = (q, v, o) => {   // v beyond the box's side → enter via its top/bottom (left/right) side instead
      if (v >= q.v && v <= q.v + q.wv) return null;
      const u = q.u + q.wu / 2 + Math.max(-q.wu / 2, Math.min(q.wu / 2, o));
      return [[u, v < q.v ? q.v : q.v + q.wv], [u, v]];
    };
    const s0 = stub(A, pts[0][1], ofs(e.ss));
    if (s0) { pts[0] = s0[1]; pts.unshift(s0[0]); segs.unshift("ss"); }
    const s1 = stub(B, pts[pts.length - 1][1], ofs(e.es));
    if (s1) { pts[pts.length - 1] = s1[1]; pts.push(s1[0]); segs.push("es"); }
    return { pts: pts.map(([u, v]) => H ? { x: u, y: v } : { x: v, y: u }), segs, H, cv: [A.v + A.wv / 2, B.v + B.wv / 2] };
  }
  function drawArrowHead(parent, poly, whichEnd, size, color, fb) {
    if (!poly || !poly.length) return;
    const end = whichEnd === "end";
    const tip = end ? poly[poly.length - 1] : poly[0];
    const prev = end ? poly[poly.length - 2] : poly[1];
    let dx, dy;
    if (prev) { dx = tip.x - prev.x; dy = tip.y - prev.y; }   // point toward the tip (into the box)
    else { dx = end ? fb.x : -fb.x; dy = end ? fb.y : -fb.y; }   // degenerate path → use centre-to-centre
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const bx = tip.x - dx * size, by = tip.y - dy * size, px = -dy, py = dx, half = size * 0.55;
    el("polygon", { points: `${tip.x},${tip.y} ${bx + px * half},${by + py * half} ${bx - px * half},${by - py * half}`, fill: color }, parent);
  }
  function trimEnd(poly, whichEnd, len) {   // shorten the last (or first) segment by len, never past its other end
    if (!poly || poly.length < 2) return poly;
    const p = poly.map((q) => ({ x: q.x, y: q.y })), end = whichEnd === "end";
    const i = end ? p.length - 1 : 0, j = end ? p.length - 2 : 1;
    const dx = p[i].x - p[j].x, dy = p[i].y - p[j].y, L = Math.hypot(dx, dy);
    if (!L) return p;
    const t = Math.min(len, L) / L; p[i] = { x: p[i].x - dx * t, y: p[i].y - dy * t };
    return p;
  }
  function midOfPoly(poly) {   // point at half the total polyline length (for label/icon placement)
    if (!poly || poly.length < 2) return (poly && poly[0]) || { x: 0, y: 0 };
    const seg = []; let total = 0;
    for (let i = 1; i < poly.length; i++) { const L = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y); seg.push(L); total += L; }
    let half = total / 2;
    for (let i = 1; i < poly.length; i++) {
      if (half <= seg[i - 1]) { const t = seg[i - 1] ? half / seg[i - 1] : 0;
        return { x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * t, y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * t }; }
      half -= seg[i - 1];
    }
    return poly[poly.length - 1];
  }
  const pipePoly = (aBox, bBox, e) => (Array.isArray(e.path) && e.path.length >= 2) ? e.path.map((p) => ({ x: p.x, y: p.y })) : zRoute(aBox, bBox, e);
  // bodyW (edge.pw, default 22) = pipe-body width. A wide translucent casing + two thin inner pipes drawn
  // on the same lane = "two tunnels within one tunnel" (FR59, the IPv4/IPv6 nesting). rimOnly skips the
  // body so a casing can be drawn without hiding the inner pipes behind it.
  function drawMarioPipe(parent, poly, color, bodyW, casing) {
    const pts = dedupe(poly); if (pts.length < 2) return;
    const W = bodyW || 22, dark = shade(color, 0.5), light = shade(color, 1.55), OL = "#0a140a";
    const off = W * 0.3, sw = Math.max(3, W * 0.18), rimH = W * 0.86, rimOL = W * 0.82, rimC = W * 0.59, rimL = Math.max(2, W * 0.14);
    const ln = (x1, y1, x2, y2, s, w, op) => { const l = el("line", { x1, y1, x2, y2, stroke: s, "stroke-width": w }, parent); if (op != null) l.setAttribute("stroke-opacity", op); return l; };
    const d = "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L ");
    el("path", { d, fill: "none", stroke: OL, "stroke-width": W + 6, "stroke-linejoin": "round" }, parent);
    const bodyEl = el("path", { d, fill: "none", stroke: color, "stroke-width": W, "stroke-linejoin": "round" }, parent);
    if (casing) bodyEl.setAttribute("stroke-opacity", "0.35");
    for (let i = 1; i < pts.length; i++) {
      const A = pts[i - 1], B = pts[i], cop = casing ? 0.5 : null;
      if (Math.abs(A.y - B.y) < 0.5) { ln(A.x, A.y - off, B.x, B.y - off, light, sw, cop); ln(A.x, A.y + off, B.x, B.y + off, dark, sw, cop); }
      else { ln(A.x - off, A.y, B.x - off, B.y, light, sw, cop); ln(A.x + off, A.y, B.x + off, B.y, dark, sw, cop); }
    }
    const rim = (p, q) => { const dx = p.x - q.x, dy = p.y - q.y, L = Math.hypot(dx, dy) || 1, px = -dy / L * rimH, py = dx / L * rimH;
      ln(p.x - px, p.y - py, p.x + px, p.y + py, OL, rimOL); ln(p.x - px * 0.9, p.y - py * 0.9, p.x + px * 0.9, p.y + py * 0.9, color, rimC);
      ln(p.x - px * 0.9, p.y - py * 0.9, p.x + px * 0.9, p.y + py * 0.9, light, rimL); };
    rim(pts[0], pts[1]); rim(pts[pts.length - 1], pts[pts.length - 2]);
  }
  // FR82: three block types, told apart by SHAPE (colour keeps its palette meaning). Untyped = plain box.
  const NODE_TYPES = {
    action: { label: "action — something you do",  rx: (b) => Math.min(b.h / 2, 26), sw: 2 },
    info:   { label: "information",                 rx: () => 8, sw: 1.6, dash: "2 4" },
    device: { label: "(hardware) device",           rx: () => 2, sw: 3.5 },
  };
  const DOG = 14;   // folded-corner size of an info block
  function drawDogEar(parent, b, pal) {   // "document" corner at the top-right of an info block
    const x = b.x + b.w, y = b.y;
    el("path", { d: `M ${x - DOG} ${y} L ${x} ${y + DOG} L ${x} ${y} Z`, fill: (S.data.meta && S.data.meta.background) || "#0b0e14" }, parent);
    el("path", { d: `M ${x - DOG} ${y} L ${x - DOG} ${y + DOG} L ${x} ${y + DOG} Z`, fill: pal.stroke, "fill-opacity": 0.5,
                 stroke: pal.stroke, "stroke-width": 1.2 }, parent);
  }
  function buildLegend() {   // small key, top-right of the canvas; only on diagrams that use block types
    const host = $("legend"), used = new Set(S.data.nodes.map((n) => n.nodeType).filter((t) => NODE_TYPES[t]));
    host.hidden = !used.size; host.textContent = "";
    for (const k of Object.keys(NODE_TYPES)) {
      const T = NODE_TYPES[k], row = document.createElement("div"); row.className = "lg";
      const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("width", 34); s.setAttribute("height", 18);
      const b = { x: 1.5, y: 1.5, w: 31, h: 15 }, r = Math.min(T.rx(b), 7.5);
      const rc = el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: r, ry: r, fill: "#14181f", stroke: "#8b949e" }, s);
      rc.style.strokeWidth = Math.min(T.sw, 2.5); if (T.dash) rc.style.strokeDasharray = T.dash;
      if (k === "info") el("path", { d: `M ${b.x + b.w - 6} ${b.y} L ${b.x + b.w - 6} ${b.y + 6} L ${b.x + b.w} ${b.y + 6} Z`, fill: "#8b949e" }, s);
      const t = document.createElement("span"); t.textContent = T.label;
      row.append(s, t); host.appendChild(row);
    }
  }
  function drawGround(parent, gy) {   // SMB brick ground strip (FR53)
    const x0 = -4000, W = 16000, H = 90, mortar = "#5c2f0d";
    el("rect", { x: x0, y: gy, width: W, height: H, fill: "#9a5523" }, parent);
    el("rect", { x: x0, y: gy, width: W, height: 5, fill: mortar }, parent);
    el("line", { x1: x0, y1: gy + 44, x2: x0 + W, y2: gy + 44, stroke: mortar, "stroke-width": 3 }, parent);
    for (let bx = x0; bx < x0 + W; bx += 56) el("line", { x1: bx, y1: gy, x2: bx, y2: gy + 44, stroke: mortar, "stroke-width": 3 }, parent);
    for (let bx = x0 + 28; bx < x0 + W; bx += 56) el("line", { x1: bx, y1: gy + 44, x2: bx, y2: gy + H, stroke: mortar, "stroke-width": 3 }, parent);
  }

  function render() {
    gEdges.textContent = ""; gNodes.textContent = ""; applyView();
    svg.style.background = (S.data.meta && S.data.meta.background) ? S.data.meta.background : "";
    if (S.data.meta && typeof S.data.meta.ground === "number") drawGround(gEdges, S.data.meta.ground);
    const vis = S.data.nodes.filter(visible);
    const boxOf = {}; for (const n of vis) boxOf[n.id] = rbox(n);

    let selPoly = null;
    for (const e of S.data.edges) {
      if (!visible(e)) continue;
      const ends = edgeEnds(e, boxOf); if (!ends) continue;
      const { a, b } = ends, kind = e.kind || "plain";
      const g = el("g", { class: "edge k-" + kind + (S.selEdge === e.id ? " sel" : ""), "data-edge": e.id }, gEdges);
      let mx, my;
      if (kind === "pipe") {
        const poly = dedupe(pipePoly(a, b, e));
        el("path", { class: "hit", d: "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "), fill: "none" }, g);
        drawMarioPipe(g, poly, e.color || "#8b949e", e.pw, e.casing);
        if (S.selEdge === e.id) selPoly = poly;
        const m = poly[Math.max(1, Math.floor(poly.length / 2)) - 1]; mx = m.x; my = m.y;
      } else {
        // arrows connect side-MIDPOINT → side-midpoint, straight or 90° only, snap-to-straight (via zRoute)
        const poly = dedupe(pipePoly(a, b, e));
        const lw = typeof e.lw === "number" ? e.lw : (kind === "cable" || kind === "lan" ? 3 : 2);
        const dir = e.dir || "to", ah = Math.max(typeof e.ah === "number" ? e.ah : 12, lw * 2.5);   // to=A→B, from=B→A, both=A↔B; head never thinner than the line
        let wp = poly;   // line stops at the head's base so a thick line's butt never pokes past the tip
        if (dir === "to" || dir === "both") wp = trimEnd(wp, "end", ah * 0.8);
        if (dir === "from" || dir === "both") wp = trimEnd(wp, "start", ah * 0.8);
        const d = "M " + wp.map((p) => `${p.x} ${p.y}`).join(" L ");
        const hit = el("path", { class: "hit", d: "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "), fill: "none" }, g);
        const col = e.color || (S.selEdge === e.id ? "#58a6ff" : "#6e7681");
        const w = el("path", { class: "wire", d, fill: "none" }, g);
        // FR77: inline style, NOT attributes — the .edge .wire / .k-cable CSS rules would override stroke-width/stroke
        w.style.strokeWidth = lw;
        if (e.color) w.style.stroke = e.color;
        hit.style.strokeWidth = Math.max(14, lw + 10);   // keep a thick line easy to click
        // arrowheads drawn by hand → always sit AT the box edge (no min-length blind spot), size/colour-settable
        const fb = { x: center(b).x - center(a).x, y: center(b).y - center(a).y };
        if (dir === "to" || dir === "both") drawArrowHead(g, poly, "end", ah, col, fb);
        if (dir === "from" || dir === "both") drawArrowHead(g, poly, "start", ah, col, fb);
        if (S.selEdge === e.id) selPoly = poly;
        const m = midOfPoly(poly); mx = m.x; my = m.y;
        if (kind !== "plain" && EDGE_ICON[kind]) {
          const u = el("use", { href: "#ic-" + EDGE_ICON[kind], x: mx - 9, y: my - 20, width: 18, height: 18 }, g);
          u.style.color = "#8b949e";
        }
      }
      if (e.label) { const t = el("text", { x: mx, y: my - (kind === "pipe" ? 18 : 4), "text-anchor": "middle" }, g); t.textContent = e.label; }
    }

    // draw containers first, then normal nodes, then contained children on top
    const rank = (n) => activeContainerOf(n) ? 2 : (isContainer(n) ? 0 : 1);
    for (const n of [...vis].sort((a, b) => rank(a) - rank(b))) {
      const pal = PALETTE[n.color] || PALETTE.note, bx = boxOf[n.id];
      const g = el("g", { class: "node" + (isContainer(n) ? " container" : "") + (S.sel === n.id ? " sel" : ""),
                          "data-id": n.id }, gNodes);
      const T = NODE_TYPES[n.nodeType], r = T ? T.rx(bx) : 8;   // FR82: block shape = what the box IS
      const rect = el("rect", { x: bx.x, y: bx.y, width: bx.w, height: bx.h, rx: r, ry: r, fill: pal.fill, stroke: pal.stroke }, g);
      if (T) { rect.style.strokeWidth = T.sw; if (T.dash) rect.style.strokeDasharray = T.dash; }   // inline: beats .node rect CSS
      if (n.nodeType === "info") drawDogEar(g, bx, pal);
      // FR54/FR76: pipes visible through the box (inline style — must beat the .container CSS opacity)
      if (n.seeThrough || autoSeeThrough(n)) rect.style.fillOpacity = "0.3";
      const cx = bx.x + bx.w / 2;
      let ty = bx.y + bx.h / 2 + 4;
      if (n.icon) {
        const u = el("use", { href: "#ic-" + n.icon, x: cx - 12, y: bx.y + 8, width: 24, height: 24 }, g);
        u.style.color = pal.stroke;
        ty = bx.y + 40;
      }
      const lines = String(n.label || "").split("\n");
      const startY = n.icon ? ty : ty - (lines.length - 1) * 8;
      lines.forEach((ln, i) => { const t = el("text", { x: cx, y: startY + i * 15, "text-anchor": "middle" }, g); t.textContent = ln; });
      if (n.childDiagram) { const d = el("text", { x: bx.x + bx.w - Math.max(8, r * 0.7), y: bx.y + 14, "text-anchor": "end", class: "drill" }, g); d.textContent = "⊕ open"; }
    }
    // resize handles on the selected node — drag an edge (w/h) or a corner (diagonal)
    if (S.sel) { const sn = node(S.sel); if (sn && visible(sn) && boxOf[sn.id]) drawHandles(boxOf[sn.id]); }
    if (selPoly) drawEndHandles(selPoly);
    if (S.ghost) drawGhosts(boxOf);   // FR87
    updateEdgePanel();
  }
  function updateEdgePanel() {   // contextual box for the selected arrow: direction + head size + width + colour
    const p = $("edgepanel");
    const e = S.selEdge && S.data.edges.find((x) => x.id === S.selEdge);
    const ends = e && edgeEnds(e), a = ends && ends.a, b = ends && ends.b;
    if (!e || !a || !b) { p.style.display = "none"; S._panelEdge = null; return; }
    if (S._panelEdge !== e.id) S.panelOff = { x: 0, y: 0 };   // FR78: a moved box resets for a newly selected arrow
    const mid = midOfPoly(dedupe(pipePoly(a, b, e)));
    p.style.left = (S.view.x + mid.x * S.view.k + S.panelOff.x) + "px";
    p.style.display = "block";   // shown before measuring: FR79 the box sits fully ABOVE the line so a segment stays grabbable
    p.style.top = Math.max(2, S.view.y + mid.y * S.view.k - p.offsetHeight - 16 + S.panelOff.y) + "px";
    const isPipe = e.kind === "pipe";   // heads/direction don't apply to pipe tubes; colour still does
    $("ep-dirrow").style.display = isPipe ? "none" : "flex";
    $("ep-sizerow").style.display = isPipe ? "none" : "flex";
    const dir = e.dir || "to";
    for (const btn of p.querySelectorAll("#ep-dirrow button")) btn.classList.toggle("on", btn.getAttribute("data-dir") === dir);
    if (S._panelEdge !== e.id) {   // populate inputs only when the selected edge changes (don't fight a live drag)
      S._panelEdge = e.id;
      const lw = typeof e.lw === "number" ? e.lw : (e.kind === "cable" || e.kind === "lan" ? 3 : 2);
      const ah = typeof e.ah === "number" ? e.ah : 12;
      $("ep-ah").value = ah; $("ep-ahv").textContent = ah;
      $("ep-lw").value = lw; $("ep-lwv").textContent = lw;
      $("ep-color").value = /^#[0-9a-f]{6}$/i.test(e.color || "") ? e.color : "#6e7681";
    }
  }
  // FR80: an edge end can sit ON a pipe (edge.fromOn / edge.toOn = "<pipeId>:<spot>"): an elbow (c<i> = polyline
  // point i), a segment's midpoint (m<i>), or — Shift held, FR81 — an exact spot (s<i>@<t> = fraction t along segment i)
  const SNAP_PX = 24;   // within this many screen px of a snap point = jump to it on release
  function pipePolyOf(pe) {   // only plain pipes (not themselves attached to a pipe) can be attached to
    if (!pe || pe.kind !== "pipe" || pe.fromOn || pe.toOn || !visible(pe)) return null;
    const a = node(pe.from), b = node(pe.to);
    return a && b && visible(a) && visible(b) ? dedupe(pipePoly(rbox(a), rbox(b), pe)) : null;
  }
  function pipeAnchors(poly) {
    const out = [];
    for (let i = 1; i < poly.length - 1; i++) out.push({ key: "c" + i, x: poly[i].x, y: poly[i].y });
    for (let i = 1; i < poly.length; i++) out.push({ key: "m" + (i - 1), x: (poly[i - 1].x + poly[i].x) / 2, y: (poly[i - 1].y + poly[i].y) / 2 });
    return out;
  }
  function pipeSpot(poly, key) {
    const m = /^s(\d+)@([\d.]+)$/.exec(key);
    if (m && +m[1] < poly.length - 1) { const A = poly[+m[1]], B = poly[+m[1] + 1], t = +m[2];
      return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t }; }
    const an = pipeAnchors(poly);
    return an.find((q) => q.key === key) || an.find((q) => q.key[0] === "m") || null;   // pipe re-routed → its first mid
  }
  function onPipeBox(spec) {   // the spot as a box the pipe's girth wide → the arrow tip lands on the pipe's outline
    const i = String(spec).indexOf(":"), pe = S.data.edges.find((x) => x.id === String(spec).slice(0, i));
    const poly = pipePolyOf(pe), p = poly && pipeSpot(poly, String(spec).slice(i + 1));
    if (!p) return null;
    const r = (pe.pw || 22) / 2 + 3;
    return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r };
  }
  function edgeEnds(e, boxOf) {   // the two boxes an edge routes between (a node's box, or a spot on a pipe)
    const get = (id, on) => on ? onPipeBox(on) : boxOf ? boxOf[id] : (node(id) && visible(node(id)) ? rbox(node(id)) : null);
    const a = get(e.from, e.fromOn), b = get(e.to, e.toOn);
    return a && b ? { a, b } : null;
  }
  function boxSnaps(b) {   // FR81 grid points of a box: 4 corners + 4 side-midpoints
    const out = [];
    for (const [k, fx, fy] of [["nw", 0, 0], ["n", .5, 0], ["ne", 1, 0], ["e", 1, .5], ["se", 1, 1], ["s", .5, 1], ["sw", 0, 1], ["w", 0, .5]])
      out.push({ key: k, x: b.x + b.w * fx, y: b.y + b.h * fy });
    return out;
  }
  function onBorder(b, p) {   // nearest point on the box outline
    const x = Math.max(b.x, Math.min(b.x + b.w, p.x)), y = Math.max(b.y, Math.min(b.y + b.h, p.y));
    const d = [[Math.abs(x - b.x), b.x, y], [Math.abs(b.x + b.w - x), b.x + b.w, y], [Math.abs(y - b.y), x, b.y], [Math.abs(b.y + b.h - y), x, b.y + b.h]]
      .sort((u, v) => u[0] - v[0])[0];
    return { x: d[1], y: d[2] };
  }
  // FR81: what an edge end would attach to at world point wp. Pipes win when the cursor is on one (or near one of its
  // anchors); else the innermost box under / next to the cursor. No Shift → jump to the nearest snap point (box: corner or
  // side-mid within SNAP_PX, else the auto side-mid; pipe: nearest elbow/segment-mid). Shift → exactly the cursor spot.
  function resolveTarget(wp, shift, skipEdge) {
    const tol = SNAP_PX / (S.view.k || 1), dist = (q) => Math.hypot(q.x - wp.x, q.y - wp.y);
    let best = null;
    for (const pe of S.data.edges) {
      if (pe.id === skipEdge) continue;
      const poly = pipePolyOf(pe); if (!poly) continue;
      const pr = projPoly(poly, wp), body = (pe.pw || 22) / 2 + 3;
      const an = pipeAnchors(poly).map((q) => ({ ...q, d: dist(q) })).sort((u, v) => u.d - v.d)[0];
      if (pr.d > body && !(an && an.d <= tol && !shift)) continue;
      const score = Math.min(pr.d, an ? an.d : Infinity);
      if (best && best.score <= score) continue;
      best = shift ? { pipe: pe.id, poly, key: `s${pr.i}@${pr.t.toFixed(3)}`, pt: { x: pr.x, y: pr.y }, exact: true, score }
                   : { pipe: pe.id, poly, key: an.key, pt: an, snapped: true, score };
    }
    if (best) return best;
    let nb = null;
    for (const n of S.data.nodes) {
      if (!visible(n)) continue;
      const b = rbox(n), inside = wp.x >= b.x && wp.x <= b.x + b.w && wp.y >= b.y && wp.y <= b.y + b.h;
      const sn = boxSnaps(b).map((q) => ({ ...q, d: dist(q) })).sort((u, v) => u.d - v.d)[0];
      if (!inside && sn.d > tol) continue;
      const rank = inside ? b.w * b.h : 1e12 + sn.d;   // innermost box under the cursor, else the nearest snap
      if (!nb || rank < nb.rank) nb = { id: n.id, box: b, sn, rank };
    }
    if (!nb) return null;
    if (shift) return { id: nb.id, box: nb.box, pt: onBorder(nb.box, wp), exact: true };
    return nb.sn.d <= tol ? { id: nb.id, box: nb.box, pt: nb.sn, snapped: true } : { id: nb.id, box: nb.box, pt: null };
  }
  const ENDK = { start: ["from", "fromOn", "so", "ss"], end: ["to", "toOn", "eo", "es"] };
  function portOffsets(e, end, pt, free) {   // set so/ss (eo/es) so the route meets box point pt (free: any point, FR79 shift)
    const [, , oK, sK] = ENDK[end], ends = edgeEnds(e); if (!ends) return;
    const { H } = zRouteSegs(ends.a, ends.b, e), q = end === "end" ? ends.b : ends.a;
    const U = (z) => H ? { u: z.x, v: z.y } : { u: z.y, v: z.x }, Q = H ? { u: q.x, v: q.y, wu: q.w, wv: q.h } : { u: q.y, v: q.x, wu: q.h, wv: q.w };
    const p = U(pt), cu = Q.u + Q.wu / 2, cv = Q.v + Q.wv / 2;
    let o = p.v - cv, st = p.u - cu;
    if (!free) {   // a point ON the outline: on a facing side → slide along it; on a top/bottom side → stub into it
      const other = end === "end" ? ends.a : ends.b, ou = H ? other.x + other.w / 2 : other.y + other.h / 2;
      const near = ou >= cu ? Q.u + Q.wu : Q.u;   // only the side FACING the other end can be slid along
      if (Math.abs(p.u - near) < 0.5) st = 0; else o = p.v <= cv ? -(Q.wv / 2 + 20) : Q.wv / 2 + 20;
    }
    o = Math.round(o); st = Math.round(st);
    if (o) e[oK] = o; else delete e[oK];
    if (st && Math.abs(o) > Q.wv / 2) e[sK] = st; else delete e[sK];
  }
  function applyTarget(e, end, t) {   // attach edge end to a resolved target (pipe spot / box point / box auto-mid)
    const [idK, onK, oK, sK] = ENDK[end];
    delete e[onK]; delete e[oK]; delete e[sK];
    if (t.pipe) { e[onK] = t.pipe + ":" + t.key; e[idK] = S.data.edges.find((x) => x.id === t.pipe)[end === "end" ? "to" : "from"]; return; }
    e[idK] = t.id;
    if (t.pt) portOffsets(e, end, t.pt, false);
  }
  function drawHover(t) {   // FR81: highlight the box/pipe an edge end would attach to + the exact snap point
    for (const x of gNodes.querySelectorAll(".hl")) x.remove();
    if (!t) return;
    const k = S.view.k || 1, mk = (name, attrs) => { const x = el(name, { ...attrs, class: "hl" }, gNodes); x.style.pointerEvents = "none"; return x; };
    const HL = "#ff4fd8";   // magenta: stands out on every node colour AND on the yellow/blue/grey pipes
    if (t.box) mk("rect", { x: t.box.x - 3 / k, y: t.box.y - 3 / k, width: t.box.w + 6 / k, height: t.box.h + 6 / k, rx: 10, fill: "none", stroke: HL, "stroke-width": 3 / k });
    if (t.poly) mk("path", { d: "M " + t.poly.map((p) => `${p.x} ${p.y}`).join(" L "), fill: "none", stroke: HL, "stroke-opacity": 0.6, "stroke-width": 5 / k, "stroke-dasharray": `${10 / k} ${6 / k}` });
    if (!t.exact) for (const q of t.poly ? pipeAnchors(t.poly) : boxSnaps(t.box)) {   // the grid it can jump to
      const r = 4 / k, sq = t.poly ? q.key[0] === "c" : q.key.length === 2;   // squares = corners/elbows, dots = mids
      (sq ? mk("rect", { x: q.x - r, y: q.y - r, width: 2 * r, height: 2 * r }) : mk("circle", { cx: q.x, cy: q.y, r }))
        .setAttribute("fill", "#ffffff");
    }
    if (t.pt) { const c = mk("circle", { cx: t.pt.x, cy: t.pt.y, r: (t.exact ? 5 : 8) / k, stroke: "#ffffff", "stroke-width": 2 / k });
      c.style.fill = t.exact ? "#ff7b72" : HL; }   // red = exact spot (Shift), magenta = the grid point it jumps to
  }
  function drawEndHandles(poly) {   // grab an end of the selected edge to re-attach it (FR80/81)
    const z = 6 / (S.view.k || 1);
    [["start", poly[0]], ["end", poly[poly.length - 1]]].forEach(([end, p]) => {
      const h = el("circle", { class: "ehandle", "data-end": end, cx: p.x, cy: p.y, r: z, fill: "#58a6ff", stroke: "#0b0e14", "stroke-width": 1 / (S.view.k || 1) }, gNodes);
      h.style.cursor = "grab";
    });
  }
  /* ---------- FR87: hold Shift = every toggle state at once (dashed ghosts) + a cross-state overlap check ---------- */
  function allStates() {   // every reachable toggle combination (dependent option lists respected)
    const ts = toggles(), out = [], saved = S.toggle;
    const rec = (i, cur) => {
      if (i === ts.length) { out.push({ ...cur }); return; }
      S.toggle = cur; const opts = activeOptions(ts[i]);
      if (!opts.length) rec(i + 1, { ...cur, [ts[i].id]: null });
      for (const o of opts) rec(i + 1, { ...cur, [ts[i].id]: o.value });
    };
    rec(0, {}); S.toggle = saved; return out;
  }
  const geomKey = (o) => JSON.stringify(o, (k, v) => typeof v === "number" ? Math.round(v) : v);
  function ancestorsOf(n) { const o = new Set(); let c = activeContainerOf(n), g = 0;
    while (c && g++ < 8) { o.add(c); const p = node(c); c = p && activeContainerOf(p); } return o; }
  function ghostScan() {   // per state: where every box + line is, and which boxes overlap while both are shown
    const saved = S.toggle, nodes = {}, edges = {}, clash = new Map(), states = allStates();
    for (const st of states) {
      S.toggle = st;
      const vis = S.data.nodes.filter(visible), box = {};
      for (const n of vis) { box[n.id] = rbox(n); (nodes[n.id] = nodes[n.id] || new Map()).set(geomKey(box[n.id]), box[n.id]); }
      for (const e of S.data.edges) {
        if (!visible(e)) continue;
        const ends = edgeEnds(e, box); if (!ends) continue;
        const poly = dedupe(pipePoly(ends.a, ends.b, e));
        (edges[e.id] = edges[e.id] || new Map()).set(geomKey(poly), poly);
      }
      for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
        const A = vis[i], B = vis[j], a = box[A.id], b = box[B.id];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 2 || oy <= 2 || ancestorsOf(A).has(B.id) || ancestorsOf(B).has(A.id)) continue;   // nesting is not a clash
        const k = A.id + " × " + B.id;
        if (!clash.has(k)) clash.set(k, { a, b, st: [] });
        clash.get(k).st.push(st);
      }
    }
    S.toggle = saved;
    return { nodes, edges, clash, n: states.length };
  }
  function drawGhosts(boxOf) {
    const g = ghostScan(), k = S.view.k || 1, G = el("g", { class: "ghosts" }, gNodes);
    G.style.pointerEvents = "none";
    const curEdge = {};
    for (const e of S.data.edges) { if (!visible(e)) continue; const ends = edgeEnds(e, boxOf);
      if (ends) curEdge[e.id] = geomKey(dedupe(pipePoly(ends.a, ends.b, e))); }
    for (const id in g.edges) for (const [kk, poly] of g.edges[id]) {
      if (curEdge[id] === kk) continue;   // drawn for real already
      const e = S.data.edges.find((x) => x.id === id), pipe = e.kind === "pipe";
      el("path", { d: "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "), fill: "none", stroke: e.color || "#8b949e",
                   "stroke-width": (pipe ? 6 : 2) / k, "stroke-opacity": 0.75, "stroke-dasharray": `${8 / k} ${5 / k}` }, G);
    }
    for (const id in g.nodes) for (const [kk, b] of g.nodes[id]) {
      if (boxOf[id] && geomKey(boxOf[id]) === kk) continue;
      const n = node(id), pal = PALETTE[n.color] || PALETTE.note;
      const r = el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, fill: pal.fill, stroke: pal.stroke, "stroke-width": 1.5 / k, "stroke-dasharray": `${6 / k} ${4 / k}` }, G);
      r.style.fillOpacity = "0.25";
      const t = el("text", { x: b.x + b.w / 2, y: b.y + b.h / 2 + 4, "text-anchor": "middle" }, G);
      t.textContent = String(n.label || n.id).split("\n")[0]; t.style.fill = "#c9d1d9"; t.style.opacity = "0.75"; t.style.fontSize = "11px";
    }
    for (const c of g.clash.values()) for (const b of [c.a, c.b])
      el("rect", { x: b.x - 2 / k, y: b.y - 2 / k, width: b.w + 4 / k, height: b.h + 4 / k, rx: 9, fill: "none", stroke: "#ff4040", "stroke-width": 3 / k }, G);
    const sn = (st) => toggles().map((t) => st[t.id]).filter(Boolean).join("·");
    const list = [...g.clash].map(([k2, c]) => `<b>${k2}</b> (${sn(c.st[0])}${c.st.length > 1 ? ` +${c.st.length - 1}` : ""})`);
    status(`Shift: all <b>${g.n}</b> toggle states overlaid (dashed = only in other states) — ` +
      (list.length ? `<span style="color:#ff6b6b">⚠ ${list.length} overlapping pair(s):</span> ${list.slice(0, 5).join(" · ")}${list.length > 5 ? " …" : ""}`
                   : "✓ no boxes overlap in any state"));
  }
  const HANDLE_CUR = { nw: "nwse-resize", n: "ns-resize", ne: "nesw-resize", e: "ew-resize",
                       se: "nwse-resize", s: "ns-resize", sw: "nesw-resize", w: "ew-resize" };
  function drawHandles(bx) {
    const z = 9 / (S.view.k || 1);   // keep handles ~constant size on screen regardless of zoom
    const spots = { nw: [bx.x, bx.y], n: [bx.x + bx.w / 2, bx.y], ne: [bx.x + bx.w, bx.y],
                    e: [bx.x + bx.w, bx.y + bx.h / 2], se: [bx.x + bx.w, bx.y + bx.h],
                    s: [bx.x + bx.w / 2, bx.y + bx.h], sw: [bx.x, bx.y + bx.h], w: [bx.x, bx.y + bx.h / 2] };
    for (const dir in spots) {
      const [cx, cy] = spots[dir];
      const h = el("rect", { class: "handle", "data-dir": dir, x: cx - z / 2, y: cy - z / 2, width: z, height: z,
                             rx: z * 0.15, fill: "#58a6ff", stroke: "#0b0e14", "stroke-width": 1 / (S.view.k || 1) }, gNodes);
      h.style.cursor = S.ctrl ? "crosshair" : HANDLE_CUR[dir];
    }
  }
  const EDGE_ICON = { cable: "ethernet", lan: "ethernet", wifi: "wifi", usb: "usb", tunnel: "relay", tor: "tor" };

  /* ---------- toolbar: swatches + toggles ---------- */
  function buildSwatches() {
    const host = $("swatches"); host.textContent = "";
    for (const k of COLOR_KEYS) {
      const s = document.createElement("span");
      s.className = "sw"; s.title = PALETTE[k].label; s.dataset.color = k; s.style.background = PALETTE[k].stroke;
      s.onclick = () => { if (!S.sel) { status("select a node first"); return; }
        node(S.sel).color = k; markDirty(true); render(); refreshSwatchSel(); };
      host.appendChild(s);
    }
  }
  function refreshSwatchSel() {
    const cur = S.sel ? node(S.sel).color : null;
    for (const s of $("swatches").children) s.classList.toggle("sel", s.dataset.color === cur);
  }
  function buildToggles() {
    const bar = $("togglebar"); bar.textContent = "";
    const ts = toggles();
    if (!ts.length) { const e = document.createElement("span"); e.className = "empty";
      e.textContent = "no toggles — add with ⚙ toggles (or ask Claude)"; bar.appendChild(e); return; }
    for (const t of ts) {
      const opts = activeOptions(t);
      const wrap = document.createElement("span"); wrap.className = "tg";
      const lab = document.createElement("label"); lab.textContent = t.label || t.id; wrap.appendChild(lab);
      if (!opts.length) { const e = document.createElement("span"); e.className = "empty"; e.textContent = "— n/a"; wrap.appendChild(e); bar.appendChild(wrap); continue; }
      const seg = document.createElement("span"); seg.className = "seg";
      for (const o of opts) {
        const b = document.createElement("button");
        b.textContent = o.label || o.value; b.className = S.toggle[t.id] === o.value ? "on" : "";
        b.onclick = () => { S.toggle[t.id] = o.value; normalizeToggles(); writeHash(); buildToggles(); render(); };
        seg.appendChild(b);
      }
      wrap.appendChild(seg); bar.appendChild(wrap);
    }
  }

  /* ---------- breadcrumbs + picker ---------- */
  const diagramTitle = (id) => { const it = S.index.diagrams.find((d) => d.id === id); return it ? it.title : id; };
  const parentOf = (id) => { const it = S.index.diagrams.find((d) => d.id === id); return it ? it.parent : null; };
  function buildCrumbs() {
    const chain = []; let cur = S.id, g = 0;
    while (cur && g++ < 20) { chain.unshift(cur); cur = parentOf(cur); }
    const c = $("crumbs"); c.textContent = "";
    chain.forEach((id, i) => {
      if (i) { const s = document.createElement("span"); s.className = "sep"; s.textContent = "›"; c.appendChild(s); }
      if (id === S.id) { const b = document.createElement("b"); b.textContent = diagramTitle(id); c.appendChild(b); }
      else { const a = document.createElement("a"); a.href = "#" + id; a.textContent = diagramTitle(id);
        a.onclick = (e) => { e.preventDefault(); openDiagram(id); }; c.appendChild(a); }
    });
  }
  function buildPicker() {
    const p = $("picker"); p.textContent = "";
    for (const d of S.index.diagrams) {
      const o = document.createElement("option"); o.value = d.id;
      o.textContent = d.title + (d.parent ? "  (↳ " + d.parent + ")" : "");
      if (d.id === S.id) o.selected = true; p.appendChild(o);
    }
    p.onchange = () => openDiagram(p.value);
  }

  /* ---------- hash (diagram id + toggle state, shareable) ---------- */
  function writeHash() {
    let h = "#" + S.id;
    for (const t of toggles()) if (S.toggle[t.id] != null) h += `;${t.id}=${S.toggle[t.id]}`;
    history.replaceState(null, "", h);
  }
  function parseHash() {
    const parts = (location.hash || "").replace(/^#/, "").split(";");
    const id = parts.shift() || "";
    const t = {}; for (const p of parts) { const [k, v] = p.split("="); if (k) t[k] = v; }
    return { id, toggle: t };
  }

  /* ---------- load / save ---------- */
  async function detectBackend() {
    try { const r = await fetch("/api/ping", { cache: "no-store" }); if (r.ok) S.backend = !!(await r.json()).edit; }
    catch (_) { S.backend = false; }
    const m = $("mode"); m.textContent = S.backend ? "edit" : "view"; m.className = S.backend ? "edit" : "view";
    $("save").textContent = S.backend ? "💾 save" : "⬇ download";
  }
  async function loadIndex() {
    try { const r = await fetch(S.backend ? "/api/diagrams" : `${DIAG_DIR}/index.json`, { cache: "no-store" });
      if (r.ok) S.index = await r.json(); } catch (_) {}
  }
  async function openDiagram(id, toggleState) {
    if (S.dirty && !confirm("Discard unsaved changes to this diagram?")) return;
    try {
      const r = await fetch(`${DIAG_DIR}/${id}.json`, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      S.data = await r.json();
      S.data.nodes = Array.isArray(S.data.nodes) ? S.data.nodes : [];
      S.data.edges = Array.isArray(S.data.edges) ? S.data.edges : [];
      if (!S.data.meta) S.data.meta = { title: id, parent: null };
      S.id = id; S.sel = null; S.selEdge = null; markDirty(false);
      S.toggle = {}; for (const t of toggles()) S.toggle[t.id] = t.default;
      if (toggleState) for (const k in toggleState) S.toggle[k] = toggleState[k];
      normalizeToggles(); writeHash();
      buildCrumbs(); buildPicker(); buildToggles(); buildLegend(); fit(); render();
      status(`loaded <b>${id}</b> — ${S.data.nodes.length} nodes, ${S.data.edges.length} edges`);
    } catch (e) { status(`could not load ${id}.json — ${e.message}`); }
  }
  async function save() {
    const body = serialize(S.data);
    if (S.backend) {
      try {
        const r = await fetch(`/api/diagram/${S.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        markDirty(false); await loadIndex(); buildPicker(); buildCrumbs();
        status(`saved → <b>${j.path}</b> — Claude can read it now`);
      } catch (e) { status(`save failed: ${e.message}`); }
    } else {
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
      a.download = `${S.id}.json`; a.click(); URL.revokeObjectURL(a.href);
      status(`static site — downloaded <b>${S.id}.json</b> (commit it, or paste to Claude)`);
    }
  }
  async function copyJSON() {
    try { await navigator.clipboard.writeText(serialize(S.data)); status("diagram JSON copied — paste it to Claude"); }
    catch (_) { status("clipboard blocked — use ⬇ download"); }
  }

  /* ---------- zoom / fit ---------- */
  function zoomAt(cx, cy, f) {
    const k = Math.min(3, Math.max(0.2, S.view.k * f)), r = svg.getBoundingClientRect();
    const wx = (cx - r.left - S.view.x) / S.view.k, wy = (cy - r.top - S.view.y) / S.view.k;
    S.view.k = k; S.view.x = cx - r.left - wx * k; S.view.y = cy - r.top - wy * k; applyView();
  }
  function fit() {
    const vis = S.data.nodes.filter(visible);
    if (!vis.length) { S.view = { x: 40, y: 40, k: 1 }; applyView(); return; }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const n of vis) { const b = rbox(n); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    const pad = 50, r = svg.getBoundingClientRect(), lg = $("legend");
    const top = pad + (lg && !lg.hidden ? lg.offsetHeight + 4 : 0);   // FR82: keep the legend band clear of boxes
    const k = Math.min(3, Math.max(0.2, Math.min((r.width - pad * 2) / (x1 - x0 || 1), (r.height - pad - top) / (y1 - y0 || 1))));
    S.view.k = k; S.view.x = pad - x0 * k + (r.width - pad * 2 - (x1 - x0) * k) / 2;
    S.view.y = top - y0 * k + (r.height - pad - top - (y1 - y0) * k) / 2; applyView();
  }

  /* ---------- editing ops ---------- */
  const uid = (p, has) => { let i = 1; while (has(p + i)) i++; return p + i; };
  function addNode() {
    const id = uid("n", (x) => node(x)), r = svg.getBoundingClientRect();
    const c = toWorld({ clientX: r.left + svg.clientWidth / 2, clientY: r.top + svg.clientHeight / 2 });
    S.data.nodes.push({ id, label: "new node", x: c.x - 80, y: c.y - 30, w: 160, h: 64, color: "note", icon: "", childDiagram: "" });
    S.sel = id; S.selEdge = null; markDirty(true); render(); refreshSwatchSel();
    status(`added <b>${id}</b> — drag it, ✎ rename, ★ icon, colour`);
  }
  function delSel() {
    if (S.selEdge) { S.data.edges = S.data.edges.filter((e) => e.id !== S.selEdge); status(`deleted edge ${S.selEdge}`); S.selEdge = null; markDirty(true); render(); return; }
    if (!S.sel) { status("nothing selected"); return; }
    S.data.nodes = S.data.nodes.filter((n) => n.id !== S.sel);
    S.data.edges = S.data.edges.filter((e) => e.from !== S.sel && e.to !== S.sel);
    S.data.nodes.forEach((n) => { if (n.container === S.sel) { delete n.container; delete n.containerWhen; delete n.snapSide; } });
    status(`deleted <b>${S.sel}</b>`); S.sel = null; markDirty(true); render();
  }
  function relabel() {
    if (S.selEdge) { const e = S.data.edges.find((x) => x.id === S.selEdge);
      const v = prompt("Edge label:", e.label || ""); if (v == null) return; e.label = v; markDirty(true); render(); return; }
    if (!S.sel) { status("select a node or edge"); return; }
    const n = node(S.sel), v = prompt("Label (\\n = new line):", n.label.replace(/\n/g, "\\n"));
    if (v == null) return; n.label = v.replace(/\\n/g, "\n"); markDirty(true); render();
  }
  function setIcon() {
    if (!S.sel) { status("select a node first"); return; }
    const n = node(S.sel), v = prompt(`Icon for this node (blank = none)\noptions: ${ICONS.join(", ")}`, n.icon || "");
    if (v == null) return; const vv = v.trim();
    if (vv && !ICONS.includes(vv)) { status(`unknown icon '${vv}'`); return; }
    n.icon = vv; markDirty(true); render();
  }
  function setKind() {
    if (!S.selEdge) { status("select an EDGE first (click its line)"); return; }
    const e = S.data.edges.find((x) => x.id === S.selEdge);
    const v = prompt(`Edge kind\noptions: ${EDGE_KINDS.join(", ")}`, e.kind || "plain");
    if (v == null) return; const vv = v.trim() || "plain";
    if (!EDGE_KINDS.includes(vv)) { status(`unknown kind '${vv}'`); return; }
    e.kind = vv; markDirty(true); render();
  }
  function setChild() {
    if (!S.sel) { status("select a node first"); return; }
    const n = node(S.sel), ids = S.index.diagrams.map((d) => d.id).join(", ");
    const v = prompt(`Sub-diagram id to open on double-click\n(existing: ${ids})\n(blank = none):`, n.childDiagram || "");
    if (v == null) return; n.childDiagram = v.trim(); markDirty(true); render();
  }
  function setType() {   // FR82: action / info / device (blank = untyped plain box)
    if (!S.sel) { status("select a box first"); return; }
    const n = node(S.sel), v = prompt(`Block type (blank = none)\noptions: ${Object.keys(NODE_TYPES).join(", ")}`, n.nodeType || "");
    if (v == null) return; const vv = v.trim();
    if (vv && !NODE_TYPES[vv]) { status(`unknown type '${vv}'`); return; }
    if (vv) n.nodeType = vv; else delete n.nodeType;
    markDirty(true); buildLegend(); render(); status(`<b>${n.id}</b> → ${vv || "untyped"}`);
  }
  function setWhen() {
    const o = S.selEdge ? S.data.edges.find((x) => x.id === S.selEdge) : (S.sel ? node(S.sel) : null);
    if (!o) { status("select a node or edge first"); return; }
    const tids = toggles().map((t) => t.id);
    if (!tids.length) { status("no toggles defined (⚙ toggles) — nothing to bind to"); return; }
    const which = prompt(`Show this ONLY for a toggle value.\ntoggle id (${tids.join(", ")}), blank = clear all:`, tids[0]);
    if (which == null) return;
    if (!which.trim()) { delete o.showWhen; markDirty(true); render(); status("cleared show-when"); return; }
    if (!tids.includes(which.trim())) { status(`no toggle '${which}'`); return; }
    const cur = S.toggle[which.trim()];
    o.showWhen = Object.assign(o.showWhen || {}, { [which.trim()]: [cur] });
    markDirty(true); render(); status(`shows only when ${which.trim()}=${cur}`);
  }
  function setContainer() {
    if (!S.sel) { status("select the node to nest"); return; }
    const n = node(S.sel);
    const ids = S.data.nodes.filter((x) => x.id !== n.id).map((x) => x.id).join(", ");
    const v = prompt(`Nest this node inside which node? (blank = none)\nnodes: ${ids}`, n.container || "");
    if (v == null) return;
    delete n.snapSide;
    if (!v.trim()) { delete n.container; delete n.containerWhen; markDirty(true); render(); status("un-nested"); return; }
    if (!node(v.trim())) { status(`no node '${v}'`); return; }
    n.container = v.trim();
    const tids = toggles().map((t) => t.id);
    if (tids.length) {
      const w = prompt(`Only nest for a toggle value? toggle id (${tids.join(", ")}), blank = always:`, tids[0]);
      if (w != null && w.trim() && tids.includes(w.trim())) n.containerWhen = { [w.trim()]: [S.toggle[w.trim()]] };
      else delete n.containerWhen;
    }
    markDirty(true); render(); status(`nested ${n.id} in ${n.container}${n.containerWhen ? " (conditional)" : ""}`);
  }
  function descendantsOf(id) {   // every node nested (in ANY toggle state) under id — never a valid drop parent
    const out = new Set(); let grew = true;
    while (grew) { grew = false;
      for (const k of S.data.nodes) if (k.container && (k.container === id || out.has(k.container)) && !out.has(k.id)) { out.add(k.id); grew = true; } }
    return out;
  }
  // FR75: on release, a box dropped ON a side of a bigger box snaps its centre onto that side's midpoint (snapSide,
  // stays pinned there; nearest side line wins); else one fully INSIDE a bigger box becomes contained (cdx/cdy,
  // innermost wins); else free.
  function dropSnap(n, orig) {
    if (n.container && !activeContainerOf(n)) return "";   // conditional nesting inactive in this state → keep it
    const b = rbox(n);
    delete n.container; delete n.containerWhen; delete n.snapSide; delete n.cdx; delete n.cdy;
    n.x = b.x; n.y = b.y;
    const desc = descendantsOf(n.id);
    let edge = null, inner = null;
    for (const p of S.data.nodes) {
      if (p.id === n.id || !visible(p) || desc.has(p.id)) continue;
      const P = rbox(p);
      if (P.w * P.h <= b.w * b.h) continue;   // only snap into/onto a BIGGER box
      for (const s of ["n", "e", "s", "w"]) { const d = onSide(b, P, s);
        if (d >= 0 && (!edge || d < edge.d)) edge = { p, P, side: s, d }; }
      if (b.x > P.x && b.y > P.y && b.x + b.w < P.x + P.w && b.y + b.h < P.y + P.h && (!inner || P.w * P.h < inner.P.w * inner.P.h))
        inner = { p, P, side: null };
    }
    const best = edge || inner;
    if (!best) return `<b>${n.id}</b> free`;
    n.container = best.p.id;
    if (orig && orig.container === best.p.id && orig.containerWhen) n.containerWhen = orig.containerWhen;
    if (best.side) { n.snapSide = best.side; return `<b>${n.id}</b> snapped onto the ${({ n: "top", e: "right", s: "bottom", w: "left" })[best.side]} edge of <b>${best.p.id}</b>`; }
    n.cdx = b.x - best.P.x; n.cdy = b.y - best.P.y;
    return `<b>${n.id}</b> placed inside <b>${best.p.id}</b>`;
  }
  function editToggles() {
    const cur = JSON.stringify(toggles(), null, 2);
    const v = prompt("Toggles JSON (array). See flow_requirements.md FR34.\nExample option: {\"id\":\"method\",\"label\":\"Install\",\"default\":\"cable\",\"options\":[{\"value\":\"cable\",\"label\":\"LAN cable\"}]}", cur);
    if (v == null) return;
    try { const arr = JSON.parse(v); if (!Array.isArray(arr)) throw new Error("must be an array");
      S.data.meta.toggles = arr; S.toggle = {}; for (const t of arr) S.toggle[t.id] = t.default;
      normalizeToggles(); writeHash(); buildToggles(); render(); markDirty(true); status("toggles updated");
    } catch (e) { status("bad toggles JSON: " + e.message); }
  }
  async function newDiagram() {
    const id = prompt("New diagram id (a-z 0-9 - _):", "");
    if (!id) return;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) { status("bad id"); return; }
    if (S.index.diagrams.some((d) => d.id === id)) { status("id exists"); return; }
    const title = prompt("Title:", id) || id;
    const prev = { data: S.data, id: S.id, sel: S.sel };
    S.data = { meta: { title, parent: S.id || null }, nodes: [], edges: [] }; S.id = id; markDirty(false);
    await save();
    if (S.backend) {
      await loadIndex();
      if (prev.sel && confirm(`Link node "${prev.sel}" in "${prev.id}" to open "${id}"?`)) {
        S.data = prev.data; S.id = prev.id; node(prev.sel).childDiagram = id; await save();
      }
      openDiagram(id);
    } else { buildCrumbs(); buildPicker(); render(); status(`created <b>${id}</b> (downloaded — commit it)`); }
  }

  /* ---------- FR79: drag an arrow/pipe segment sideways (perpendicular to it) ---------- */
  function projPoly(poly, p) {   // nearest point on a polyline → { i: segment, t: fraction along it, x, y, d }
    let best = { i: 0, t: 0, x: poly[0].x, y: poly[0].y, d: Infinity };
    for (let i = 1; i < poly.length; i++) {
      const A = poly[i - 1], B = poly[i], dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2)) : 0;
      const x = A.x + dx * t, y = A.y + dy * t, d = Math.hypot(p.x - x, p.y - y);
      if (d < best.d) best = { i: i - 1, t, x, y, d };
    }
    return best;
  }
  function edgeDragStart(e, wp) {
    const base = { id: e.id, wx0: wp.x, wy0: wp.y, moved: false };
    if (Array.isArray(e.path) && e.path.length >= 2) {   // explicit path: shift that segment's two points
      const i = projPoly(e.path, wp).i, P = e.path[i], Q = e.path[i + 1];
      return { ...base, i, axis: Math.abs(P.y - Q.y) < 0.5 ? "y" : "x", path0: e.path.map((p) => ({ x: p.x, y: p.y })) };
    }
    const { a, b } = edgeEnds(e), r = zRouteSegs(a, b, e), key = r.segs[projPoly(r.pts, wp).i];
    const crossRun = key === "mo" || key === "ss" || key === "es";   // these segments run along the cross axis
    return { ...base, key, axis: crossRun === r.H ? "x" : "y",
             o0: { so: ofs(e.so), eo: ofs(e.eo), mo: ofs(e.mo), ss: ofs(e.ss), es: ofs(e.es) } };
  }
  function edgeDragMove(ev) {
    const d = S.edrag, e = S.data.edges.find((x) => x.id === d.id), wp = toWorld(ev);
    if (!e) return;
    if (!d.moved && Math.abs(wp.x - d.wx0) + Math.abs(wp.y - d.wy0) <= 3 / S.view.k) return;   // a click, not a drag
    d.moved = true;
    const delta = Math.round(d.axis === "x" ? wp.x - d.wx0 : wp.y - d.wy0);
    if (d.path0) {
      e.path = d.path0.map((p) => ({ x: p.x, y: p.y }));
      e.path[d.i][d.axis] += delta; e.path[d.i + 1][d.axis] += delta;
    } else {
      for (const k of d.key.split("+")) { const v = d.o0[k] + delta; if (v) e[k] = v; else delete e[k]; }
      if (d.key === "so" || d.key === "eo") {   // an end run dragged level with the other one snaps into a straight line
        const ends = edgeEnds(e), cv = ends && zRouteSegs(ends.a, ends.b, e).cv;
        if (cv && Math.abs(cv[0] + ofs(e.so) - cv[1] - ofs(e.eo)) <= EDGE_SNAP) {
          const v = d.key === "so" ? Math.round(cv[1] + ofs(e.eo) - cv[0]) : Math.round(cv[0] + ofs(e.so) - cv[1]);
          if (v) e[d.key] = v; else delete e[d.key];
        }
      }
    }
    markDirty(true); render();
  }
  function endDragMove(ev) {   // FR80/81: an edge end follows the cursor; pipe/box under it highlights, Shift = exact spot
    const d = S.edrag, e = S.data.edges.find((x) => x.id === d.id), wp = toWorld(ev);
    if (!e) return;
    if (!d.moved && Math.abs(wp.x - d.wx0) + Math.abs(wp.y - d.wy0) <= 3 / S.view.k) return;
    d.moved = true;
    const [idK] = ENDK[d.end], other = e[ENDK[d.end === "end" ? "start" : "end"][1]];
    let t = resolveTarget(wp, ev.shiftKey, e.id);
    if (t && t.pipe && other && other.split(":")[0] === t.pipe) t = null;   // both ends on one pipe: no
    if (t && !t.pipe && t.id === e[d.end === "end" ? "from" : "to"] && !e[ENDK[d.end === "end" ? "start" : "end"][1]]) t = null;   // onto its own other box
    if (t && !t.pipe && !t.pt) t = { ...t, pt: onBorder(t.box, wp), exact: true };   // not near a snap point → slide to the spot
    if (t) applyTarget(e, d.end, t);
    else {   // empty space: keep the box, shift the end freely toward the cursor (FR79 shifting)
      const [, onK] = ENDK[d.end]; delete e[onK]; e[idK] = d.orig[idK]; portOffsets(e, d.end, wp, true);
    }
    markDirty(true); render(); drawHover(t);
  }

  /* ---------- pointer interaction ---------- */
  const nodeIdFromEvent = (ev) => { const g = ev.target.closest(".node"); return g ? g.getAttribute("data-id") : null; };
  const edgeIdFromEvent = (ev) => { const g = ev.target.closest(".edge"); return g ? g.getAttribute("data-edge") : null; };

  svg.addEventListener("wheel", (ev) => { ev.preventDefault(); zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: false });

  svg.addEventListener("pointerdown", (ev) => {
    const hdir = ev.target.classList && ev.target.classList.contains("handle") ? ev.target.getAttribute("data-dir") : null;
    const nidDown = nodeIdFromEvent(ev);
    // Ctrl + press on a box (or its edge-dot) = DRAW A NEW ARROW from that box (instead of resize/move)
    const drawSrc = hdir ? S.sel : nidDown;
    // FR80/81: grab an end-dot of the selected edge = re-attach that end (box point, pipe spot, or free shift)
    const hend = ev.target.classList && ev.target.classList.contains("ehandle") ? ev.target.getAttribute("data-end") : null;
    if (hend && S.selEdge) {
      const e = S.data.edges.find((x) => x.id === S.selEdge), wp = toWorld(ev);
      S.edrag = { id: e.id, end: hend, wx0: wp.x, wy0: wp.y, moved: false, orig: { from: e.from, to: e.to } };
      ev.preventDefault(); S.mode = "enddrag"; svg.setPointerCapture(ev.pointerId); return;
    }
    const src = (ev.ctrlKey || S.ctrl) ? resolveTarget(toWorld(ev), ev.shiftKey) : null;
    if (src && src.exact && !src.pipe && Math.hypot(src.pt.x - toWorld(ev).x, src.pt.y - toWorld(ev).y) > SNAP_PX / S.view.k)
      { src.pt = null; src.exact = false; }   // Shift-press deep inside the start box: no exact spot there → auto side-mid
    if (src && (drawSrc || src.pipe)) {   // Ctrl-press on a box / its dot / a pipe → draw a new arrow from that spot
      ev.preventDefault();
      S.sel = null; S.selEdge = null; refreshSwatchSel(); render();   // hide the arrow box so it can't cover a target
      S.draw = { src }; S.mode = "drawedge";
      const c = src.pt || center(src.box);
      S.rubber = el("path", { id: "rubber", d: `M ${c.x} ${c.y} L ${c.x} ${c.y}` }, gEdges);
      svg.setPointerCapture(ev.pointerId);
      status(`drawing arrow from <b>${src.pipe || src.id}</b> — release on a box or pipe · it jumps to the marked point · hold <b>Shift</b> for the exact spot (Esc cancels)`);
      drawHover(src);
      return;
    }
    // resize handle on the selected node takes priority over move/pan
    if (hdir && S.sel) {
      const n = node(S.sel), wp = toWorld(ev);
      S.resize = { dir: hdir, contained: !!activeContainerOf(n), snapped: !!(activeContainerOf(n) && n.snapSide), wx0: wp.x, wy0: wp.y,
                   x0: n.x, y0: n.y, w0: n.w, h0: n.h,
                   cdx0: typeof n.cdx === "number" ? n.cdx : 16, cdy0: typeof n.cdy === "number" ? n.cdy : 56 };
      S.mode = "resize"; svg.setPointerCapture(ev.pointerId); return;
    }
    const nid = nodeIdFromEvent(ev);
    if (S.pending) {
      if (nid) {
        if (!S.pending.src) { S.pending.src = nid; status(`edge from <b>${nid}</b> — click the target`); }
        else if (nid !== S.pending.src) {
          S.data.edges.push({ id: uid("e", (x) => S.data.edges.some((e) => e.id === x)), from: S.pending.src, to: nid, label: "", kind: "plain" });
          S.pending = null; svg.classList.remove("addedge"); markDirty(true); render(); status("edge added — set its kind with ～");
        }
      }
      return;
    }
    if (nid) {
      // FR85: drill-down. The native dblclick never reaches the node (this press re-renders and replaces its element),
      // so a double-press is detected here; "⊕ open" opens the sub-diagram on a single click.
      const n0 = node(nid), now = Date.now(), dbl = S.lastPress && S.lastPress.id === nid && now - S.lastPress.t < 400;
      S.lastPress = { id: nid, t: now };
      if (n0.childDiagram && (dbl || ev.target.classList.contains("drill"))) { S.lastPress = null; openDiagram(n0.childDiagram); return; }
      if (dbl && S.backend) { S.lastPress = null; relabel(); return; }
      S.sel = nid; S.selEdge = null; refreshSwatchSel(); render();
      const n = node(nid), w = toWorld(ev);
      const orig = { container: n.container, containerWhen: n.containerWhen, snapSide: n.snapSide, x: n.x, y: n.y };
      if (activeContainerOf(n) && n.snapSide) {   // edge-snapped: unpin and drag freely; dropSnap re-attaches on release
        const b = rbox(n); delete n.container; delete n.containerWhen; delete n.snapSide; n.x = b.x; n.y = b.y; }
      const contained = !!activeContainerOf(n);
      S.drag = { id: nid, contained, orig, moved: false, wx0: w.x, wy0: w.y,
                 x0: n.x, y0: n.y, cdx0: typeof n.cdx === "number" ? n.cdx : 16, cdy0: typeof n.cdy === "number" ? n.cdy : 56 };
      S.mode = "drag"; svg.setPointerCapture(ev.pointerId);
    } else {
      const eid = edgeIdFromEvent(ev);
      if (eid) { S.selEdge = eid; S.sel = null; refreshSwatchSel(); render();
        const e = S.data.edges.find((x) => x.id === eid); status(`edge <b>${eid}</b> (${e.kind || "plain"}) — drag a segment sideways to move it · ～ kind · ✎ label · 🗑 delete`);
        ev.preventDefault(); S.edrag = edgeDragStart(e, toWorld(ev)); S.mode = "edgedrag"; svg.setPointerCapture(ev.pointerId); return; }
      S.sel = null; S.selEdge = null; refreshSwatchSel(); render();
      S.mode = "pan"; S.panStart = { x: ev.clientX, y: ev.clientY, vx: S.view.x, vy: S.view.y };
      svg.classList.add("panning"); svg.setPointerCapture(ev.pointerId);
    }
  });
  svg.addEventListener("pointermove", (ev) => {
    if (S.mode === "edgedrag" && S.edrag) { edgeDragMove(ev); return; }
    if (S.mode === "enddrag" && S.edrag) { endDragMove(ev); return; }
    if (S.mode === "drawedge" && S.draw) {
      const wp = toWorld(ev), sr = S.draw.src, c = sr.pt || center(sr.box);
      let t = resolveTarget(wp, ev.shiftKey);
      if (t && (t.pipe ? t.pipe === sr.pipe : t.id === sr.id && !sr.pipe)) t = null;   // not onto where it starts
      S.draw.tgt = t; drawHover(t);
      const q = t ? (t.pt || center(t.box)) : wp;
      if (S.rubber) S.rubber.setAttribute("d", `M ${c.x} ${c.y} L ${q.x} ${q.y}`);
      return;
    }
    if (S.mode === "resize" && S.resize) {
      const r = S.resize, wp = toWorld(ev), n = node(S.sel), MIN = 40, d = r.dir;
      let dx = wp.x - r.wx0, dy = wp.y - r.wy0;
      if (d.includes("e")) n.w = Math.max(MIN, r.w0 + dx);
      if (d.includes("s")) n.h = Math.max(MIN, r.h0 + dy);
      if (d.includes("w")) { let nw = r.w0 - dx; if (nw < MIN) { dx = r.w0 - MIN; nw = MIN; } n.w = nw;
        if (r.snapped) {} else if (r.contained) n.cdx = r.cdx0 + dx; else n.x = r.x0 + dx; }   // snapped: centre stays pinned
      if (d.includes("n")) { let nh = r.h0 - dy; if (nh < MIN) { dy = r.h0 - MIN; nh = MIN; } n.h = nh;
        if (r.snapped) {} else if (r.contained) n.cdy = r.cdy0 + dy; else n.y = r.y0 + dy; }
      markDirty(true); render(); return;
    }
    if (S.mode === "drag" && S.drag) {
      const w = toWorld(ev), n = node(S.drag.id), dx = w.x - S.drag.wx0, dy = w.y - S.drag.wy0;
      if (Math.abs(dx) + Math.abs(dy) > 3 / S.view.k) S.drag.moved = true;
      if (S.drag.contained) { n.cdx = S.drag.cdx0 + dx; n.cdy = S.drag.cdy0 + dy; }
      else { n.x = S.drag.x0 + dx; n.y = S.drag.y0 + dy; }
      markDirty(true); render();
    } else if (S.mode === "pan" && S.panStart) {
      S.view.x = S.panStart.vx + (ev.clientX - S.panStart.x); S.view.y = S.panStart.vy + (ev.clientY - S.panStart.y); applyView();
    }
  });
  function clearRubber() { if (S.rubber) { S.rubber.remove(); S.rubber = null; } S.draw = null; }
  function endPointer(ev) { if (S.mode) { try { svg.releasePointerCapture(ev.pointerId); } catch (_) {} }
    S.mode = "idle"; S.drag = null; S.panStart = null; S.resize = null; svg.classList.remove("panning"); }
  svg.addEventListener("pointerup", (ev) => {
    if (S.mode === "edgedrag" || S.mode === "enddrag") { S.edrag = null; endPointer(ev); render(); return; }
    if (S.mode === "drawedge" && S.draw) {
      const tgt = S.draw.tgt, src = S.draw.src;
      if (tgt) {
        const id = uid("e", (x) => S.data.edges.some((e) => e.id === x)), e = { id, from: "", to: "", label: "", kind: "plain", dir: "to" };
        S.data.edges.push(e);
        applyTarget(e, "start", { ...src, pt: null }); applyTarget(e, "end", { ...tgt, pt: null });   // both ends exist first …
        applyTarget(e, "start", src); applyTarget(e, "end", tgt);                                    // … then the exact points
        S.selEdge = id; S.sel = null; markDirty(true);
        status(`arrow <b>${src.pipe || src.id} → ${tgt.pipe || tgt.id}</b> added — set its direction in the box, or ✎ label`);
      } else { status("arrow cancelled (release on a target box or pipe)"); }
      clearRubber(); endPointer(ev); render(); return;
    }
    if (S.mode === "drag" && S.drag) {
      const n = node(S.drag.id), o = S.drag.orig;
      if (S.drag.moved) { const msg = dropSnap(n, o); markDirty(true); if (msg) status(msg); }
      else if (!n.container && o.container) {   // a click (no move) on an edge-snapped box: put it back
        n.container = o.container; if (o.containerWhen) n.containerWhen = o.containerWhen;
        if (o.snapSide) n.snapSide = o.snapSide; n.x = o.x; n.y = o.y; }
      endPointer(ev); render(); return;
    }
    endPointer(ev);
  });
  svg.addEventListener("pointercancel", (ev) => { clearRubber(); endPointer(ev); });

  /* ---------- buttons + keys ---------- */
  $("addnode").onclick = addNode;
  $("addedge").onclick = () => { S.pending = { src: null }; svg.classList.add("addedge"); status("add edge: click <b>source</b> then <b>target</b> (Esc cancels)"); };
  $("del").onclick = delSel;
  $("relabel").onclick = relabel;
  $("seticon").onclick = setIcon;
  $("setkind").onclick = setKind;
  $("setchild").onclick = setChild;
  $("setwhen").onclick = setWhen;
  $("settype").onclick = setType;
  $("setcontainer").onclick = setContainer;
  $("edittoggles").onclick = editToggles;
  $("fit").onclick = fit;
  const mid = () => ({ x: svg.getBoundingClientRect().left + svg.clientWidth / 2, y: svg.getBoundingClientRect().top + svg.clientHeight / 2 });
  $("zin").onclick = () => { const m = mid(); zoomAt(m.x, m.y, 1.2); };
  $("zout").onclick = () => { const m = mid(); zoomAt(m.x, m.y, 1 / 1.2); };
  $("save").onclick = save;
  $("copy").onclick = copyJSON;
  $("newdiag").onclick = newDiagram;
  // arrow box: direction (A→B / A←B / A↔B), head size, line width, colour
  const selEdgeObj = () => S.selEdge && S.data.edges.find((x) => x.id === S.selEdge);
  for (const btn of document.querySelectorAll("#ep-dirrow button")) {
    btn.onclick = () => { const e = selEdgeObj(); if (!e) return; e.dir = btn.getAttribute("data-dir"); markDirty(true); render(); };
  }
  $("ep-ah").addEventListener("input", (ev) => { const e = selEdgeObj(); if (!e) return; e.ah = +ev.target.value; $("ep-ahv").textContent = e.ah; markDirty(true); render(); });
  $("ep-lw").addEventListener("input", (ev) => { const e = selEdgeObj(); if (!e) return; e.lw = +ev.target.value; $("ep-lwv").textContent = e.lw; markDirty(true); render(); });
  $("ep-color").addEventListener("input", (ev) => { const e = selEdgeObj(); if (!e) return; e.color = ev.target.value; markDirty(true); render(); });
  $("ep-colorclear").onclick = () => { const e = selEdgeObj(); if (!e) return; delete e.color; markDirty(true); render(); };
  $("ep-routereset").onclick = () => { const e = selEdgeObj(); if (!e) return;   // FR79: drop the dragged offsets
    for (const k of ["so", "eo", "mo", "ss", "es"]) delete e[k]; markDirty(true); render(); };
  // FR78: press-and-hold anywhere on the arrow box (not on its controls) and drag to move it; dblclick = back home
  const panel = $("edgepanel"), isCtl = (t) => t.closest("button, input, select, textarea");
  panel.addEventListener("pointerdown", (ev) => {
    if (isCtl(ev.target) || ev.button !== 0) return;
    ev.preventDefault();
    const st = { x: ev.clientX, y: ev.clientY, ox: S.panelOff.x, oy: S.panelOff.y };
    panel.classList.add("moving"); panel.setPointerCapture(ev.pointerId);
    const move = (m) => { S.panelOff = { x: st.ox + m.clientX - st.x, y: st.oy + m.clientY - st.y }; updateEdgePanel(); };
    const up = () => { panel.classList.remove("moving"); panel.removeEventListener("pointermove", move);
      panel.removeEventListener("pointerup", up); panel.removeEventListener("pointercancel", up); };
    panel.addEventListener("pointermove", move); panel.addEventListener("pointerup", up); panel.addEventListener("pointercancel", up);
  });
  panel.addEventListener("dblclick", (ev) => { if (isCtl(ev.target)) return; S.panelOff = { x: 0, y: 0 }; updateEdgePanel(); });
  // hover help on toolbar controls (clearer than native title)
  const tip = $("tooltip");
  function showTip(t) { const h = t.getAttribute("data-help"); if (!h) return; tip.innerHTML = h;
    const r = t.getBoundingClientRect(); tip.style.display = "block";
    tip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 352)) + "px";
    tip.style.top = (r.bottom + 6) + "px"; }
  for (const t of document.querySelectorAll("[data-help]")) {
    t.addEventListener("mouseenter", () => showTip(t));
    t.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }
  function setCtrl(on) {   // Ctrl held = "draw a new arrow" mode (cursor + handle hint)
    if (S.ctrl === on) return;
    S.ctrl = on; svg.classList.toggle("drawmode", on);
    if (on && S.ghost) { S.ghost = false; render(); }   // Ctrl+Shift = exact-attach drawing (FR81), not the overlay
    if (S.sel) render();   // refresh handle cursors
  }
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Control" || ev.key === "Meta") setCtrl(true);
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
    // FR87: hold Shift (alone) = overlay every toggle state; not while Shift means "exact spot" (drawing / end drag)
    if (ev.key === "Shift" && !S.ghost && !ev.ctrlKey && !ev.metaKey && S.mode !== "drawedge" && S.mode !== "enddrag") { S.ghost = true; render(); }
    if (ev.key === "Delete" || ev.key === "Backspace") { if (S.sel || S.selEdge) { ev.preventDefault(); delSel(); } }
    else if (ev.key === "Escape") {
      if (S.mode === "drawedge") { clearRubber(); S.mode = "idle"; status("arrow cancelled"); render(); }
      else if (S.pending) { S.pending = null; svg.classList.remove("addedge"); status("cancelled"); }
    }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); save(); }
  });
  window.addEventListener("keyup", (ev) => { if (ev.key === "Control" || ev.key === "Meta") setCtrl(false);
    if (ev.key === "Shift" && S.ghost) { S.ghost = false; render(); status("overlay off"); } });
  window.addEventListener("blur", () => { setCtrl(false); if (S.ghost) { S.ghost = false; render(); } });
  window.addEventListener("beforeunload", (ev) => { if (S.dirty) { ev.preventDefault(); ev.returnValue = ""; } });

  /* ---------- boot ---------- */
  async function injectIcons() {
    try { const r = await fetch(`${DIAG_DIR}/../icons.svg`, { cache: "no-store" });
      if (!r.ok) return; const txt = await r.text();
      const doc = new DOMParser().parseFromString(txt, "image/svg+xml");
      for (const sym of doc.querySelectorAll("symbol")) $("defs").appendChild(sym);
    } catch (_) {}
  }
  (async function init() {
    buildSwatches(); await injectIcons(); await detectBackend(); await loadIndex();
    const h = parseHash();
    const want = h.id || S.index.root || "overview";
    await openDiagram(want, h.toggle);
    if (!S.backend) status(`<b>view mode</b> (static) — drag to explore; Save ⬇ downloads · ⧉ copies JSON. Run <b>./dash serve</b> to save to disk.`);
  })();
})();
