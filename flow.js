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
    orange:  { fill: "#2a1a0c", stroke: "#f97316", label: "at a company you depend on" },   // FR108: = the "central" line colour
  };
  const COLOR_KEYS = Object.keys(PALETTE);
  const ICONS = ["laptop", "server", "router", "cloud", "phone", "usb", "ethernet", "wifi", "safe", "relay",
    "tor", "onion", "gear", "block", "pipe", "gate", "warn", "tag", "cart", "tornode", "doc", "port", "barrier"];
  const EDGE_KINDS = ["plain", "cable", "wifi", "usb", "lan", "internet", "tunnel", "tor"];

  const $ = (id) => document.getElementById(id);
  const svg = $("svg"), gViewport = $("viewport"), gNodes = $("nodes"), gEdges = $("edges");

  const S = {
    id: null, data: null, index: { diagrams: [], root: "overview" },
    backend: false, dirty: false,
    sel: null, selEdge: null,
    undo: [], redo: [], base: null, saved: null, pendingEdit: false,   // FR97 history (snapshots of S.data)
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
  function setDirty(on) { S.dirty = on; document.body.classList.toggle("dirty", on); }
  // FR97: undo / redo (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y, ↶ ↷). Every edit ends in markDirty(true): the FIRST call of an edit
  // pushes the last committed snapshot; the edit is committed once it's over — at once for a click/button, on
  // release for a drag (S.mode busy), after a short pause for a slider — so one gesture = one undo step.
  const UNDO_MAX = 200;
  const snap = () => JSON.stringify(S.data);
  let commitT = null;
  function markDirty(on) {
    setDirty(on);
    if (!on || !S.data) return;
    if (!S.pendingEdit) { S.undo.push(S.base); if (S.undo.length > UNDO_MAX) S.undo.shift(); S.redo = []; S.pendingEdit = true; }
    clearTimeout(commitT);
    const slider = document.activeElement && ["range", "color"].includes(document.activeElement.type);   // a stream of input events
    if (slider) commitT = setTimeout(commitEdit, 400);
    else if (S.mode === "idle") Promise.resolve().then(commitEdit);
  }
  function commitEdit() {
    if (!S.pendingEdit || (S.mode && S.mode !== "idle")) return;
    clearTimeout(commitT); S.base = snap(); S.pendingEdit = false;
  }
  function resetHistory() { S.base = snap(); S.saved = S.base; S.undo = []; S.redo = []; S.pendingEdit = false; }
  function restoreSnap(json) {
    S.data = JSON.parse(json); S.base = json; S.pendingEdit = false;
    if (S.sel && !node(S.sel)) S.sel = null;
    if (S.selEdge && !S.data.edges.some((e) => e.id === S.selEdge)) S.selEdge = null;
    normalizeToggles(); writeHash(); buildToggles(); buildLegend(); refreshSwatchSel(); render();
    setDirty(json !== S.saved);
  }
  function undo() {
    commitEdit();
    if (!S.undo.length) { status("nothing to undo"); return; }
    S.redo.push(S.base); restoreSnap(S.undo.pop());
    status(`undone — ${S.undo.length} more step${S.undo.length === 1 ? "" : "s"} to undo · redo: Ctrl+Shift+Z`);
  }
  function redo() {
    commitEdit();
    if (!S.redo.length) { status("nothing to redo"); return; }
    S.undo.push(S.base); restoreSnap(S.redo.pop());
    status(`redone — ${S.redo.length} more step${S.redo.length === 1 ? "" : "s"} to redo`);
  }
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
  // FR113: a view = one toggle combination, keyed "method=cable;net=0c;…" (n/a toggles left out). An item deleted in one
  // view while other views still show it is only hidden there (o.hideIn = [view keys]); Shift+Delete removes it everywhere.
  const viewKey = (st = S.toggle) => toggles().filter((t) => st[t.id] != null).map((t) => `${t.id}=${st[t.id]}`).join(";");
  const visible = (o) => whenMatches(o.showWhen) && !(Array.isArray(o.hideIn) && o.hideIn.includes(viewKey()));
  const thisViewWhen = () => { const w = {}; for (const t of toggles()) if (S.toggle[t.id] != null) w[t.id] = [S.toggle[t.id]]; return Object.keys(w).length ? w : null; };
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
  // FR94: each diagram's pan + zoom is remembered per browser (localStorage, never in the diagram JSON), so a page
  // load / reload / re-open comes back exactly where you were; ⤢ fit is used only when nothing is remembered yet.
  const VIEW_KEY = (id) => "flow.view." + id;
  let viewSaveT = null;
  function rememberView() {
    clearTimeout(viewSaveT);
    viewSaveT = setTimeout(() => { try { if (S.id) localStorage.setItem(VIEW_KEY(S.id), JSON.stringify(S.view)); } catch (_) {} }, 250);
  }
  function recallView(id) {
    try { const v = JSON.parse(localStorage.getItem(VIEW_KEY(id)) || "null");
      if (v && [v.x, v.y, v.k].every((n) => typeof n === "number" && isFinite(n)) && v.k >= 0.2 && v.k <= 3) return v; } catch (_) {}
    return null;
  }
  function applyView() { gViewport.setAttribute("transform", `translate(${S.view.x},${S.view.y}) scale(${S.view.k})`);
    rememberView();
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
  // FR92: a stub dragged PAST the box's far edge (|ss|/|es| > half the box) wraps round to that side with one
  // more bend; sf/ef = where it enters along that side (0 = the side's midpoint).
  // segs[i] names the offset that segment i drives (for the drag); u = main axis, v = cross axis.
  function zRouteSegs(a, b, e) {
    const H = typeof e._H === "boolean" ? e._H : Math.abs(b.x + b.w / 2 - a.x - a.w / 2) >= Math.abs(b.y + b.h / 2 - a.y - a.h / 2);   // _H: forced axis (FR93)
    const U = (q) => H ? { u: q.x, v: q.y, wu: q.w, wv: q.h } : { u: q.y, v: q.x, wu: q.h, wv: q.w };
    const A = U(a), B = U(b), cau = A.u + A.wu / 2, cbu = B.u + B.wu / 2;
    const su = cbu >= cau ? A.u + A.wu : A.u, eu = cbu >= cau ? B.u : B.u + B.wu;
    const sv = A.v + A.wv / 2 + ofs(e.so), ev = B.v + B.wv / 2 + ofs(e.eo);
    let pts, segs;   // snap-straight only when both ends share one offset: a set attachment (FR81) stays exact
    if (Math.abs(sv - ev) <= EDGE_SNAP && ofs(e.so) === ofs(e.eo)) { const v = (sv + ev) / 2; pts = [[su, v], [eu, v]]; segs = ["so+eo"]; }
    else {
      const mu = (su + eu) / 2 + ofs(e.mo), dn = cbu >= cau ? 1 : -1, inV = (q, v) => v >= q.v && v <= q.v + q.wv;
      const within = (q, near) => (mu - near) * dn > 0.5 && (mu - near) * dn < q.wu - 0.5;   // elbow lands inside q's main-axis extent
      // FR102: an elbow dragged past a box's face would double back INTO the box → end on the box's side it runs into
      if (within(B, eu) && inV(B, ev) && !inV(B, sv)) { pts = [[su, sv], [mu, sv], [mu, sv < B.v ? B.v : B.v + B.wv]]; segs = ["so", "mo"]; }
      else if (within(A, su - dn * A.wu) && inV(A, sv) && !inV(A, ev)) { pts = [[mu, ev < A.v ? A.v : A.v + A.wv], [mu, ev], [eu, ev]]; segs = ["mo", "eo"]; }
      else { pts = [[su, sv], [mu, sv], [mu, ev], [eu, ev]]; segs = ["so", "mo", "eo"]; } }
    const stub = (q, v, o, f) => {   // v beyond the box's side → enter via its top/bottom (left/right) side instead
      if (v >= q.v && v <= q.v + q.wv) return null;   // pts run from the box outward; the last one is (u, v)
      const half = q.wu / 2;
      if (Math.abs(o) <= half + 0.5) { const u = q.u + half + Math.max(-half, Math.min(half, o)); return { pts: [[u, v < q.v ? q.v : q.v + q.wv], [u, v]], wrap: false }; }
      const u = q.u + half + o, side = o > 0 ? q.u + q.wu : q.u, ve = q.v + q.wv / 2 + Math.max(-q.wv / 2, Math.min(q.wv / 2, f));
      return { pts: [[side, ve], [u, ve], [u, v]], wrap: true };   // FR92: past the far edge → wrap round to that side
    };
    const s0 = stub(A, pts[0][1], ofs(e.ss), ofs(e.sf));
    if (s0) { pts[0] = s0.pts[s0.pts.length - 1]; pts.unshift(...s0.pts.slice(0, -1)); segs.unshift(...(s0.wrap ? ["sf", "ss"] : ["ss"])); }
    const s1 = stub(B, pts[pts.length - 1][1], ofs(e.es), ofs(e.ef));
    if (s1) { pts[pts.length - 1] = s1.pts[s1.pts.length - 1]; pts.push(...s1.pts.slice(0, -1).reverse()); segs.push(...(s1.wrap ? ["es", "ef"] : ["es"])); }
    return { pts: pts.map(([u, v]) => H ? { x: u, y: v } : { x: v, y: u }), segs, H, cv: [A.v + A.wv / 2, B.v + B.wv / 2] };
  }
  // FR90 line patterns: link = solid (wifi dashed), action = thick dashes, info = round dots; null = legacy CSS look
  function lineWidth(role, kind) { return role === "action" ? 3 : role === "info" ? 2 : (kind === "cable" || kind === "lan" ? 3 : 2); }
  function lineDash(role, kind, lw) {
    if (role === "link") return kind === "wifi" ? "6 4" : "none";
    if (role === "action") return `${lw * 3} ${lw * 2}`;
    if (role === "info") return `0.1 ${lw * 2.6}`;
    return null;
  }
  function drawChevron(parent, poly, whichEnd, size, color, lw, fb) {   // FR90: an OPEN "V" head = an action
    if (!poly || !poly.length) return;
    const end = whichEnd === "end", tip = end ? poly[poly.length - 1] : poly[0], prev = end ? poly[poly.length - 2] : poly[1];
    let dx, dy;
    if (prev) { dx = tip.x - prev.x; dy = tip.y - prev.y; } else { dx = end ? fb.x : -fb.x; dy = end ? fb.y : -fb.y; }
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const bx = tip.x - dx * size, by = tip.y - dy * size, px = -dy, py = dx, half = size * 0.6;
    el("polyline", { points: `${bx + px * half},${by + py * half} ${tip.x},${tip.y} ${bx - px * half},${by - py * half}`,
                     fill: "none", stroke: color, "stroke-width": Math.max(2, lw), "stroke-linecap": "round", "stroke-linejoin": "round" }, parent);
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
  // FR93: a tunnel can pass THROUGH boxes (e.via, e.g. the home router): one continuous route a → via… → b that
  // enters each via box, crosses its centre and leaves towards the next. Hidden via boxes are skipped.
  const viaBoxes = (e) => (Array.isArray(e.via) ? e.via : []).map((id) => node(id)).filter((n) => n && visible(n)).map((n) => anchorBox(n, rbox(n)));
  const sideOf = (p, R) => Math.abs(p.x - R.x) < 0.5 ? "w" : Math.abs(p.x - R.x - R.w) < 0.5 ? "e" : Math.abs(p.y - R.y) < 0.5 ? "n" : "s";
  function longestMid(poly) {   // FR93: a through-route's label sits on its longest straight stretch
    let best = null;
    for (let i = 1; i < poly.length; i++) { const L = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
      if (!best || L > best.L) best = { L, x: (poly[i].x + poly[i - 1].x) / 2, y: (poly[i].y + poly[i - 1].y) / 2 }; }
    return best || poly[0];
  }
  function throughBox(p, q, R, c = center(R)) {   // orthogonal p (on R's outline) → c (R's centre / its gate) → q
    const into = (z) => (Math.abs(z.x - R.x) < 0.5 || Math.abs(z.x - R.x - R.w) < 0.5) ? { x: c.x, y: z.y } : { x: z.x, y: c.y };
    return [p, into(p), c, into(q), q];
  }
  // FR95: every leg of a through-route is draggable like a plain route. The route's own start/end offsets shape the
  // first/last leg; the rest (each leg's elbow, where it leaves / enters a via box) lives in e.legs["from>to"].
  const LEG_START = ["so", "ss", "sf"], LEG_END = ["eo", "es", "ef"];
  const viaIds = (e) => (Array.isArray(e.via) ? e.via : []).filter((id) => { const n = node(id); return n && visible(n); });
  function legSlot(e, ids, i, k) {   // where offset k of leg i is stored: [object, key]
    const last = ids.length - 2;
    if ((i === 0 && LEG_START.includes(k)) || (i === last && LEG_END.includes(k))) return e;
    const lk = ids[i] + ">" + ids[i + 1];
    e.legs = e.legs || {}; e.legs[lk] = e.legs[lk] || {}; return e.legs[lk];
  }
  function legO(e, ids, i) {
    const last = ids.length - 2, own = [...(i === 0 ? LEG_START : []), ...(i === last ? LEG_END : [])], o = {};
    const L = (e.legs && e.legs[ids[i] + ">" + ids[i + 1]]) || {};
    for (const k in L) if (!own.includes(k)) o[k] = L[k];
    for (const k of own) if (k in e) o[k] = e[k];
    return o;
  }
  function viaRouteSegs(aBox, bBox, e) {   // segs[j] = { leg, key, H } (null = the run across a via box's centre)
    const vb = viaBoxes(e), ids = [e.from, ...viaIds(e), e.to], boxes = [aBox, ...vb, bBox], last = boxes.length - 2;
    let pts = [], segs = [], ranges = [];   // ranges[i] = [first, last] index of leg i in pts (NT2)
    for (let i = 0; i <= last; i++) {
      const o = legO(e, ids, i);
      let leg = zRouteSegs(boxes[i], boxes[i + 1], o);
      // leaving a via box on the side it was entered = a dead end, not "through" → leave on the other axis instead
      if (i > 0 && sideOf(pts[pts.length - 1], boxes[i]) === sideOf(leg.pts[0], boxes[i])) leg = zRouteSegs(boxes[i], boxes[i + 1], { ...o, _H: !leg.H });
      const ls = leg.segs.map((key) => ({ leg: i, key, H: leg.H, cv: leg.cv }));
      if (i === 0) { pts = leg.pts; segs = ls; ranges.push([0, pts.length - 1]); }
      else { const c = ids[i] === e.gate ? gatePoint(e, boxes[i]) : center(boxes[i]);   // FR100: the pipe crosses at the gate
        const s0 = pts.length + 3;   // = where leg.pts[0] lands after the 5 through-box points replace the last point
        pts = pts.slice(0, -1).concat(throughBox(pts[pts.length - 1], leg.pts[0], boxes[i], c), leg.pts.slice(1)); segs = segs.concat([null, null, null, null], ls);
        ranges.push([s0, pts.length - 1]); }
    }
    return { pts, segs, ids, ranges };
  }
  const pipePoly = (aBox, bBox, e) => {
    if (Array.isArray(e.path) && e.path.length >= 2) return e.path.map((p) => ({ x: p.x, y: p.y }));
    return viaBoxes(e).length ? viaRouteSegs(aBox, bBox, e).pts : zRoute(aBox, bBox, e);
  };
  // NT1–NT5 (nested-tunnel scope): a physical link (cable / wifi / usb) between two boxes that a visible tunnel runs
  // between is drawn as a wider, see-through SLEEVE around that stretch of the tunnel — the tunnel travels THROUGH the
  // cable. The sleeve stops nestA × its radius short of end A (the link's `from`) and nestB × its radius short of end B,
  // so the tunnel sticks out of it at both ends; nestW = sleeve width ÷ tunnel width, nestOp = its opacity.
  // `nest: false` keeps the plain line. Positions never change: the sleeve simply follows the tunnel's route.
  const NEST = { nestA: 1, nestB: 2, nestW: 1.9, nestOp: 0.4 };
  // own = a LAN cable that carries no tunnel (NT14): it has nothing to show through, so it defaults to solid
  const nestDef = (k, own) => k === "nestOp" && own ? 1 : NEST[k];
  const nestP = (e, k, own) => typeof e[k] === "number" ? e[k] : nestDef(k, own);
  const isLan = (e) => (e.kind === "cable" || e.kind === "lan") && roleOf(e) === "link" && !e.fromOn && !e.toOn && e.nest !== false;
  function tunnelLegs(t) {   // [{ from, to, pts }] — each stretch of a drawn tunnel between two consecutive boxes
    if (!isTube(t) || !edgeDrawn(t) || t.fromOn || t.toOn) return [];
    const ends = edgeEnds(t); if (!ends) return [];
    if (!Array.isArray(t.path) && viaBoxes(t).length) {
      const r = viaRouteSegs(ends.a, ends.b, t);
      return r.ranges.map(([i, j], k) => ({ from: r.ids[k], to: r.ids[k + 1], pts: r.pts.slice(i, j + 1) }));
    }
    return [{ from: t.from, to: t.to, pts: pipePoly(ends.a, ends.b, t) }];
  }
  function nestHost(e) {   // the tunnel stretch this link carries (oriented from e.from to e.to), or null
    if (e.nest === false || roleOf(e) !== "link" || e.fromOn || e.toOn) return null;
    for (const t of S.data.edges) for (const L of tunnelLegs(t)) {
      if (L.from === e.from && L.to === e.to) return { t, pts: dedupe(L.pts) };
      if (L.from === e.to && L.to === e.from) return { t, pts: dedupe(L.pts).reverse() };
    }
    return null;
  }
  function trimPoly(poly, whichEnd, len) {   // cut len off one end, across as many segments as needed (null = nothing left)
    let p = whichEnd === "end" ? poly.slice().reverse() : poly.slice(), left = len;
    if (left < 0 && p.length >= 2) {   // NT8: negative = lengthen the end segment outward (reach into the box, up to its icon)
      const L = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
      p[0] = { x: p[0].x + (p[0].x - p[1].x) / L * -left, y: p[0].y + (p[0].y - p[1].y) / L * -left };
      return whichEnd === "end" ? p.reverse() : p;
    }
    while (p.length >= 2) {
      const L = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
      if (L > left) { const t = left / L; p[0] = { x: p[0].x + (p[1].x - p[0].x) * t, y: p[0].y + (p[1].y - p[0].y) * t }; break; }
      left -= L; p = p.slice(1);
    }
    if (p.length < 2) return null;
    return whichEnd === "end" ? p.reverse() : p;
  }
  function ownCable(e, a, b) {   // NT14: a LAN cable with no tunnel inside — the cable design along its own route
    const R = nestP(e, "nestW") * 22 / 2, s = trimPoly(dedupe(pipePoly(a, b, e)), "start", nestP(e, "nestA") * R);
    return { R, own: true, poly: s && trimPoly(s, "end", nestP(e, "nestB") * R) };
  }
  function sleevePoly(e, nh) {
    const R = nestP(e, "nestW") * (nh.t.pw || 22) / 2, s = trimPoly(nh.pts, "start", nestP(e, "nestA") * R);
    return { R, poly: s && trimPoly(s, "end", nestP(e, "nestB") * R) };
  }
  // NT10: a USB link shows the stick carrying data — a small light comes out of the source box (from under its icon),
  // rides the stick along the line and goes into the target box; the stick then travels back empty. 6 s loop, SVG
  // <animateMotion> (same markup in docs/gen_flow_svg.py); hidden when the viewer prefers reduced motion (CSS).
  const USB_T = 6, USB_KT = "0;0.1;0.45;0.55;0.9;1", USB_S = 1.8;
  const usbS = (e) => typeof e.usbS === "number" ? e.usbS : USB_S;   // NT12: moving stick's radius ÷ the line width
  function usbTrip(parent, poly, a, b, R) {
    if (!poly || poly.length < 2) return;
    const ca = center(a), cb = center(b), last = poly[poly.length - 1], f = (v) => (+v.toFixed(4)).toString();
    const len = (p) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.y - p[i].y), 0);
    const d = (p) => "M " + p.map((q) => `${f(q.x)} ${f(q.y)}`).join(" L ");
    const L0 = Math.hypot(poly[0].x - ca.x, poly[0].y - ca.y), Lp = len(poly), Lt = L0 + Lp + Math.hypot(cb.x - last.x, cb.y - last.y) || 1;
    const G = el("g", { class: "usb-trip" }, parent), mo = (g, path, kp) =>
      el("animateMotion", { dur: USB_T + "s", repeatCount: "indefinite", path, keyPoints: kp, keyTimes: USB_KT, calcMode: "linear" }, g);
    const sg = el("g", {}, G);   // the stick: waits while the light comes out, carries it over, waits, comes back empty
    el("circle", { r: R, fill: "#0b0e14", stroke: "#c9d1d9", "stroke-width": 1.5 }, sg);
    el("use", { href: "#ic-usb", x: -0.82 * R, y: -0.82 * R, width: 1.64 * R, height: 1.64 * R }, sg).style.color = "#c9d1d9";
    mo(sg, d(poly), "0;0;1;1;0;0");
    const lg = el("g", {}, G);   // the light (payload): computer centre → line start → line end → server centre
    el("circle", { r: 0.82 * R, fill: "#fff3a0", opacity: 0.35 }, lg); el("circle", { r: 0.36 * R, fill: "#fffbe0" }, lg);
    mo(lg, d([ca, ...poly, cb]), `0;${f(L0 / Lt)};${f((L0 + Lp) / Lt)};1;1;1`);
    el("animate", { attributeName: "opacity", values: "1;1;0;0", keyTimes: "0;0.5;0.55;1", dur: USB_T + "s", repeatCount: "indefinite" }, lg);
  }
  // NT13: a LAN link's sleeve is drawn as a LAN CABLE (the chosen design): one flat colour with a thin dark outline; at
  // each end a moulded boot — straight behind the head, |||| grip ribs, then a straight taper into the cable with a small
  // step at the cable's thickness — and a clear RJ45 head with 8 gold contacts and the latch lever on top. The plug tips
  // sit exactly where the sleeve ends (NT2 / NT8); nestOp still fades the whole cable so the tunnel can show through.
  // Sizes in units of the cable's half-width c (= the sleeve radius); mirrored in docs/gen_flow_svg.py cable_svg.
  const CBL = { headL: 1.26, headW: 1.52, straightL: 1.7, ribsL: 2.43, neckL: 3.39, step: 0.1, DARK: "#1f2328", HEAD: "#e9edf1", LATCH: "#d3dae1", GOLD: "#c9a43a" };
  function cablePlugs(poly) {   // [{ P (tip), u (unit, pointing out of the cable) }] for both ends
    const end = (P, Q) => { const L = Math.hypot(P.x - Q.x, P.y - Q.y) || 1; return { P, u: { x: (P.x - Q.x) / L, y: (P.y - Q.y) / L } }; };
    return [end(poly[0], poly[1]), end(poly[poly.length - 1], poly[poly.length - 2])];
  }
  function drawCable(parent, poly, color, c) {
    const K = CBL, j0 = trimPoly(poly, "start", K.neckL * c - 1), jacket = j0 && trimPoly(j0, "end", K.neckL * c - 1);
    const pts = dedupe(jacket || poly), d = "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L ");
    el("path", { d, fill: "none", stroke: K.DARK, "stroke-width": 2 * c + 3, "stroke-linejoin": "miter" }, parent);
    el("path", { d, fill: "none", stroke: color, "stroke-width": 2 * c, "stroke-linejoin": "miter" }, parent);
    if (!jacket) return;   // too short for two plugs: just the cable
    for (const { P, u } of cablePlugs(poly)) {
      const f = (a, b) => ({ x: P.x - u.x * a * c - u.y * b * c, y: P.y - u.y * a * c + u.x * b * c });   // a = back from the tip, b = across
      const poly_ = (q, attrs) => el("polygon", { points: q.map((v) => `${v.x},${v.y}`).join(" "), ...attrs }, parent);
      const ln = (a1, b1, a2, b2, s, w) => { const p = f(a1, b1), q = f(a2, b2); el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: s, "stroke-width": w }, parent); };
      const OLA = { stroke: K.DARK, "stroke-width": 1.4 }, hw = K.headW - 0.04, rw = K.headW - 0.1, nw = 1 + K.step;
      poly_([f(K.headL, -hw), f(K.straightL, -hw), f(K.ribsL, -rw), f(K.neckL, -nw), f(K.neckL, nw), f(K.ribsL, rw), f(K.straightL, hw), f(K.headL, hw)], { fill: color, ...OLA });   // boot
      for (let k = 0; k < 6; k++) { const a = K.straightL + 0.04 + k * (K.ribsL - K.straightL - 0.08) / 5, h = K.headW - 0.09 - (a - K.straightL) / (K.ribsL - K.straightL) * 0.06;
        ln(a, -h, a, h, K.DARK, 0.07 * c); }   // |||| grip ribs
      poly_([f(0, -K.headW), f(K.headL, -K.headW), f(K.headL, K.headW), f(0, K.headW)], { fill: K.HEAD, ...OLA });   // clear head
      for (let k = 0; k < 8; k++) { const b = -1.13 + k * 0.323; ln(0.07, b, 0.39, b, K.GOLD, Math.max(0.8, 0.08 * c)); }   // gold contacts
      poly_([f(0.48, -0.39), f(0.48, 0.39), f(1.52, 0.5), f(1.61, 0.5), f(1.61, -0.5), f(1.52, -0.5)], { fill: K.LATCH, stroke: K.DARK, "stroke-width": 1.5 });   // latch lever
      ln(0.48, -0.39, 0.48, 0.39, K.DARK, 2);   // its hinge
    }
  }
  function panelLine(e, ends) {   // the line the arrow box is placed against + dragged relative to (NT9: for a sleeve, the
    const nh = nestHost(e);        // tunnel stretch it wraps — fixed while end A / B / width change, so the box never jumps)
    return nh ? nh.pts : dedupe(pipePoly(ends.a, ends.b, e));
  }
  function gateSplit(poly, e) {   // FR93: the pipe is interrupted at the gate box's centre (an opened port)
    const gn = e.gate && node(e.gate);
    if (!gn || !visible(gn) || !(e.via || []).includes(e.gate)) return null;
    const c = gatePoint(e, anchorBox(gn, rbox(gn))), k = poly.findIndex((p) => Math.abs(p.x - c.x) < 0.5 && Math.abs(p.y - c.y) < 0.5);
    if (k <= 0 || k >= poly.length - 1) return null;
    return { c, a: trimEnd(poly.slice(0, k + 1), "end", gateR(e)), b: trimEnd(poly.slice(k), "start", gateR(e)) };
  }
  const GATE_GAP = 20;
  const gateR = (e) => typeof e.gr === "number" ? e.gr : GATE_GAP;   // FR102: the gate badge's radius (resizable)
  // FR100: the open gate can be dragged anywhere inside its box: e.gx / e.gy = offset from the box's centre (the badge
  // stays fully inside the box). The pipe crosses the box through the gate, and an arrow can attach to it ("<pipe>:gate").
  function gatePoint(e, R) {
    const c = center(R), cl = (v, L) => { const m = Math.max(0, L / 2 - gateR(e)); return Math.max(-m, Math.min(m, v)); };
    return { x: c.x + cl(ofs(e.gx), R.w), y: c.y + cl(ofs(e.gy), R.h) };
  }
  function gateOf(pe) {   // the gate point of a visible gated pipe (null = no gate shown)
    const gn = pe && pe.gate && node(pe.gate);
    if (!gn || !visible(gn) || !(pe.via || []).includes(pe.gate) || !pipePolyOf(pe)) return null;
    return gatePoint(pe, anchorBox(gn, rbox(gn)));
  }
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
  // FR89: a device with an icon and nothing nested inside it is drawn AS its icon (pictogram), not a box.
  const isPictogram = (n) => n.nodeType === "device" && !!n.icon && !isContainer(n);
  function pictoGeom(b, lines) {   // icon fills the box above the label lines; label sits under the icon
    const lh = lines.filter((l) => l).length * 15, s = Math.max(16, Math.min(b.w, b.h - lh - (lh ? 6 : 0)));
    const y = b.y + (b.h - s - lh - (lh ? 6 : 0)) / 2;
    return { s, x: b.x + (b.w - s) / 2, y, ty: y + s + 16 };
  }
  const ICON_BOX = {};   // FR92: icon → [x, y, w, h] of its drawn glyph in the 24×24 grid (data-bbox in icons.svg)
  // FR114: an icon is a sprite name, or "img:<key>" = an uploaded picture kept in the diagram (meta.images[key] = data URL / link)
  const imgSrc = (icon) => /^img:/.test(icon || "") ? (((S.data && S.data.meta && S.data.meta.images) || {})[icon.slice(4)] || null) : null;
  function drawIcon(g, icon, x, y, s, color) {
    const src = imgSrc(icon);
    const u = src ? el("image", { href: src, x, y, width: s, height: s, preserveAspectRatio: "xMidYMid meet", class: "nicon" }, g)
                  : el("use", { href: "#ic-" + icon, x, y, width: s, height: s, class: "nicon" }, g);
    u.style.color = color; u.style.cursor = "pointer"; return u;
  }
  function anchorBox(n, b) {   // FR92: lines attach to a pictogram's DRAWN icon, not its invisible box
    if (!n || !b || !isPictogram(n)) return b;
    const g = pictoGeom(b, String(n.label || "").split("\n")), bb = ICON_BOX[n.icon] || [0, 0, 24, 24], k = g.s / 24;
    return { x: g.x + bb[0] * k, y: g.y + bb[1] * k, w: bb[2] * k, h: bb[3] * k };
  }
  const EBADGE = 30;   // FR89: size of the icon drawn on an arrow (cable / wifi / usb / tunnel / tor)
  // FR90: four line types = what a line MEANS, told apart by PATTERN (colour stays the route's own, FR59).
  const LINE_ROLES = {
    link:   { label: "link — physically connected" },
    tunnel: { label: "tunnel — a route carrying traffic" },
    action: { label: "action — you do this, to that" },
    info:   { label: "information going in / out" },
  };
  const MEDIUM = { cable: 1, lan: 1, wifi: 1, usb: 1 };   // a link's physical medium (badge on the line)
  const roleOf = (e) => e.role || (e.kind === "pipe" ? "tunnel" : MEDIUM[e.kind] ? "link" : null);
  const isTube = (e) => roleOf(e) === "tunnel";
  // FR103: the COLOUR of an action / information line says what it costs you (money first, then dependence):
  const COST = {
    paid:    { color: "#e5484d", label: "costs money" },
    central: { color: "#f97316", label: "at a company you depend on (Cloudflare, Tailscale, DuckDNS…)" },
    free:    { color: "#eab308", label: "free & in your own hands (e.g. your router)" },
  };
  const lineColor = (e) => e.color || (COST[e.cost] && COST[e.cost].color) || null;   // an explicit colour still wins   // a tunnel is always drawn as the Mario pipe
  const DOG = 14;   // folded-corner size of an info block
  function drawDogEar(parent, b, pal) {   // "document" corner at the top-right of an info block
    const x = b.x + b.w, y = b.y;
    el("path", { d: `M ${x - DOG} ${y} L ${x} ${y + DOG} L ${x} ${y} Z`, fill: (S.data.meta && S.data.meta.background) || "#0b0e14" }, parent);
    el("path", { d: `M ${x - DOG} ${y} L ${x - DOG} ${y + DOG} L ${x} ${y + DOG} Z`, fill: pal.stroke, "fill-opacity": 0.5,
                 stroke: pal.stroke, "stroke-width": 1.2 }, parent);
  }
  // FR104: ⌖ anchor (toggle bar). Select a box, press ⌖: the box's CURRENT screen spot becomes the anchor — every view
  // (toggle state) and every diagram that contains that box (same id) is panned, keeping its own zoom, so the box's
  // centre (a pictogram's drawn icon, FR92) lands on that same spot. ⌖ with nothing selected — or on the anchored box —
  // releases it. Per browser (localStorage), never in the diagram JSON.
  const ANCHOR_KEY = "flow.anchor";
  const nodeName = (n) => String(n.label || "").replace(/\s*\n\s*/g, " ").trim() || n.id;   // the label on one line
  function getAnchor() {
    try { const a = JSON.parse(localStorage.getItem(ANCHOR_KEY) || "null");
      if (a && typeof a.id === "string" && isFinite(a.x) && isFinite(a.y)) return a; } catch (_) {}
    return null;
  }
  function setAnchor(a) { try { if (a) localStorage.setItem(ANCHOR_KEY, JSON.stringify(a)); else localStorage.removeItem(ANCHOR_KEY); } catch (_) {} }
  function itemScreen(id) {   // a box's (drawn) centre on screen, or null if this view doesn't show it
    const n = node(id); if (!n || !visible(n)) return null;
    const c = center(anchorBox(n, rbox(n))); return { x: S.view.x + c.x * S.view.k, y: S.view.y + c.y * S.view.k };
  }
  // FR112: moving / zooming the whole diagram is a change you can save — the save button lights up (no undo step), and
  // Save stores the view in the diagram (meta.view = the diagram point at the canvas centre + the zoom, so it holds on any
  // window size). A load uses the saved view first, else this browser's remembered one (FR94), else ⤢ fit. While ⌖ is
  // anchored (FR104) the anchor spot moves along with your pan / zoom, so the anchor never snaps the view back.
  function currentView() {
    const r = svg.getBoundingClientRect(), k = S.view.k;
    return { cx: Math.round((r.width / 2 - S.view.x) / k * 10) / 10, cy: Math.round((r.height / 2 - S.view.y) / k * 10) / 10, k: Math.round(k * 1000) / 1000 };
  }
  function savedView() {   // the diagram's saved view as a pan/zoom for this window, or null
    const v = S.data && S.data.meta && S.data.meta.view;
    if (!v || ![v.cx, v.cy, v.k].every((n) => typeof n === "number" && isFinite(n)) || v.k < 0.2 || v.k > 3) return null;
    const r = svg.getBoundingClientRect();
    return { x: r.width / 2 - v.cx * v.k, y: r.height / 2 - v.cy * v.k, k: v.k };
  }
  function viewMoved() {   // the user panned / zoomed / fitted: unsaved change + keep an active anchor in step
    setDirty(true);
    const a = getAnchor(), p = a && itemScreen(a.id);
    if (p) setAnchor({ ...a, x: Math.round(p.x), y: Math.round(p.y) });
  }
  function applyAnchor() {   // put the anchored box on the anchor spot, if this view shows it (zoom unchanged)
    const a = getAnchor(), n = a && node(a.id);
    if (!n || !visible(n)) return false;
    const c = center(anchorBox(n, rbox(n))); S.view.x = a.x - c.x * S.view.k; S.view.y = a.y - c.y * S.view.k; applyView(); return true;
  }
  function toggleAnchor() {
    const a = getAnchor(), an = a && node(a.id);
    if (a && (!S.sel || a.id === S.sel)) { setAnchor(null); status(`⌖ anchor on <b>${an ? nodeName(an) : a.id}</b> released`); buildToggles(); return; }
    const id = S.sel || "server";   // nothing selected → the default: Your new private server
    const p = itemScreen(id);
    if (!p) { status(node(id) ? `<b>${nodeName(node(id))}</b> isn't shown in this view` : "select a box first, then press ⌖"); return; }
    setAnchor({ id, x: Math.round(p.x), y: Math.round(p.y) }); buildToggles();
    status(`⌖ anchored on <b>${nodeName(node(id))}</b> — every view and diagram containing it now puts it on this spot (⌖ again to release)`);
  }
  // FR106: 🔨 nail — give the selected box ONE position everywhere: its position + size are copied onto the box with the
  // same id in every OTHER diagram (written straight to those files via the dash write-API). The source is the box's
  // position in the majority of views: its free x/y — a conditional nesting (e.g. the server inside Your computer for
  // the VM install, containerWhen) is the exception and is left alone. An always-nested box copies its offset inside
  // its parent (only where the other diagram nests it in the same parent).
  async function nailEverywhere() {
    if (!S.sel) { status("select a box first, then press 🔨 to give it this position + size in every diagram"); return; }
    if (!S.backend) { status("🔨 needs <b>./dash serve</b> — it writes the other diagrams to disk"); return; }
    const n = node(S.sel), nested = !!(n.container && !n.containerWhen);
    const geo = nested ? { cdx: n.cdx, cdy: n.cdy, w: n.w, h: n.h } : { x: n.x, y: n.y, w: n.w, h: n.h };
    const changed = [], same = [], skipped = [];
    for (const it of S.index.diagrams) {
      if (it.id === S.id) continue;
      let data; try { const r = await fetch(`${DIAG_DIR}/${it.id}.json`, { cache: "no-store" }); if (!r.ok) continue; data = await r.json(); } catch (_) { continue; }
      const t = (data.nodes || []).find((k) => k.id === n.id); if (!t) continue;
      if (nested !== !!(t.container && !t.containerWhen) || (nested && t.container !== n.container)) { skipped.push(it.id); continue; }
      const before = JSON.stringify(t);
      for (const k in geo) if (typeof geo[k] === "number") t[k] = Math.round(geo[k]);
      if (nested && n.snapSide) t.snapSide = n.snapSide;
      if (JSON.stringify(t) === before) { same.push(it.id); continue; }
      try { const r = await fetch(`/api/diagram/${it.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: serialize(data) });
        if (r.ok) changed.push(it.id); else skipped.push(it.id + " (save failed)"); } catch (_) { skipped.push(it.id + " (save failed)"); }
    }
    const nm = nodeName(n), cond = n.containerWhen ? " (its conditional nesting here is kept)" : "";
    status(changed.length ? `🔨 <b>${nm}</b> now has this position + size in: <b>${changed.join(", ")}</b>${cond}`
      + (same.length ? ` · already equal: ${same.join(", ")}` : "") + (skipped.length ? ` · skipped (nested differently): ${skipped.join(", ")}` : "")
      : `🔨 <b>${nm}</b>: ${same.length ? "already the same in " + same.join(", ") : "no other diagram has this box"}${skipped.length ? " · skipped: " + skipped.join(", ") : ""}`);
  }
  function nailButton() {
    const btn = document.createElement("button"); btn.className = "anchorbtn nailbtn";
    btn.innerHTML = '<svg width="15" height="15" aria-hidden="true"><use href="#ic-hammer" width="15" height="15"/></svg>';   // compact: FR105 one-line bar
    btn.setAttribute("aria-label", "fix position everywhere");
    btn.setAttribute("data-help", "<b>Fix position everywhere</b> — select a box, then press 🔨: its position + size are copied onto the "
      + "same box in <b>every other diagram</b> (written straight to those files — not undoable with Ctrl+Z). Uses the position "
      + "most views share: a box nested only in some views (the server inside <i>Your computer</i> for VM) keeps that nesting.");
    btn.addEventListener("mouseenter", () => showTip(btn)); btn.addEventListener("mouseleave", () => { $("tooltip").style.display = "none"; });
    btn.onclick = nailEverywhere; return btn;
  }
  function anchorButton() {
    const a = getAnchor(), an = a && node(a.id), btn = document.createElement("button");
    btn.className = "anchorbtn" + (a ? " on" : ""); btn.textContent = "⌖";   // icon-only + highlighted when on: keeps the bar one line (FR105)
    btn.setAttribute("aria-label", "anchor / centre");
    btn.setAttribute("data-help", (a ? `<b>Anchored on ${an ? nodeName(an) : a.id}</b> — press ⌖ with nothing selected to release.<br>` : "")
      + "<b>Anchor / centre</b> — select a box, then press ⌖: every view (toggle state) and every diagram that "
      + "contains that box puts it on the same spot on screen as now (each keeps its own zoom). Nothing selected = <b>Your new private "
      + "server</b>. While anchored, press ⌖ with nothing selected (or the anchored box selected) to release it.");
    btn.addEventListener("mouseenter", () => showTip(btn)); btn.addEventListener("mouseleave", () => { $("tooltip").style.display = "none"; });
    btn.onclick = toggleAnchor; return btn;
  }
  function buildLegend() {   // small key, top-right of the canvas: box shapes (FR82) + line types (FR90), whichever are used
    const host = $("legend"), used = new Set(S.data.nodes.map((n) => n.nodeType).filter((t) => NODE_TYPES[t]));
    const usedR = S.data.edges.some((e) => roleOf(e));
    host.hidden = !used.size && !usedR && !S.data.edges.some((e) => COST[e.cost]); host.textContent = "";
    const body = document.createElement("div"); body.className = "lgbody"; host.appendChild(body);
    let sec = null;   // FR110: each caption + its rows is one section, so a reshaped legend wraps whole sections into columns
    const row = (draw, label) => {
      const r = document.createElement("div"); r.className = "lg";
      const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("width", 34); s.setAttribute("height", 18);
      draw(s); const t = document.createElement("span"); t.textContent = label; r.append(s, t); sec.appendChild(r);
    };
    const cap = (txt) => { sec = document.createElement("div"); sec.className = "lgsec"; body.appendChild(sec);
      const c = document.createElement("div"); c.className = "lgcap"; c.textContent = txt; sec.appendChild(c); };
    if (used.size) {
      cap("boxes");
      for (const k of Object.keys(NODE_TYPES)) row((s) => {
        const T = NODE_TYPES[k], b = { x: 1.5, y: 1.5, w: 31, h: 15 }, r = Math.min(T.rx(b), 7.5);
        if (k === "device") { const u = el("use", { href: "#ic-laptop", x: 8, y: 0, width: 18, height: 18 }, s); u.style.color = "#8b949e"; return; }   // FR89: pictograms
        const rc = el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: r, ry: r, fill: "#14181f", stroke: "#8b949e" }, s);
        rc.style.strokeWidth = Math.min(T.sw, 2.5); if (T.dash) rc.style.strokeDasharray = T.dash;
        if (k === "info") el("path", { d: `M ${b.x + b.w - 6} ${b.y} L ${b.x + b.w - 6} ${b.y + 6} L ${b.x + b.w} ${b.y + 6} Z`, fill: "#8b949e" }, s);
      }, NODE_TYPES[k].label);
    }
    if (usedR) {
      cap("lines");
      for (const k of Object.keys(LINE_ROLES)) row((s) => drawLineSample(s, k), LINE_ROLES[k].label);
    }
    if (S.data.edges.some((e) => COST[e.cost])) {   // FR103
      cap("line colour — actions + info");
      for (const k of Object.keys(COST)) row((s) => {
        el("line", { x1: 2, y1: 9, x2: 32, y2: 9, stroke: COST[k].color, "stroke-width": 3, "stroke-dasharray": "7 4" }, s);
      }, COST[k].label);
    }
    const grip = document.createElement("div"); grip.className = "lggrip"; grip.title = "Drag to reshape the legend (labels wrap; it stops where something would not fit) · double-click the legend = back to default";
    host.appendChild(grip);
    applyLegendGeom(recallLegend());
  }
  // FR110: the legend can be moved (drag it) and reshaped (drag its corner grip; labels wrap, sections flow into columns).
  // Its spot + size are remembered per browser and per diagram (localStorage, like the FR94 view — never in the JSON).
  // A reshape that would make anything not fit is blocked (the size stays at the last one that fit). Double-click = default.
  const LEG_KEY = (id) => "flow.legend." + id;
  function recallLegend() {
    try { const g = JSON.parse(localStorage.getItem(LEG_KEY(S.id)) || "null");
      if (g && [g.x, g.y].every((n) => typeof n === "number" && isFinite(n))) return g; } catch (_) {}
    return null;
  }
  function storeLegend(g) { try { if (g) localStorage.setItem(LEG_KEY(S.id), JSON.stringify(g)); else localStorage.removeItem(LEG_KEY(S.id)); } catch (_) {} }
  function legendFits() {
    const b = $("legend").querySelector(".lgbody");
    return !b || (b.scrollWidth <= b.clientWidth + 1 && b.scrollHeight <= b.clientHeight + 1);
  }
  function clampLegend() {   // keep it inside the canvas (window resized, or a spot remembered on a bigger screen)
    const host = $("legend"), W = $("canvaswrap").clientWidth, Hc = $("canvaswrap").clientHeight;
    if (!host.style.left) return;
    const x = Math.max(0, Math.min(W - host.offsetWidth, parseFloat(host.style.left))), y = Math.max(0, Math.min(Hc - host.offsetHeight, parseFloat(host.style.top)));
    host.style.left = x + "px"; host.style.top = y + "px";
  }
  function applyLegendGeom(g) {
    const host = $("legend");
    host.classList.toggle("sized", !!(g && g.w));
    if (!g) { for (const k of ["left", "top", "right", "width", "height"]) host.style[k] = ""; return; }
    host.style.right = "auto"; host.style.left = g.x + "px"; host.style.top = g.y + "px";
    host.style.width = g.w ? g.w + "px" : ""; host.style.height = g.h ? g.h + "px" : "";
    if (g.w && !legendFits()) { host.classList.remove("sized"); host.style.width = host.style.height = ""; }   // remembered shape no longer fits (more rows now)
    clampLegend();
  }
  (function legendDrag() {
    const host = $("legend"); let d = null;
    host.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const r = host.getBoundingClientRect(), c = $("canvaswrap").getBoundingClientRect();
      d = { resize: ev.target.classList.contains("lggrip"), sx: ev.clientX, sy: ev.clientY, x0: r.left - c.left, y0: r.top - c.top, w0: r.width, h0: r.height };
      host.style.right = "auto"; host.style.left = d.x0 + "px"; host.style.top = d.y0 + "px";
      if (d.resize) { host.classList.add("sized"); host.style.width = d.w0 + "px"; host.style.height = d.h0 + "px"; }
      host.classList.add("moving"); host.setPointerCapture(ev.pointerId); ev.preventDefault(); ev.stopPropagation();
    });
    host.addEventListener("pointermove", (ev) => {
      if (!d) return;
      const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      if (!d.resize) { host.style.left = d.x0 + dx + "px"; host.style.top = d.y0 + dy + "px"; clampLegend(); return; }
      const pw = host.style.width, ph = host.style.height, nw = Math.max(60, d.w0 + dx) + "px", nh = Math.max(30, d.h0 + dy) + "px";
      // blocked: try width and height separately (slide along the limit), else keep the last shape that fit
      const fit = [[nw, nh], [nw, ph], [pw, nh]].find(([w, h]) => { host.style.width = w; host.style.height = h; return legendFits(); });
      host.classList.toggle("blocked", !fit || fit[0] !== nw || fit[1] !== nh);
      if (!fit) { host.style.width = pw; host.style.height = ph; }
    });
    const end = () => {
      if (!d) return;
      host.classList.remove("moving", "blocked");
      const g = { x: Math.round(parseFloat(host.style.left)), y: Math.round(parseFloat(host.style.top)) };
      if (host.classList.contains("sized")) { g.w = Math.round(host.offsetWidth); g.h = Math.round(host.offsetHeight); }
      storeLegend(g); d = null;
    };
    host.addEventListener("pointerup", end); host.addEventListener("pointercancel", end);
    host.addEventListener("dblclick", () => { storeLegend(null); applyLegendGeom(null); status("legend back in its default spot and shape"); });
    window.addEventListener("resize", clampLegend);
  })();
  function drawLineSample(s, role) {   // the legend's 34×18 picture of each FR90 line type
    const C = "#8b949e";
    if (role === "tunnel") { drawMarioPipe(s, [{ x: 4, y: 9 }, { x: 30, y: 9 }], C, 7); return; }
    const w = lineWidth(role, "plain"), x2 = role === "link" ? 32 : role === "action" ? 31 : 24;
    const l = el("line", { x1: 2, y1: 9, x2, y2: 9, stroke: C, "stroke-width": w }, s);
    const dash = lineDash(role, "plain", w); if (dash && dash !== "none") l.setAttribute("stroke-dasharray", dash);
    if (role === "info") l.setAttribute("stroke-linecap", "round");
    if (role === "link") el("circle", { cx: 17, cy: 9, r: 4, fill: "#0b0e14", stroke: C, "stroke-width": 1.5 }, s);
    if (role === "action") drawChevron(s, [{ x: 2, y: 9 }, { x: 32, y: 9 }], "end", 7, C, 2, { x: 1, y: 0 });
    if (role === "info") drawArrowHead(s, [{ x: 2, y: 9 }, { x: 32, y: 9 }], "end", 8, C, { x: 1, y: 0 });
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
    const gates = [];   // FR93: open-port badges, drawn on top of the device icons

    let selPoly = null;
    const gFront = el("g", { class: "front-edges" });   // FR96: z "front" lines, put above the boxes once they're drawn
    const gSleeve = el("g", { class: "sleeves" });   // NT3: sleeves go above every tunnel (so the tunnel shows INSIDE them)
    for (const e of S.data.edges) {
      if (!visible(e)) continue;
      const ends = edgeEnds(e, boxOf); if (!ends) continue;
      const { a, b } = ends, kind = e.kind || "plain";
      const nh = nestHost(e), sl = nh ? sleevePoly(e, nh) : isLan(e) ? ownCable(e, a, b) : null;   // NT14: every LAN line is a cable
      const g = el("g", { class: "edge k-" + kind + (S.selEdge === e.id ? " sel" : ""), "data-edge": e.id }, e.z === "front" ? gFront : sl && sl.poly ? gSleeve : gEdges);
      let mx, my, iconOnLine = false;
      const role = roleOf(e);
      if (sl && sl.poly) {   // NT1–NT4: the link drawn as a see-through sleeve around the tunnel it carries; its icon sits on it
        el("path", { class: "hit", d: "M " + sl.poly.map((p) => `${p.x} ${p.y}`).join(" L "), fill: "none" }, g).style.strokeWidth = 2 * sl.R;
        const sg = el("g", { opacity: nestP(e, "nestOp", !!sl.own) }, g);
        if (kind === "cable" || kind === "lan") drawCable(sg, sl.poly, lineColor(e) || "#7b828a", sl.R);   // NT13
        else drawMarioPipe(sg, sl.poly, lineColor(e) || "#8b949e", 2 * sl.R);
        if (S.selEdge === e.id) selPoly = sl.poly;
        const m = midOfPoly(sl.poly); mx = m.x; my = m.y;
        const badge = kind !== "plain" && EDGE_ICON[kind];
        if (badge) {
          el("circle", { cx: mx, cy: my, r: EBADGE / 2 + 5, fill: "#0b0e14", stroke: lineColor(e) || "#6e7681", "stroke-width": 2 }, g);
          const u = el("use", { href: "#ic-" + badge, x: mx - EBADGE / 2, y: my - EBADGE / 2, width: EBADGE, height: EBADGE }, g);
          u.style.color = "#c9d1d9"; iconOnLine = true;
        }
      } else if (isTube(e)) {
        const poly = dedupe(pipePoly(a, b, e));
        el("path", { class: "hit", d: "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "), fill: "none" }, g);
        const gs = gateSplit(poly, e);   // FR93: port-forward = the pipe is broken open at the router
        if (gs) { drawMarioPipe(g, gs.a, e.color || "#8b949e", e.pw, e.casing); drawMarioPipe(g, gs.b, e.color || "#8b949e", e.pw, e.casing);
          gates.push({ id: e.id, c: gs.c, r: gateR(e), color: e.color || "#8b949e" }); }
        else drawMarioPipe(g, poly, e.color || "#8b949e", e.pw, e.casing);
        if (S.selEdge === e.id) selPoly = poly;
        const m = e.via && e.via.length ? longestMid(poly) : poly[Math.max(1, Math.floor(poly.length / 2)) - 1]; mx = m.x; my = m.y;
      } else {
        // arrows connect side-MIDPOINT → side-midpoint, straight or 90° only, snap-to-straight (via zRoute)
        const poly = dedupe(pipePoly(a, b, e));
        const lw = typeof e.lw === "number" ? e.lw : lineWidth(role, kind);
        // FR90: a link has no direction (traffic both ways); action/info point from source to target
        const dir = role === "link" ? "none" : (e.dir || "to"), ah = Math.max(typeof e.ah === "number" ? e.ah : 12, lw * 2.5);   // to=A→B, from=B→A, both=A↔B; head never thinner than the line
        const cut = role === "action" ? lw * 0.6 : ah * 0.8;   // an open chevron needs the line to reach its tip
        let wp = poly;   // line stops at the head's base so a thick line's butt never pokes past the tip
        if (dir === "to" || dir === "both") wp = trimEnd(wp, "end", cut);
        if (dir === "from" || dir === "both") wp = trimEnd(wp, "start", cut);
        const d = "M " + wp.map((p) => `${p.x} ${p.y}`).join(" L ");
        const hit = el("path", { class: "hit", d: "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "), fill: "none" }, g);
        const lc = lineColor(e), col = lc || (S.selEdge === e.id ? "#58a6ff" : "#6e7681");
        const w = el("path", { class: "wire", d, fill: "none" }, g);
        // FR77: inline style, NOT attributes — the .edge .wire / .k-cable CSS rules would override stroke-width/stroke
        w.style.strokeWidth = lw;
        if (lc) w.style.stroke = lc;
        const dash = lineDash(role, kind, lw);   // FR90 pattern (inline: beats the .k-wifi CSS dash)
        if (dash) { w.style.strokeDasharray = dash; if (role === "info") w.style.strokeLinecap = "round"; }
        hit.style.strokeWidth = Math.max(14, lw + 10);   // keep a thick line easy to click
        // arrowheads drawn by hand → always sit AT the box edge (no min-length blind spot), size/colour-settable
        const fb = { x: center(b).x - center(a).x, y: center(b).y - center(a).y };
        const head = role === "action" ? (pt, end) => drawChevron(g, pt, end, ah, col, lw, fb) : (pt, end) => drawArrowHead(g, pt, end, ah, col, fb);
        if (dir === "to" || dir === "both") head(poly, "end");
        if (dir === "from" || dir === "both") head(poly, "start");
        if (S.selEdge === e.id) selPoly = poly;
        const m = midOfPoly(poly); mx = m.x; my = m.y;
        const badge = (kind !== "plain" && EDGE_ICON[kind]) || (role === "info" ? "doc" : null);   // FR90: info carries a document
        if (badge) {   // FR89: a large badge ON the line says what the arrow is
          el("circle", { cx: mx, cy: my, r: EBADGE / 2 + 5, fill: "#0b0e14", stroke: lineColor(e) || "#6e7681", "stroke-width": 2 }, g);
          const u = el("use", { href: "#ic-" + badge, x: mx - EBADGE / 2, y: my - EBADGE / 2, width: EBADGE, height: EBADGE }, g);
          u.style.color = "#c9d1d9";
          iconOnLine = true;
        }
        if (kind === "usb") usbTrip(g, poly, a, b, usbS(e) * lw);   // NT10 / NT12: stick radius = usbS × line width
      }
      if (e.label) { const t = el("text", { x: mx, y: my - (isTube(e) ? 18 : iconOnLine ? EBADGE / 2 + 12 : 4), "text-anchor": "middle" }, g);
        if (iconOnLine) t.setAttribute("class", "halo");
        t.textContent = e.label; }
    }

    // draw containers first, then normal nodes, then contained children on top
    const rank = (n) => activeContainerOf(n) ? 2 : (isContainer(n) ? 0 : 1);
    for (const n of [...vis].sort((a, b) => rank(a) - rank(b))) {
      const pal = PALETTE[n.color] || PALETTE.note, bx = boxOf[n.id];
      const g = el("g", { class: "node" + (isContainer(n) ? " container" : "") + (S.sel === n.id ? " sel" : ""),
                          "data-id": n.id }, gNodes);
      const T = NODE_TYPES[n.nodeType], r = T ? T.rx(bx) : 8;   // FR82: block shape = what the box IS
      const lines = String(n.label || "").split("\n"), cx = bx.x + bx.w / 2;
      if (isPictogram(n)) {   // FR89: a device IS its icon — no box; the (invisible) box still sizes + anchors it
        // FR99: the click area + selection outline are the DRAWN icon (its measured outline), not the larger layout box
        const hb = anchorBox(n, bx);
        const rect = el("rect", { x: hb.x, y: hb.y, width: hb.w, height: hb.h, rx: 3, ry: 3, fill: "transparent", stroke: "none" }, g);
        if (S.sel === n.id) { rect.setAttribute("stroke", pal.stroke); rect.style.strokeWidth = 1.5; }
        const pg = pictoGeom(bx, lines);
        drawIcon(g, n.icon, pg.x, pg.y, pg.s, pal.stroke);
        lines.forEach((ln, i) => { const t = el("text", { x: cx, y: pg.ty + i * 15, "text-anchor": "middle", class: "halo" }, g); t.textContent = ln; });
      } else {
        const rect = el("rect", { x: bx.x, y: bx.y, width: bx.w, height: bx.h, rx: r, ry: r, fill: pal.fill, stroke: pal.stroke }, g);
        if (T) { rect.style.strokeWidth = T.sw; if (T.dash) rect.style.strokeDasharray = T.dash; }   // inline: beats .node rect CSS
        if (n.nodeType === "info") drawDogEar(g, bx, pal);
        // FR54/FR76: pipes visible through the box (inline style — must beat the .container CSS opacity)
        if (n.seeThrough || autoSeeThrough(n)) rect.style.fillOpacity = "0.3";
        let ty = bx.y + bx.h / 2 + 4;
        if (n.icon) {
          const is = n.nodeType === "device" ? 34 : 24;   // FR89: a container device keeps its box, with a bigger icon
          drawIcon(g, n.icon, cx - is / 2, bx.y + 6, is, pal.stroke);
          ty = bx.y + is + 18;
        }
        const startY = n.icon ? ty : ty - (lines.length - 1) * 8;
        lines.forEach((ln, i) => { const t = el("text", { x: cx, y: startY + i * 15, "text-anchor": "middle" }, g); t.textContent = ln; });
      }
      if (n.childDiagram) { const d = el("text", { x: bx.x + bx.w - Math.max(8, r * 0.7), y: bx.y + 14, "text-anchor": "end", class: "drill" }, g); d.textContent = "⊕ open"; }
    }
    for (const gt of gates) {   // FR93: the gap in the pipe shows an opened port (click = select that tunnel)
      const gg = el("g", { class: "edge gate" + (S.selEdge === gt.id ? " sel" : ""), "data-edge": gt.id }, gNodes), s = gt.r * 1.5;
      el("circle", { cx: gt.c.x, cy: gt.c.y, r: gt.r - 1, fill: "#0b0e14", stroke: gt.color, "stroke-width": 3 }, gg);
      const u = el("use", { href: "#ic-barrier", x: gt.c.x - s / 2, y: gt.c.y - s / 2, width: s, height: s }, gg); u.style.color = gt.color;
    }
    gEdges.appendChild(gSleeve);   // NT3: after all tunnels, still under the boxes
    gNodes.appendChild(gFront);   // FR102: "front" lines go above the gate badges too (an arrowhead on a gate stays visible)
    // resize handles on the selected node — drag an edge (w/h) or a corner (diagonal)
    if (S.sel) { const sn = node(S.sel); if (sn && visible(sn) && boxOf[sn.id]) drawHandles(anchorBox(sn, boxOf[sn.id])); }   // FR99: on the icon
    if (selPoly) drawEndHandles(selPoly);
    if (S.ghost) drawGhosts(boxOf);   // FR87
    updateEdgePanel();
  }
  function updateEdgePanel() {   // contextual box for the selected arrow: direction + head size + width + colour
    const p = $("edgepanel");
    const e = S.selEdge && S.data.edges.find((x) => x.id === S.selEdge);
    const ends = e && edgeEnds(e), a = ends && ends.a, b = ends && ends.b;
    if (!e || !a || !b) { p.style.display = "none"; S._panelEdge = null; return; }
    const poly = panelLine(e, ends), mid = midOfPoly(poly), k = S.view.k;
    p.style.display = "block";   // shown before measuring: FR79 the box sits clear of the line so every segment stays grabbable
    const W = p.offsetWidth, Hh = p.offsetHeight, mx = S.view.x + mid.x * k, my = S.view.y + mid.y * k, pad = ((e.pw || 22) / 2) * k + 8;
    const hits = (x, y) => poly.some((q, i) => {   // would the box at (x, y) cover any segment of the line?
      if (!i) return false;
      const P = poly[i - 1], x0 = S.view.x + Math.min(P.x, q.x) * k - pad, x1 = S.view.x + Math.max(P.x, q.x) * k + pad;
      const y0 = S.view.y + Math.min(P.y, q.y) * k - pad, y1 = S.view.y + Math.max(P.y, q.y) * k + pad;
      return x < x1 && x + W > x0 && y < y1 && y + Hh > y0;
    });
    const spots = [[mx, my - Hh - 16], [mx + 16, my - Hh / 2], [mx - W - 16, my - Hh / 2], [mx, my + 16], [mx - W / 2, my - Hh - 16]];
    // FR98: a box the user moved sits where they left it — e.bp = its top-left offset from the line's midpoint, in
    // diagram units (saved with the diagram, so it follows the line on pan / zoom / box moves); else the auto spot
    const bp = e.bp && typeof e.bp.dx === "number" && typeof e.bp.dy === "number" ? e.bp : null;
    const [lx, ty] = bp ? [mx + bp.dx * k, my + bp.dy * k] : (spots.find(([x, y]) => !hits(x, y)) || spots[0]);
    p.style.left = lx + "px";
    p.style.top = Math.max(2, ty) + "px";
    const isPipe = isTube(e), role = roleOf(e);   // heads/direction don't apply to pipe tubes (or links); colour still does
    $("ep-dirrow").style.display = isPipe || role === "link" ? "none" : "flex";
    $("ep-costrow").style.display = isPipe || role === "link" ? "none" : "flex";   // FR103: only actions / info cost something
    for (const btn of p.querySelectorAll("#ep-costrow button")) btn.classList.toggle("on", (btn.getAttribute("data-cost") || "") === (e.cost || ""));
    $("ep-sizerow").style.display = isPipe ? "none" : "flex";
    $("ep-gaterow").style.display = isPipe && e.gate ? "flex" : "none";   // FR102: gate badge size
    $("ep-usbrow").style.display = e.kind === "usb" && role === "link" ? "flex" : "none";   // NT12
    if (e.kind === "usb") { $("ep-usbS").value = usbS(e); $("ep-usbSv").textContent = usbS(e).toFixed(1) + "×"; }
    const own = !nestHost(e), sleeve = !own || isLan(e);   // NT7 / NT14: the sleeve's numbers, for a sleeve or any LAN cable
    for (const r of p.querySelectorAll(".ep-nest")) r.style.display = sleeve ? "flex" : "none";
    if (sleeve) { $("ep-sizerow").style.display = "none"; for (const k in NEST) { $("ep-" + k).value = nestP(e, k, own); $("ep-" + k + "v").textContent = nestFmt(k, nestP(e, k, own)); } }
    for (const btn of p.querySelectorAll("#ep-rolerow button")) btn.classList.toggle("on", btn.getAttribute("data-role") === role);
    $("ep-id").textContent = e.id;
    for (const btn of p.querySelectorAll("#ep-zrow button")) btn.classList.toggle("on", btn.getAttribute("data-z") === (e.z === "front" ? "front" : "back"));
    const dir = e.dir || "to";
    for (const btn of p.querySelectorAll("#ep-dirrow button")) btn.classList.toggle("on", btn.getAttribute("data-dir") === dir);
    if (S._panelEdge !== e.id) {   // populate inputs only when the selected edge changes (don't fight a live drag)
      S._panelEdge = e.id;
      const lw = typeof e.lw === "number" ? e.lw : (e.kind === "cable" || e.kind === "lan" ? 3 : 2);
      const ah = typeof e.ah === "number" ? e.ah : 12;
      $("ep-ah").value = ah; $("ep-ahv").textContent = ah;
      $("ep-lw").value = lw; $("ep-lwv").textContent = lw;
      $("ep-color").value = /^#[0-9a-f]{6}$/i.test(e.color || "") ? e.color : "#6e7681";
      $("ep-gr").value = gateR(e); $("ep-grv").textContent = gateR(e);
    }
  }
  // FR80: an edge end can sit ON a pipe (edge.fromOn / edge.toOn = "<pipeId>:<spot>"): an elbow (c<i> = polyline
  // point i), a segment's midpoint (m<i>), or — Shift held, FR81 — an exact spot (s<i>@<t> = fraction t along segment i)
  const SNAP_PX = 24;   // within this many screen px of a snap point = jump to it on release
  function pipePolyOf(pe) {   // only plain pipes (not themselves attached to a pipe) can be attached to
    if (!pe || !isTube(pe) || pe.fromOn || pe.toOn || !visible(pe)) return null;
    const a = node(pe.from), b = node(pe.to);
    return a && b && visible(a) && visible(b) ? dedupe(pipePoly(anchorBox(a, rbox(a)), anchorBox(b, rbox(b)), pe)) : null;   // FR92: as drawn
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
    const i = String(spec).indexOf(":"), pe = S.data.edges.find((x) => x.id === String(spec).slice(0, i)), key = String(spec).slice(i + 1);
    if (key === "gate") { const g = gateOf(pe), r = g && gateR(pe) + 1; return g && { x: g.x - r, y: g.y - r, w: 2 * r, h: 2 * r }; }   // FR100: the badge's outline
    const poly = pipePolyOf(pe), p = poly && pipeSpot(poly, key);
    if (!p) return null;
    const r = (pe.pw || 22) / 2 + 3;
    return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r };
  }
  function edgeEnds(e, boxOf) {   // the two boxes an edge routes between (a node's box, or a spot on a pipe)
    const get = (id, on) => on ? onPipeBox(on) : anchorBox(node(id), boxOf ? boxOf[id] : (node(id) && visible(node(id)) ? rbox(node(id)) : null));
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
    for (const pe of S.data.edges) {   // FR100: on (or next to) an open gate → attach to the gate itself
      if (pe.id === skipEdge) continue;
      const g = gateOf(pe);
      if (g && dist(g) <= gateR(pe) + tol / 2) { const r = gateR(pe) + 1;
        return { pipe: pe.id, key: "gate", pt: g, snapped: true, box: { x: g.x - r, y: g.y - r, w: 2 * r, h: 2 * r } }; }
    }
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
      const b = anchorBox(n, rbox(n)), inside = wp.x >= b.x && wp.x <= b.x + b.w && wp.y >= b.y && wp.y <= b.y + b.h;   // FR92: a pictogram's icon
      const sn = boxSnaps(b).map((q) => ({ ...q, d: dist(q) })).sort((u, v) => u.d - v.d)[0];
      if (!inside && sn.d > tol) continue;
      const rank = inside ? b.w * b.h : 1e12 + sn.d;   // innermost box under the cursor, else the nearest snap
      if (!nb || rank < nb.rank) nb = { id: n.id, box: b, sn, rank };
    }
    if (!nb) return null;
    if (shift) return { id: nb.id, box: nb.box, pt: onBorder(nb.box, wp), exact: true };
    return nb.sn.d <= tol ? { id: nb.id, box: nb.box, pt: nb.sn, snapped: true } : { id: nb.id, box: nb.box, pt: null };
  }
  const ENDK = { start: ["from", "fromOn", "so", "ss", "sf"], end: ["to", "toOn", "eo", "es", "ef"] };
  function portOffsets(e, end, pt, free) {   // set so/ss (eo/es) so the route meets box point pt (free: any point, FR79 shift)
    const [, , oK, sK, fK] = ENDK[end]; let ends = edgeEnds(e); if (!ends) return;
    const vb = viaBoxes(e);   // FR93: a through-route's end offsets shape its first/last leg (to the nearest via box)
    if (vb.length) ends = end === "end" ? { a: vb[vb.length - 1], b: ends.b } : { a: ends.a, b: vb[0] };
    const { H } = zRouteSegs(ends.a, ends.b, e), q = end === "end" ? ends.b : ends.a;
    const U = (z) => H ? { u: z.x, v: z.y } : { u: z.y, v: z.x }, Q = H ? { u: q.x, v: q.y, wu: q.w, wv: q.h } : { u: q.y, v: q.x, wu: q.h, wv: q.w };
    const p = U(pt), cu = Q.u + Q.wu / 2, cv = Q.v + Q.wv / 2;
    let o = p.v - cv, st = p.u - cu, f = 0;
    if (!free) {   // a point ON the outline: facing side → slide along it; top/bottom → stub into it; far side → wrap (FR92)
      const other = end === "end" ? ends.a : ends.b, ou = H ? other.x + other.w / 2 : other.y + other.h / 2;
      const ov = H ? other.y + other.h / 2 : other.x + other.w / 2;
      const near = ou >= cu ? Q.u + Q.wu : Q.u, far = ou >= cu ? Q.u : Q.u + Q.wu;   // FACING side / the side facing away
      if (Math.abs(p.u - near) < 0.5) st = 0;
      else if (Math.abs(p.u - far) < 0.5 && p.v > Q.v + 0.5 && p.v < Q.v + Q.wv - 0.5) {   // round the box (the side nearer the other end), in at p
        f = p.v - cv; o = (ov <= cv ? -1 : 1) * (Q.wv / 2 + 20); st = far - cu + Math.sign(far - cu) * 24;
      } else o = p.v <= cv ? -(Q.wv / 2 + 20) : Q.wv / 2 + 20;
    }
    o = Math.round(o); st = Math.round(st); f = Math.round(f);
    if (o) e[oK] = o; else delete e[oK];
    const beyond = Math.abs(o) > Q.wv / 2;
    if (st && beyond) e[sK] = st; else delete e[sK];
    if (f && beyond && Math.abs(st) > Q.wu / 2) e[fK] = f; else delete e[fK];
  }
  function applyTarget(e, end, t) {   // attach edge end to a resolved target (pipe spot / box point / box auto-mid)
    const [idK, onK, oK, sK, fK] = ENDK[end];
    delete e[onK]; delete e[oK]; delete e[sK]; delete e[fK];
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
      const e = S.data.edges.find((x) => x.id === id), pipe = isTube(e);
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
      e.textContent = "no toggles — add with ⚙ toggles (or ask Claude)"; bar.appendChild(e); bar.appendChild(anchorButton()); bar.appendChild(nailButton()); return; }
    for (const t of ts) {
      const opts = activeOptions(t);
      const wrap = document.createElement("span"); wrap.className = "tg";
      const lab = document.createElement("label"); lab.textContent = t.label || t.id; wrap.appendChild(lab);
      if (!opts.length) { const e = document.createElement("span"); e.className = "empty"; e.textContent = "— n/a"; wrap.appendChild(e); bar.appendChild(wrap); continue; }
      const seg = document.createElement("span"); seg.className = "seg";
      for (const o of opts) {
        const b = document.createElement("button");
        b.textContent = o.label || o.value; b.className = S.toggle[t.id] === o.value ? "on" : "";
        b.onclick = () => { S.toggle[t.id] = o.value; normalizeToggles(); writeHash(); dropHiddenSel(); buildToggles(); render();
          applyAnchor(); };   // FR104: the anchored box stays on its spot in every view
        seg.appendChild(b);
      }
      wrap.appendChild(seg); bar.appendChild(wrap);
    }
    bar.appendChild(anchorButton());   // FR104
    bar.appendChild(nailButton());     // FR106
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
      S.id = id; S.sel = null; S.selEdge = null; markDirty(false); resetHistory();
      S.toggle = {}; for (const t of toggles()) S.toggle[t.id] = t.default;
      if (toggleState) for (const k in toggleState) S.toggle[k] = toggleState[k];
      normalizeToggles(); writeHash();
      buildCrumbs(); buildPicker(); buildToggles(); buildLegend();
      const v = savedView() || recallView(id); if (v) { S.view = { x: v.x, y: v.y, k: v.k }; applyView(); } else fit();   // FR112, FR94
      applyAnchor();   // FR104: an anchored box sits on its spot in this diagram too (its zoom kept)
      render();
      status(`loaded <b>${id}</b> — ${S.data.nodes.length} nodes, ${S.data.edges.length} edges`);
    } catch (e) { status(`could not load ${id}.json — ${e.message}`); }
  }
  async function save() {
    S.data.meta.view = currentView();   // FR112: the view is saved with the diagram
    if (!S.pendingEdit) S.base = snap();
    const body = serialize(S.data);
    if (S.backend) {
      try {
        const r = await fetch(`/api/diagram/${S.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        markDirty(false); commitEdit(); S.saved = snap(); await loadIndex(); buildPicker(); buildCrumbs();
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
    S.view.k = k; S.view.x = cx - r.left - wx * k; S.view.y = cy - r.top - wy * k; applyView(); viewMoved();
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
    const w = thisViewWhen(); if (w) S.data.nodes[S.data.nodes.length - 1].showWhen = w;   // FR113: only in the view it was added in
    S.sel = id; S.selEdge = null; markDirty(true); render(); refreshSwatchSel();
    status(`added <b>${id}</b> — drag it, ✎ rename, ★ icon, colour`);
  }
  function shownIn(o, isEdge) {   // the views (toggle combinations) that show item o
    const saved = S.toggle, out = [];
    for (const st of allStates()) { S.toggle = st;
      if (visible(o) && (!isEdge || [o.from, o.to].every((id) => { const n = node(id); return n && visible(n); }))) out.push(viewKey(st)); }
    S.toggle = saved; return out;
  }
  function dropHiddenSel() {   // FR113: a selection the current view doesn't show is dropped (so Delete can't hit it)
    const e = S.selEdge && S.data.edges.find((x) => x.id === S.selEdge);
    if (S.selEdge && !(e && edgeDrawn(e))) S.selEdge = null;
    if (S.sel && !(node(S.sel) && visible(node(S.sel)))) S.sel = null;
  }
  function delSel(ev) {
    dropHiddenSel();
    if (!S.sel && !S.selEdge) { status("nothing selected in this view"); render(); return; }
    const o = S.selEdge ? S.data.edges.find((e) => e.id === S.selEdge) : S.sel ? node(S.sel) : null;
    if (o && !(ev && ev.shiftKey) && toggles().length) {   // FR113: only from THIS view while other views still show it
      const here = viewKey(), others = shownIn(o, !!S.selEdge).filter((k) => k !== here).length;
      if (others) {
        o.hideIn = [...new Set([...(o.hideIn || []), here])].sort();
        status(`removed <b>${o.id}</b> from this view — still in ${others} other view${others === 1 ? "" : "s"} (<b>Shift+Delete</b> removes it everywhere)`);
        S.sel = null; S.selEdge = null; markDirty(true); render(); return;
      }
    }
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
    if (!which.trim()) { delete o.showWhen; delete o.hideIn; markDirty(true); render(); status("cleared show-when — shown in every view again"); return; }   // FR113: also un-hides
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
    if (n.containerWhen && activeContainerOf(n) && !n.snapSide) {   // FR88: per-state nesting is active here → this view
      const p = node(n.container), c = center(rbox(n));               // only moves it WITHIN its container; x/y (the other
      delete n.container; const P = rbox(p); n.container = p.id;      // views' position) is never touched. Parent measured
      if (c.x > P.x && c.y > P.y && c.x < P.x + P.w && c.y < P.y + P.h) // without this child (no auto-grow skew).
        return `<b>${n.id}</b> moved inside <b>${p.id}</b> (only in this view: ${Object.keys(n.containerWhen).map((k) => k + "=" + n.containerWhen[k].join("/")).join(", ")})`;
      if (typeof orig.cdx === "number") n.cdx = orig.cdx; else delete n.cdx;
      if (typeof orig.cdy === "number") n.cdy = orig.cdy; else delete n.cdy;
      return `<b>${n.id}</b> stays inside <b>${p.id}</b> in this view — move its free position in another view, or un-nest with ⊏ contain`;
    }
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
  function pruneLegs(e) {   // drop empty e.legs entries so an untouched route saves exactly as before
    if (!e.legs) return;
    for (const k in e.legs) if (!Object.keys(e.legs[k]).length) delete e.legs[k];
    if (!Object.keys(e.legs).length) delete e.legs;
  }
  function edgeDragStart(e, wp) {
    const base = { id: e.id, wx0: wp.x, wy0: wp.y, moved: false };
    const nh = nestHost(e);
    if (nh) {   // NT9: a sleeve has no route of its own — dragging its segment drags that segment of the tunnel inside
      status(`<b>${e.id}</b> is drawn around <b>${nh.t.id}</b> — dragging moves that tunnel's segment; the sleeve follows`);
      return edgeDragStart(nh.t, wp);
    }
    if (!e.path && viaBoxes(e).length) {   // FR95: drag one leg of a through-route; the run across a via box stays put
      const { a, b } = edgeEnds(e), r = viaRouteSegs(a, b, e), sg = r.segs[projPoly(r.pts, wp).i];
      if (!sg) { status(`that part runs through <b>${e.via.join(", ")}</b> — drag the line just outside it to move where it enters / leaves`); return { ...base, fixed: true }; }
      const crossRun = sg.key === "mo" || sg.key === "ss" || sg.key === "es", ks = ["so", "eo", "mo", "ss", "es", "sf", "ef"];
      const o0 = {}; for (const k of ks) o0[k] = ofs(legSlot(e, r.ids, sg.leg, k)[k]);
      pruneLegs(e);
      return { ...base, key: sg.key, leg: sg.leg, ids: r.ids, cv: sg.cv, axis: crossRun === sg.H ? "x" : "y", o0 };
    }
    if (Array.isArray(e.path) && e.path.length >= 2) {   // explicit path: shift that segment's two points
      const i = projPoly(e.path, wp).i, P = e.path[i], Q = e.path[i + 1];
      return { ...base, i, axis: Math.abs(P.y - Q.y) < 0.5 ? "y" : "x", path0: e.path.map((p) => ({ x: p.x, y: p.y })) };
    }
    const { a, b } = edgeEnds(e), r = zRouteSegs(a, b, e), key = r.segs[projPoly(r.pts, wp).i];
    const crossRun = key === "mo" || key === "ss" || key === "es";   // these segments run along the cross axis
    return { ...base, key, axis: crossRun === r.H ? "x" : "y",
             o0: { so: ofs(e.so), eo: ofs(e.eo), mo: ofs(e.mo), ss: ofs(e.ss), es: ofs(e.es), sf: ofs(e.sf), ef: ofs(e.ef) } };
  }
  function edgeDragMove(ev) {
    const d = S.edrag, e = S.data.edges.find((x) => x.id === d.id), wp = toWorld(ev);
    if (!e || d.fixed) return;
    if (!d.moved && Math.abs(wp.x - d.wx0) + Math.abs(wp.y - d.wy0) <= 3 / S.view.k) return;   // a click, not a drag
    d.moved = true;
    if (d.gate) {   // FR100: move the open gate inside its box (stored clamped, so it never drifts outside)
      const gn = node(e.gate), R = gn && anchorBox(gn, rbox(gn)); if (!R) return;
      const g = gatePoint({ gx: d.gx0 + wp.x - d.wx0, gy: d.gy0 + wp.y - d.wy0 }, R), c = center(R);
      const gx = Math.round(g.x - c.x), gy = Math.round(g.y - c.y);
      if (gx) e.gx = gx; else delete e.gx; if (gy) e.gy = gy; else delete e.gy;
      markDirty(true); render(); return;
    }
    const delta = Math.round(d.axis === "x" ? wp.x - d.wx0 : wp.y - d.wy0);
    if (d.path0) {
      e.path = d.path0.map((p) => ({ x: p.x, y: p.y }));
      e.path[d.i][d.axis] += delta; e.path[d.i + 1][d.axis] += delta;
    } else if (d.ids) {   // FR95: one leg of a through-route (its end runs snap level with each other, as below)
      const put = (k, v) => { const o = legSlot(e, d.ids, d.leg, k); if (v) o[k] = v; else delete o[k]; };
      for (const k of d.key.split("+")) put(k, d.o0[k] + delta);
      if (d.key === "so" || d.key === "eo") {
        const so = d.key === "so" ? d.o0.so + delta : d.o0.so, eo = d.key === "eo" ? d.o0.eo + delta : d.o0.eo;
        if (Math.abs(d.cv[0] + so - d.cv[1] - eo) <= EDGE_SNAP) put(d.key, Math.round(d.key === "so" ? d.cv[1] + eo - d.cv[0] : d.cv[0] + so - d.cv[1]));
      }
      pruneLegs(e);
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
      if (isPictogram(n)) {   // FR99: the handles sit on the icon → resize scales the icon itself (see pointermove)
        const b = rbox(n), lines = String(n.label || "").split("\n").filter((l) => l), lh = lines.length * 15;
        S.resize.picto = { g0: anchorBox(n, b), bb: ICON_BOX[n.icon] || [0, 0, 24, 24], lh: lh + (lh ? 6 : 0), off: { x: b.x - n.x, y: b.y - n.y } };
        if (S.resize.contained) S.resize.picto.off = { x: b.x - S.resize.cdx0, y: b.y - S.resize.cdy0 };
      }
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
      const orig = { container: n.container, containerWhen: n.containerWhen, snapSide: n.snapSide, x: n.x, y: n.y, cdx: n.cdx, cdy: n.cdy };
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
        const w0 = toWorld(ev);
        S.edrag = ev.target.closest(".gate") ? { id: eid, gate: true, wx0: w0.x, wy0: w0.y, moved: false, gx0: ofs(e.gx), gy0: ofs(e.gy) }   // FR100
                                             : edgeDragStart(e, w0);
        if (S.edrag.gate) status(`open gate of <b>${eid}</b> — drag it anywhere inside <b>${e.gate}</b>; the pipe and any arrow on it follow`);
        ev.preventDefault(); S.mode = "edgedrag"; svg.setPointerCapture(ev.pointerId); return; }
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
      if (r.picto) {   // FR99: scale the icon evenly from the opposite edge; the box then hugs icon + label exactly
        const { g0, bb, lh, off } = r.picto;
        const gw0 = g0.w + (d.includes("e") ? dx : d.includes("w") ? -dx : 0), gh0 = g0.h + (d.includes("s") ? dy : d.includes("n") ? -dy : 0);
        const sw = 24 * gw0 / bb[2], sh = 24 * gh0 / bb[3];
        const sz = Math.max(24, d === "e" || d === "w" ? sw : d === "n" || d === "s" ? sh : Math.max(sw, sh));
        const gw = bb[2] * sz / 24, gh = bb[3] * sz / 24;
        const gx = d.includes("w") ? g0.x + g0.w - gw : d.includes("e") ? g0.x : g0.x + (g0.w - gw) / 2;
        const gy = d.includes("n") ? g0.y + g0.h - gh : d.includes("s") ? g0.y : g0.y + (g0.h - gh) / 2;
        const bx = gx - bb[0] * sz / 24, by = gy - bb[1] * sz / 24;   // layout box = icon square (sz × sz) + label below
        n.w = Math.round(sz); n.h = Math.round(sz + lh);
        if (r.snapped) {} else if (r.contained) { n.cdx = Math.round(bx - off.x); n.cdy = Math.round(by - off.y); }
        else { n.x = Math.round(bx - off.x); n.y = Math.round(by - off.y); }
        markDirty(true); render(); return;
      }
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
      if (ev.clientX !== S.panStart.x || ev.clientY !== S.panStart.y) viewMoved();   // FR112
    }
  });
  function clearRubber() { if (S.rubber) { S.rubber.remove(); S.rubber = null; } S.draw = null; }
  function endPointer(ev) { if (S.mode) { try { svg.releasePointerCapture(ev.pointerId); } catch (_) {} }
    setTimeout(commitEdit, 0);   // FR97: a drag/resize/draw is one undo step, committed once the pointer is released
    S.justDragged = !!((S.drag && S.drag.moved) || S.resize); S.mode = "idle"; S.drag = null; S.panStart = null; S.resize = null; svg.classList.remove("panning"); }
  svg.addEventListener("pointerup", (ev) => {
    if (S.mode === "edgedrag" || S.mode === "enddrag") { S.edrag = null; endPointer(ev); render(); return; }
    if (S.mode === "drawedge" && S.draw) {
      const tgt = S.draw.tgt, src = S.draw.src;
      if (tgt) {
        const id = uid("e", (x) => S.data.edges.some((e) => e.id === x)), e = { id, from: "", to: "", label: "", kind: "plain", dir: "to" };
        const w = thisViewWhen(); if (w) e.showWhen = w;   // FR113: a new line belongs to the view it was drawn in
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
  $("del").onclick = (ev) => delSel(ev);
  $("undo").onclick = undo; $("redo").onclick = redo;
  $("relabel").onclick = relabel;
  $("seticon").onclick = setIcon;
  $("setkind").onclick = setKind;
  $("setchild").onclick = setChild;
  $("setwhen").onclick = setWhen;
  $("settype").onclick = setType;
  $("setcontainer").onclick = setContainer;
  $("edittoggles").onclick = editToggles;
  $("fit").onclick = () => { fit(); viewMoved(); };
  const mid = () => ({ x: svg.getBoundingClientRect().left + svg.clientWidth / 2, y: svg.getBoundingClientRect().top + svg.clientHeight / 2 });
  $("zin").onclick = () => { const m = mid(); zoomAt(m.x, m.y, 1.2); };
  $("zout").onclick = () => { const m = mid(); zoomAt(m.x, m.y, 1 / 1.2); };
  $("save").onclick = save;
  $("copy").onclick = copyJSON;
  $("newdiag").onclick = newDiagram;
  // arrow box: direction (A→B / A←B / A↔B), head size, line width, colour
  const selEdgeObj = () => S.selEdge && S.data.edges.find((x) => x.id === S.selEdge);
  for (const btn of document.querySelectorAll("#ep-costrow button")) {   // FR103: what this action / info costs you
    btn.onclick = () => { const e = selEdgeObj(); if (!e) return; const c = btn.getAttribute("data-cost");
      if (c && COST[c]) { e.cost = c; delete e.color; } else delete e.cost;   // the cost colour replaces a hand-picked one
      markDirty(true); buildLegend(); render(); status(c ? `<b>${e.id}</b>: ${COST[c].label}` : `<b>${e.id}</b>: no cost colour`); };
  }
  for (const btn of document.querySelectorAll("#ep-rolerow button")) {   // FR90: link / tunnel / action / info
    btn.onclick = () => { const e = selEdgeObj(); if (!e) return; const r = btn.getAttribute("data-role");
      e.role = r; if (r === "tunnel") e.kind = "pipe"; else if (e.kind === "pipe") e.kind = "plain";
      markDirty(true); buildLegend(); render(); status(`<b>${e.id}</b> is now ${/^[ai]/.test(r) ? "an" : "a"} <b>${r}</b> line`); };
  }
  for (const btn of document.querySelectorAll("#ep-dirrow button")) {
    btn.onclick = () => { const e = selEdgeObj(); if (!e) return; e.dir = btn.getAttribute("data-dir"); markDirty(true); render(); };
  }
  $("ep-ah").addEventListener("input", (ev) => { const e = selEdgeObj(); if (!e) return; e.ah = +ev.target.value; $("ep-ahv").textContent = e.ah; markDirty(true); render(); });
  $("ep-lw").addEventListener("input", (ev) => { const e = selEdgeObj(); if (!e) return; e.lw = +ev.target.value; $("ep-lwv").textContent = e.lw; markDirty(true); render(); });
  $("ep-color").addEventListener("input", (ev) => { const e = selEdgeObj(); if (!e) return; e.color = ev.target.value; markDirty(true); render(); });
  $("ep-colorclear").onclick = () => { const e = selEdgeObj(); if (!e) return; delete e.color; markDirty(true); render(); };
  for (const btn of document.querySelectorAll("#ep-zrow button")) btn.onclick = () => {   // FR96: line in front of / behind the boxes
    const e = selEdgeObj(); if (!e) return;
    if (btn.getAttribute("data-z") === "front") e.z = "front"; else delete e.z;
    markDirty(true); render(); status(`<b>${e.id}</b> drawn ${e.z === "front" ? "in front of" : "behind"} the boxes`);
  };
  $("ep-id").onclick = () => { const e = selEdgeObj(); if (!e) return;   // FR96: copy the line's id to refer to it
    navigator.clipboard.writeText(e.id).then(() => status(`copied line id <b>${e.id}</b>`), () => status(`line id: <b>${e.id}</b>`)); };
  const nestFmt = (k, v) => k === "nestOp" ? Math.round(v * 100) + "%" : (+v).toFixed(1) + (k === "nestW" ? "×" : "");
  $("ep-usbS").oninput = () => {   // NT12: moving USB stick size (× line width)
    const e = selEdgeObj(); if (!e) return;
    const v = Math.round(+$("ep-usbS").value * 10) / 10;
    if (v === USB_S) delete e.usbS; else e.usbS = v;
    $("ep-usbSv").textContent = v.toFixed(1) + "×"; markDirty(true); render();
  };
  for (const k in NEST) $("ep-" + k).oninput = () => {   // NT7: sleeve gaps / width / opacity, live
    const e = selEdgeObj(); if (!e) return;
    const v = Math.round(+$("ep-" + k).value * 100) / 100;
    if (v === nestDef(k, !nestHost(e))) delete e[k]; else e[k] = v;   // the default is not stored
    $("ep-" + k + "v").textContent = nestFmt(k, v); markDirty(true); render();
  };
  $("ep-gr").oninput = () => { const e = selEdgeObj(); if (!e) return;   // FR102: resize the open gate
    const v = +$("ep-gr").value; if (v === GATE_GAP) delete e.gr; else e.gr = v;
    $("ep-grv").textContent = v; markDirty(true); render(); };
  $("ep-routereset").onclick = () => { const e = selEdgeObj(); if (!e) return;   // FR79: drop the dragged offsets
    for (const k of ["so", "eo", "mo", "ss", "es", "sf", "ef", "legs"]) delete e[k]; markDirty(true); render(); };
  // FR78: press-and-hold anywhere on the arrow box (not on its controls) and drag to move it; dblclick = back home
  const panel = $("edgepanel"), isCtl = (t) => t.closest("button, input, select, textarea, #ep-id");
  panel.addEventListener("pointerdown", (ev) => {
    if (isCtl(ev.target) || ev.button !== 0) return;
    ev.preventDefault();
    const e = selEdgeObj(); if (!e) return;
    // FR98: dragging stores the box's spot ON the line (e.bp, diagram units from the line's midpoint) — saved + undoable
    const ends = edgeEnds(e), mid = ends && midOfPoly(panelLine(e, ends));
    if (!mid) return;
    const k = S.view.k, r = panel.getBoundingClientRect(), host = panel.offsetParent.getBoundingClientRect();
    const st = { x: ev.clientX, y: ev.clientY, dx: (r.left - host.left - S.view.x) / k - mid.x, dy: (r.top - host.top - S.view.y) / k - mid.y };
    panel.classList.add("moving"); panel.setPointerCapture(ev.pointerId); S.mode = "panel";   // one gesture = one undo step
    let moved = false;
    const move = (m) => {
      if (!moved && Math.abs(m.clientX - st.x) + Math.abs(m.clientY - st.y) < 3) return;   // a click, not a drag
      moved = true;
      e.bp = { dx: Math.round(st.dx + (m.clientX - st.x) / k), dy: Math.round(st.dy + (m.clientY - st.y) / k) };
      markDirty(true); updateEdgePanel();
    };
    const up = () => { panel.classList.remove("moving"); panel.removeEventListener("pointermove", move);
      panel.removeEventListener("pointerup", up); panel.removeEventListener("pointercancel", up);
      S.mode = "idle"; commitEdit(); if (moved) status(`arrow box of <b>${e.id}</b> placed — saved with the diagram · double-click it to put it back`); };
    panel.addEventListener("pointermove", move); panel.addEventListener("pointerup", up); panel.addEventListener("pointercancel", up);
  });
  panel.addEventListener("dblclick", (ev) => { if (isCtl(ev.target)) return;   // FR98: back to the automatic spot
    const e = selEdgeObj(); if (!e || !e.bp) return; delete e.bp; markDirty(true); updateEdgePanel(); });
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
  /* ---------- FR114: icon picker (click a box's icon) + uploads ---------- */
  const picker = $("iconpicker");
  function closePicker() { picker.hidden = true; picker.textContent = ""; }
  function setNodeIcon(n, icon) { if (icon) n.icon = icon; else n.icon = ""; markDirty(true); render(); closePicker();
    status(`<b>${n.id}</b> icon → ${icon ? (icon.startsWith("img:") ? "uploaded picture" : icon) : "none"}`); }
  function shrinkToDataURL(blob) {   // any picture → PNG data URL, longest side ≤ 128 px (SVG kept as-is)
    return new Promise((res, rej) => {
      const fr = new FileReader(); fr.onerror = rej;
      fr.onload = () => {
        if (blob.type === "image/svg+xml") { res(fr.result); return; }
        const im = new Image(); im.onerror = rej;
        im.onload = () => { const k = Math.min(1, 128 / Math.max(im.width, im.height)), c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/png")); };
        im.src = fr.result;
      };
      fr.readAsDataURL(blob);
    });
  }
  function addImage(name, src) {   // store a picture in this diagram; returns its icon value
    const meta = S.data.meta, imgs = meta.images = meta.images || {};
    let key = String(name || "image").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "image", k = key, i = 2;
    while (imgs[k] && imgs[k] !== src) k = key + "-" + i++;
    imgs[k] = src; return "img:" + k;
  }
  function openPicker(n, cx, cy) {
    picker.textContent = ""; picker.hidden = false;
    const head = document.createElement("div"); head.className = "ip-head"; head.textContent = `icon for ${nodeName(n)}`; picker.appendChild(head);
    const grid = document.createElement("div"); grid.className = "ip-grid"; picker.appendChild(grid);
    const cell = (icon, title) => { const b = document.createElement("button"); b.className = "ip-cell" + ((n.icon || "") === icon ? " on" : ""); b.title = title;
      if (!icon) b.textContent = "none";
      else { const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", 28); s.setAttribute("height", 28);
        const src = imgSrc(icon); if (src) el("image", { href: src, x: 0, y: 0, width: 24, height: 24 }, s); else el("use", { href: "#ic-" + icon }, s);
        s.style.color = "#c9d1d9"; b.appendChild(s); }
      b.onclick = () => setNodeIcon(n, icon); grid.appendChild(b); };
    cell("", "no icon");
    for (const sym of $("defs").querySelectorAll("symbol[id^='ic-']")) { const name = sym.id.slice(3); cell(name, name); }
    for (const key of Object.keys((S.data.meta && S.data.meta.images) || {})) cell("img:" + key, key + " (uploaded)");
    const row = document.createElement("div"); row.className = "ip-row"; picker.appendChild(row);
    const up = document.createElement("button"); up.textContent = "⬆ upload from PC"; row.appendChild(up);
    const ln = document.createElement("button"); ln.textContent = "🔗 from a link"; row.appendChild(ln);
    const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.hidden = true; row.appendChild(file);
    up.onclick = () => file.click();
    file.onchange = async () => { const f = file.files[0]; if (!f) return;
      try { setNodeIcon(n, addImage(f.name, await shrinkToDataURL(f))); } catch (_) { status("could not read that picture"); } };
    ln.onclick = async () => {
      const url = (prompt("Picture link (https://…):") || "").trim(); if (!url) return;
      try { const r = await fetch(url, { mode: "cors" }); if (!r.ok) throw new Error(r.status); setNodeIcon(n, addImage(url.split("/").pop(), await shrinkToDataURL(await r.blob()))); }
      catch (_) { setNodeIcon(n, addImage(url.split("/").pop(), url));   // the site blocks downloading it: keep the link itself
        status(`<b>${n.id}</b> icon → linked picture (that site doesn't allow copying it, so the diagram points to the link — needs internet)`); }
    };
    const host = $("canvaswrap").getBoundingClientRect();
    picker.style.left = Math.max(4, Math.min(host.width - 340, cx - host.left + 8)) + "px";
    picker.style.top = Math.max(4, Math.min(host.height - 380, cy - host.top + 8)) + "px";
  }
  // a click (press + release without moving) on a box's icon opens the picker; the press is noted before the editor
  // captures the pointer (after which the browser's own click no longer lands on the icon)
  svg.addEventListener("pointerdown", (ev) => {
    const ic = ev.target.closest && ev.target.closest(".nicon");
    S.iconDown = ic && !ev.ctrlKey && !ev.metaKey && ev.button === 0 ? { id: nodeIdFromEvent(ev), x: ev.clientX, y: ev.clientY } : null;
  }, true);
  svg.addEventListener("pointerup", (ev) => {
    const d = S.iconDown; S.iconDown = null;
    if (!d || S.justDragged || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4) return;
    const n = node(d.id); if (n) openPicker(n, ev.clientX, ev.clientY);
  });
  document.addEventListener("pointerdown", (ev) => { if (!picker.hidden && !picker.contains(ev.target) && !(ev.target.closest && ev.target.closest(".nicon"))) closePicker(); });

  /* ---------- FR114: copy / paste a box or line — also across diagrams (kept in this browser) ---------- */
  const CLIP_KEY = "flow.clipboard";
  let lastWorld = null;
  svg.addEventListener("pointermove", (ev) => { lastWorld = toWorld(ev); });
  svg.addEventListener("pointerleave", () => { lastWorld = null; });
  function copySel() {
    const meta = S.data.meta || {}, imgs = {};
    const keep = (icon) => { const s = imgSrc(icon); if (s) imgs[icon.slice(4)] = s; };
    let clip;
    if (S.sel) { const n = node(S.sel), b = rbox(n), c = JSON.parse(JSON.stringify(n));
      delete c.container; delete c.containerWhen; delete c.snapSide; delete c.cdx; delete c.cdy; c.x = Math.round(b.x); c.y = Math.round(b.y); keep(n.icon);
      clip = { kind: "node", item: c }; }
    else if (S.selEdge) clip = { kind: "edge", item: JSON.parse(JSON.stringify(S.data.edges.find((e) => e.id === S.selEdge))) };
    else return false;
    clip.v = 1; clip.from = S.id; clip.images = imgs;
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch (_) { status("could not copy (browser storage blocked)"); return true; }
    status(`copied <b>${clip.item.id}</b> — Ctrl+V pastes it here or in any other diagram`); return true;
  }
  function pasteClip() {
    let clip; try { clip = JSON.parse(localStorage.getItem(CLIP_KEY) || "null"); } catch (_) {}
    if (!clip || !clip.item) { status("nothing copied yet — select a box or line and press Ctrl+C"); return; }
    const it = JSON.parse(JSON.stringify(clip.item)), w = thisViewWhen();
    delete it.hideIn; if (w) it.showWhen = w; else delete it.showWhen;   // FR113: a pasted item belongs to this view
    if (/^img:/.test(it.icon || "") && clip.images && clip.images[it.icon.slice(4)]) it.icon = addImage(it.icon.slice(4), clip.images[it.icon.slice(4)]);
    if (clip.kind === "node") {
      const base = it.id.replace(/-?\d+$/, "") || "n"; it.id = node(it.id) ? uid(base, (x) => node(x)) : it.id;
      if (lastWorld) { it.x = Math.round(lastWorld.x - it.w / 2); it.y = Math.round(lastWorld.y - it.h / 2); }
      else if (clip.from === S.id) { it.x += 30; it.y += 30; }
      S.data.nodes.push(it); S.sel = it.id; S.selEdge = null;
    } else {
      const ok = (id, on) => (on ? S.data.edges.some((x) => x.id === String(on).split(":")[0]) : true) && !!node(id);
      if (!ok(it.from, it.fromOn) || !ok(it.to, it.toOn)) { status(`can't paste <b>${it.id}</b> here — this diagram has no <b>${!node(it.from) ? it.from : it.to}</b> to connect`); return; }
      it.id = uid("e", (x) => S.data.edges.some((e) => e.id === x)); S.data.edges.push(it); S.selEdge = it.id; S.sel = null;
    }
    markDirty(true); refreshSwatchSel(); render(); status(`pasted <b>${it.id}</b>${clip.from !== S.id ? ` (from ${clip.from})` : ""} — only in this view; 👁 show-when to widen`);
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Control" || ev.key === "Meta") setCtrl(true);
    const textField = ev.target.tagName === "TEXTAREA" || (ev.target.tagName === "INPUT" && !["range", "color", "button", "checkbox"].includes(ev.target.type));
    if (textField) return;   // typing keeps the browser's own keys (incl. its own undo); sliders/pickers don't
    const mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
    if (mod && !ev.altKey && (k === "z" || k === "y")) {   // FR97
      ev.preventDefault(); if (k === "y" || ev.shiftKey) redo(); else undo(); return;
    }
    if (mod && !ev.altKey && k === "c" && !String(window.getSelection())) { if (copySel()) { ev.preventDefault(); return; } }   // FR114
    if (mod && !ev.altKey && k === "v") { ev.preventDefault(); pasteClip(); return; }
    if (ev.key === "Escape" && !picker.hidden) { closePicker(); return; }
    // FR87: hold Shift (alone) = overlay every toggle state; not while Shift means "exact spot" (drawing / end drag)
    if (ev.key === "Shift" && !S.ghost && !ev.ctrlKey && !ev.metaKey && S.mode !== "drawedge" && S.mode !== "enddrag") { S.ghost = true; render(); }
    if (ev.key === "Delete" || ev.key === "Backspace") { if (S.sel || S.selEdge) { ev.preventDefault(); delSel(ev); } }
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
      for (const sym of doc.querySelectorAll("symbol")) {
        const bb = (sym.getAttribute("data-bbox") || "").split(" ").map(Number);   // FR92: the glyph's drawn outline (24-grid)
        if (bb.length === 4 && bb.every((v) => !isNaN(v))) ICON_BOX[sym.id.replace(/^ic-/, "")] = bb;
        $("defs").appendChild(sym);
      }
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
