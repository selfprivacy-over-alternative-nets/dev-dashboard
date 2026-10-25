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
  function applyView() { gViewport.setAttribute("transform", `translate(${S.view.x},${S.view.y}) scale(${S.view.k})`); }
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
  function zRoute(a, b) {   // orthogonal route anchored at side-MIDPOINTS (H-V-H / V-H-V), 90° only, snap-straight
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    if (Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y)) {
      const sx = cb.x >= ca.x ? a.x + a.w : a.x, ex = cb.x >= ca.x ? b.x : b.x + b.w;
      if (Math.abs(ca.y - cb.y) <= EDGE_SNAP) { const y = (ca.y + cb.y) / 2; return [{ x: sx, y }, { x: ex, y }]; }
      const mx = (sx + ex) / 2;
      return [{ x: sx, y: ca.y }, { x: mx, y: ca.y }, { x: mx, y: cb.y }, { x: ex, y: cb.y }];
    }
    const sy = cb.y >= ca.y ? a.y + a.h : a.y, ey = cb.y >= ca.y ? b.y : b.y + b.h;
    if (Math.abs(ca.x - cb.x) <= EDGE_SNAP) { const x = (ca.x + cb.x) / 2; return [{ x, y: sy }, { x, y: ey }]; }
    const my = (sy + ey) / 2;
    return [{ x: ca.x, y: sy }, { x: ca.x, y: my }, { x: cb.x, y: my }, { x: cb.x, y: ey }];
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
  const pipePoly = (aBox, bBox, e) => (Array.isArray(e.path) && e.path.length >= 2) ? e.path.map((p) => ({ x: p.x, y: p.y })) : zRoute(aBox, bBox);
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

    for (const e of S.data.edges) {
      if (!visible(e)) continue;
      const a = boxOf[e.from], b = boxOf[e.to];
      if (!a || !b) continue;
      const kind = e.kind || "plain";
      const g = el("g", { class: "edge k-" + kind + (S.selEdge === e.id ? " sel" : ""), "data-edge": e.id }, gEdges);
      let mx, my;
      if (kind === "pipe") {
        const poly = dedupe(pipePoly(a, b, e));
        el("path", { class: "hit", d: "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "), fill: "none" }, g);
        drawMarioPipe(g, poly, e.color || "#8b949e", e.pw, e.casing);
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
      const rect = el("rect", { x: bx.x, y: bx.y, width: bx.w, height: bx.h, rx: 8, ry: 8, fill: pal.fill, stroke: pal.stroke }, g);
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
      if (n.childDiagram) { const d = el("text", { x: bx.x + bx.w - 8, y: bx.y + 14, "text-anchor": "end", class: "drill" }, g); d.textContent = "⊕ open"; }
    }
    // resize handles on the selected node — drag an edge (w/h) or a corner (diagonal)
    if (S.sel) { const sn = node(S.sel); if (sn && visible(sn) && boxOf[sn.id]) drawHandles(boxOf[sn.id]); }
    updateEdgePanel();
  }
  function updateEdgePanel() {   // contextual box for the selected arrow: direction + head size + width + colour
    const p = $("edgepanel");
    const e = S.selEdge && S.data.edges.find((x) => x.id === S.selEdge);
    const a = e && node(e.from) && visible(node(e.from)) ? rbox(node(e.from)) : null;
    const b = e && node(e.to) && visible(node(e.to)) ? rbox(node(e.to)) : null;
    if (!e || !a || !b) { p.style.display = "none"; S._panelEdge = null; return; }
    const mid = midOfPoly(dedupe(pipePoly(a, b, e)));
    p.style.left = (S.view.x + mid.x * S.view.k) + "px";
    p.style.top = Math.max(2, S.view.y + mid.y * S.view.k - 104) + "px";
    p.style.display = "block";
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
      buildCrumbs(); buildPicker(); buildToggles(); fit(); render();
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
    const pad = 50, r = svg.getBoundingClientRect();
    const k = Math.min(3, Math.max(0.2, Math.min((r.width - pad * 2) / (x1 - x0 || 1), (r.height - pad * 2) / (y1 - y0 || 1))));
    S.view.k = k; S.view.x = pad - x0 * k + (r.width - pad * 2 - (x1 - x0) * k) / 2;
    S.view.y = pad - y0 * k + (r.height - pad * 2 - (y1 - y0) * k) / 2; applyView();
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

  /* ---------- pointer interaction ---------- */
  const nodeIdFromEvent = (ev) => { const g = ev.target.closest(".node"); return g ? g.getAttribute("data-id") : null; };
  const edgeIdFromEvent = (ev) => { const g = ev.target.closest(".edge"); return g ? g.getAttribute("data-edge") : null; };

  svg.addEventListener("wheel", (ev) => { ev.preventDefault(); zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: false });

  svg.addEventListener("pointerdown", (ev) => {
    const hdir = ev.target.classList && ev.target.classList.contains("handle") ? ev.target.getAttribute("data-dir") : null;
    const nidDown = nodeIdFromEvent(ev);
    // Ctrl + press on a box (or its edge-dot) = DRAW A NEW ARROW from that box (instead of resize/move)
    const drawSrc = hdir ? S.sel : nidDown;
    if ((ev.ctrlKey || S.ctrl) && drawSrc) {
      ev.preventDefault();
      S.draw = { src: drawSrc }; S.mode = "drawedge";
      const c = center(rbox(node(drawSrc)));
      S.rubber = el("path", { id: "rubber", d: `M ${c.x} ${c.y} L ${c.x} ${c.y}` }, gEdges);
      svg.setPointerCapture(ev.pointerId);
      status(`drawing arrow from <b>${drawSrc}</b> — release on the target box (Esc cancels)`);
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
        const e = S.data.edges.find((x) => x.id === eid); status(`edge <b>${eid}</b> (${e.kind || "plain"}) — ～ kind · ✎ label · 🗑 delete`); return; }
      S.sel = null; S.selEdge = null; refreshSwatchSel(); render();
      S.mode = "pan"; S.panStart = { x: ev.clientX, y: ev.clientY, vx: S.view.x, vy: S.view.y };
      svg.classList.add("panning"); svg.setPointerCapture(ev.pointerId);
    }
  });
  svg.addEventListener("pointermove", (ev) => {
    if (S.mode === "drawedge" && S.draw) {
      const wp = toWorld(ev), c = center(rbox(node(S.draw.src)));
      if (S.rubber) S.rubber.setAttribute("d", `M ${c.x} ${c.y} L ${wp.x} ${wp.y}`);
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
    if (S.mode === "drawedge" && S.draw) {
      const tgt = nodeAtWorld(toWorld(ev)), src = S.draw.src;
      if (tgt && tgt !== src) {
        const id = uid("e", (x) => S.data.edges.some((e) => e.id === x));
        S.data.edges.push({ id, from: src, to: tgt, label: "", kind: "plain", dir: "to" });
        S.selEdge = id; S.sel = null; markDirty(true);
        status(`arrow <b>${src} → ${tgt}</b> added — set its direction in the box, or ✎ label`);
      } else { status("arrow cancelled (release on a target box)"); }
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
  svg.addEventListener("dblclick", (ev) => {
    const nid = nodeIdFromEvent(ev); if (!nid) return; const n = node(nid);
    if (n.childDiagram) openDiagram(n.childDiagram); else if (S.backend) relabel();
  });

  /* ---------- buttons + keys ---------- */
  $("addnode").onclick = addNode;
  $("addedge").onclick = () => { S.pending = { src: null }; svg.classList.add("addedge"); status("add edge: click <b>source</b> then <b>target</b> (Esc cancels)"); };
  $("del").onclick = delSel;
  $("relabel").onclick = relabel;
  $("seticon").onclick = setIcon;
  $("setkind").onclick = setKind;
  $("setchild").onclick = setChild;
  $("setwhen").onclick = setWhen;
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
    if (S.sel) render();   // refresh handle cursors
  }
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Control" || ev.key === "Meta") setCtrl(true);
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
    if (ev.key === "Delete" || ev.key === "Backspace") { if (S.sel || S.selEdge) { ev.preventDefault(); delSel(); } }
    else if (ev.key === "Escape") {
      if (S.mode === "drawedge") { clearRubber(); S.mode = "idle"; status("arrow cancelled"); render(); }
      else if (S.pending) { S.pending = null; svg.classList.remove("addedge"); status("cancelled"); }
    }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); save(); }
  });
  window.addEventListener("keyup", (ev) => { if (ev.key === "Control" || ev.key === "Meta") setCtrl(false); });
  window.addEventListener("blur", () => setCtrl(false));
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
