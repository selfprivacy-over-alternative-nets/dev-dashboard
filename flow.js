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
    green:   { fill: "#10231a", stroke: "#3fb950", label: "free & in your own hands" },   // FR121: e.g. a free phonebook
  };
  const COLOR_KEYS = Object.keys(PALETTE);
  const ICONS = ["laptop", "server", "router", "cloud", "phone", "usb", "ethernet", "wifi", "safe", "relay",
    "tor", "onion", "gear", "block", "pipe", "gate", "warn", "tag", "cart", "tornode", "doc", "port", "barrier", "key", "mario", "yoshi", "jazz", "cousin"];
  const EDGE_KINDS = ["plain", "cable", "wifi", "usb", "lan", "internet", "tunnel", "tor"];

  const $ = (id) => document.getElementById(id);
  const svg = $("svg"), gViewport = $("viewport"), gNodes = $("nodes"), gEdges = $("edges"), gUnder = $("under");

  const S = {
    id: null, data: null, index: { diagrams: [], root: "overview" },
    backend: false, dirty: false,
    sel: null, selEdge: null,
    undo: [], redo: [], base: null, saved: null, pendingEdit: false,   // FR97 history (snapshots of S.data)
    toggle: {},                       // active toggle state {toggleId: value}
    step: null,                       // FR124: the active step of this view's story (null = the whole view)
    whole: false,                     // FR148: the whole view was asked for (✕, or ;step=all) — else a story opens at its last step
    play: true, stepT0: 0, stepDur: 0, playTimer: null,   // FR125: steps play one after another; when the current one started (SVG seconds) and how long it runs
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
    for (const t of toggles()) if (t.aliases && t.aliases[S.toggle[t.id]]) S.toggle[t.id] = t.aliases[S.toggle[t.id]];   // FR115: old values (net=w1 → 0a)
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
  // FR115: values in one of a toggle's sameLayout groups (method: LAN cable / wifi / USB) are ONE view for adding, pasting
  // and deleting — keys use the group's first value, new items get the whole group — so only their own lines differ.
  const sameGroup = (t, v) => (Array.isArray(t.sameLayout) && t.sameLayout.find((g) => g.includes(v))) || null;
  const viewKey = (st = S.toggle) => toggles().filter((t) => st[t.id] != null).map((t) => `${t.id}=${(sameGroup(t, st[t.id]) || [st[t.id]])[0]}`).join(";");
  const visible = (o) => whenMatches(o.showWhen) && !(Array.isArray(o.hideIn) && o.hideIn.includes(viewKey())) && inStep(o);
  // FR124: step mode — the d.steps whose showWhen matches are this view's story; step i shows only the union of the
  // `show` lists (box + line ids) of steps 0…i. null = the whole view. An item made while a step is on joins that step.
  const stepsNow = () => (S.data && Array.isArray(S.data.steps) ? S.data.steps.filter((s) => whenMatches(s.showWhen)) : []);
  const stepShown = (i) => { const set = new Set(); stepsNow().slice(0, i + 1).forEach((s) => (s.show || []).forEach((id) => set.add(id))); return set; };
  const inStep = (o) => S.step == null || !stepsNow().length || stepShown(S.step).has(o.id);
  // FR126: visitors at the router's gates (FR118's light in through the route, the stranger bounced by the fire wall) only
  // in a step that says someone comes in (`visitors: true`); in the whole view always
  const visitorsNow = () => { const s = S.step != null && stepsNow()[S.step]; return !s || !!s.visitors; };
  function clampStep() { const n = stepsNow().length; if (S.step == null) return; S.step = n ? Math.min(Math.max(0, S.step | 0), n - 1) : null; }
  // FR148: a view with a story is first seen as its last step (the whole story's picture); the whole view is ✕ / ;step=all
  function lastByDefault() { const n = stepsNow().length; if (S.step == null && !S.whole && n) S.step = n - 1; }
  function stepAdopt(id) { const s = S.step != null && stepsNow()[S.step]; if (s && !(s.show || []).includes(id)) (s.show = s.show || []).push(id); }
  function stepForget(id) { for (const s of (S.data && S.data.steps) || []) if (Array.isArray(s.show)) s.show = s.show.filter((x) => x !== id); }
  let NEW_SET = null;   // FR125: while a step is starting, the ids it adds to the picture (they fade in)
  const thisViewWhen = () => { const w = {}; for (const t of toggles()) if (S.toggle[t.id] != null) w[t.id] = [...(sameGroup(t, S.toggle[t.id]) || [S.toggle[t.id]])]; return Object.keys(w).length ? w : null; };
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
  const SMIL = { animate: 1, animateMotion: 1, animateTransform: 1, set: 1 };
  let STEP_BEGIN = null;   // FR126: with a step on, its loops (phonebook, gates, USB stick) start when the step starts, not with the page
  function el(name, attrs, parent) {
    const e = document.createElementNS(SVGNS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (STEP_BEGIN && SMIL[name] && !(attrs && "begin" in attrs)) e.setAttribute("begin", STEP_BEGIN);
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
  function longestMid(poly) {   // FR93: a through-route's label sits on its longest LEVEL stretch (FR118: never across an upright
    let best = null, lvl = null;   // pipe); with none level, on its longest stretch — beside the pipe when that one is upright (v)
    for (let i = 1; i < poly.length; i++) { const a = poly[i - 1], b = poly[i], L = Math.hypot(b.x - a.x, b.y - a.y),
        m = { L, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.abs(b.x - a.x) < 0.5 };
      if (!best || L > best.L) best = m;
      if (L && Math.abs(b.y - a.y) < 0.5 && (!lvl || L > lvl.L)) lvl = m; }
    return lvl || best || poly[0];
  }
  // FR118: the home router as a GATEHOUSE. A route whose `gate` is a via box runs, inside that box, along the GATE ROW
  // through two windows — the 🔥 fire wall (on the exit = internet side) and the 🚧 port-443 barrier (on the server side)
  // — when it opens gates (e.open: port-forward ["firewall","port"], direct IPv6 ["firewall"]); a route that opens none
  // (a tunnel) runs along the LANE above the windows, OVER the shut gates. All geometry = fractions of the router body
  // (its anchor box). Mirrored in docs/gen_flow_svg.py (gate_geo / gate_cross / gate_wins).
  const GH = {};   // edge id → the last computed crossing of a gated route: { R, mode, mp, mq }
  const LABELS = {};   // FR147: edge id → where its label is drawn { x, y, anchor, text } (cleared per render) — a story step can light it up
  const gateMode = (e) => Array.isArray(e.open) && e.open.length ? "row" : "lane";
  function gateGeo(R) {
    return { mL: R.x + 0.083 * R.w, mR: R.x + 0.917 * R.w, laneY: R.y + 0.159 * R.h, rowY: R.y + 0.611 * R.h, botY: R.y + 0.95 * R.h,
             xs: [R.x + 0.30 * R.w, R.x + 0.694 * R.w], ww: 0.278 * R.w, wy0: R.y + 0.333 * R.h, wy1: R.y + 0.889 * R.h };
  }
  function gateCross(p, q, R, mode) {   // p (entry, on R's outline) → the gate row or the lane → q (exit); risers in the margins
    const G = gateGeo(R), Y = mode === "lane" ? G.laneY : G.rowY, sp = sideOf(p, R), sq = sideOf(q, R);
    const pref = (pt, sd) => sd === "w" ? G.mL : sd === "e" ? G.mR : (pt.x < R.x + R.w / 2 ? G.mL : G.mR);
    const mq = pref(q, sq); let mp = pref(p, sp); if (mp === mq) mp = mq === G.mL ? G.mR : G.mL;   // the exit side chooses first
    const toY = (pt, sd, m) => sd === "w" || sd === "e" ? [pt, { x: m, y: pt.y }, { x: m, y: Y }]
      : sd === "n" ? (mode === "lane" ? [pt, { x: pt.x, y: Y }] : [pt, { x: pt.x, y: G.laneY }, { x: m, y: G.laneY }, { x: m, y: Y }])
      : [pt, { x: pt.x, y: G.botY }, { x: m, y: G.botY }, { x: m, y: Y }];
    return { pts: dedupe([...toY(p, sp, mp), ...toY(q, sq, mq).reverse()]), mp, mq };
  }
  function gateWins(gh) {   // the windows: the fire wall on the exit (internet) side, the port barrier on the server side
    const G = gateGeo(gh.R), fireX = gh.mq > gh.mp ? G.xs[1] : G.xs[0], portX = fireX === G.xs[1] ? G.xs[0] : G.xs[1];
    const win = (cx) => ({ x: cx - G.ww / 2, y: G.wy0, w: G.ww, h: G.wy1 - G.wy0, cx, cy: G.rowY });
    return { fire: win(fireX), port: win(portX), G };
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
      if (i > 0 && ids[i] === e.gate && leg.H && !("so" in o)) {   // FR118: leave the gatehouse level with its row / lane (unless dragged)
        const G = gateGeo(boxes[i]);
        leg = zRouteSegs(boxes[i], boxes[i + 1], { ...o, _H: true, so: (gateMode(e) === "lane" ? G.laneY : G.rowY) - (boxes[i].y + boxes[i].h / 2) });
      }
      const ls = leg.segs.map((key) => ({ leg: i, key, H: leg.H, cv: leg.cv }));
      if (i === 0) { pts = leg.pts; segs = ls; ranges.push([0, pts.length - 1]); }
      else { let cross;
        if (ids[i] === e.gate) {   // FR118: through the gatehouse — along the gate row, or over the gates in the lane
          const gc = gateCross(pts[pts.length - 1], leg.pts[0], boxes[i], gateMode(e));
          cross = gc.pts; GH[e.id] = { R: boxes[i], mode: gateMode(e), mp: gc.mp, mq: gc.mq };
        } else cross = throughBox(pts[pts.length - 1], leg.pts[0], boxes[i]);
        const s0 = pts.length - 1 + cross.length - 1;   // where leg.pts[0] lands once the crossing replaces the last point
        pts = pts.slice(0, -1).concat(cross, leg.pts.slice(1)); segs = segs.concat(cross.slice(1).map(() => null), ls);
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
  function gateOf(pe, which) {   // FR118: a gated pipe's window ("firewall" | "port") as {x, y, w, h, cx, cy}, or null
    const gn = pe && pe.gate && node(pe.gate);
    if (!gn || !visible(gn) || !(pe.via || []).includes(pe.gate) || !pipePolyOf(pe) || !GH[pe.id]) return null;
    const W = gateWins(GH[pe.id]), hasPort = gateMode(pe) === "lane" || (pe.open || []).includes("port");
    return which === "firewall" || !hasPort ? W.fire : W.port;
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
  const ICON_SCREEN = {};   // FR127: icon → [x, y, w, h] of its screen in the 24×24 grid (data-screen in icons.svg; the laptop)
  // FR114: an icon is a sprite name, or "img:<key>" = an uploaded picture kept in the diagram (meta.images[key] = data URL / link)
  const imgSrc = (icon) => /^img:/.test(icon || "") ? (((S.data && S.data.meta && S.data.meta.images) || {})[icon.slice(4)] || null) : null;
  function drawIcon(g, icon, x, y, s, color) {
    const src = imgSrc(icon);
    const u = src ? el("image", { href: src, x, y, width: s, height: s, preserveAspectRatio: "xMidYMid meet", class: "nicon" }, g)
                  : el("use", { href: "#ic-" + icon, x, y, width: s, height: s, class: "nicon" }, g);
    u.style.color = color; u.style.cursor = "pointer"; return u;
  }
  // FR119 / FR121: a PHONEBOOK node (the domain → ip lookup) is the DNS book of the router-gates demo, drawn in the demo's
  // units (a page = PB.W × PB.H) scaled so the OPEN book is as wide as the node: closed, "DNS PHONEBOOK" on a cover in the
  // node's colour (= its cost: red bought · orange a company you depend on · green free), the badge (n.badge: "snail" =
  // slow, you edit it by hand · "bolt" = fast, your server updates it) on its outer corner, the label below.
  const PB = { W: 110, H: 78, T: 9, U: 1.6 };   // page size (book units) · one lookup (s) · the server's update before it (s)
  const IP_RE = /\d{1,3}(\.\d{1,3}){3}|[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}/i;   // FR122: an IPv4 or an IPv6 address
  const ipTag = (ip) => (ip.includes(":") ? "ipV6 " : "ip ") + ip;   // FR147: an address as the book shows it — "ipV6 2001:db8::1", "ip 98.76.54.32"
  // FR122: the entry text, per view: n.entryWhen = { toggle: { value: "entry" } } (like optionsWhen), else n.entry
  // FR141: a value may itself be { toggle: { value: entry }, entry: fallback } — the entry by one more toggle (the scenario)
  const isStr = (v) => typeof v === "string";
  const pickWhen = (w, fb, ok = isStr) => { for (const t in w) { if (t === fb) continue; const v = (w[t] || {})[S.toggle[t]];   // {toggle: {value: text}} (FR141: nested; `fb` = the fallback key; FR152: `ok` says what counts as a value)
      if (ok(v)) return v; if (v && typeof v === "object" && !Array.isArray(v)) { const r = pickWhen(v, fb, ok); if (r != null) return r; } }
    return ok(w[fb]) ? w[fb] : null; };
  // FR152: a step's commands per view: s.cmdWhen = {toggle: {value: cmd}} (like labelWhen), else s.cmd — one string or a list, one line each
  const isCmd = (v) => typeof v === "string" || Array.isArray(v);
  const cmdsOf = (s) => { const r = s.cmdWhen ? pickWhen(s.cmdWhen, "cmd", isCmd) : null, v = r != null ? r : s.cmd; return v == null ? [] : (Array.isArray(v) ? v : [v]).map(String); };
  const entryOf = (n) => { const r = n.entryWhen ? pickWhen(n.entryWhen, "entry") : null; return r != null ? r : String(n.entry || ""); };
  const labelOf = (n) => { const r = n.labelWhen ? pickWhen(n.labelWhen, "label") : null; return r != null ? r : String(n.label || ""); };   // FR149: a box's label per view (n.labelWhen, like entryWhen)
  function bookGeom(n, b) {   // the CLOSED book, centred above the label (lines attach to it)
    const lh = labelOf(n).split("\n").filter((l) => l).length * 15, h = Math.max(30, b.h - lh - (lh ? 6 : 0));
    const s = Math.min(h / (PB.H + 7), b.w / (2 * (PB.W + 5))), w = (PB.W + 5) * s, bh = (PB.H + 7) * s;
    return { x: b.x + (b.w - w) / 2, y: b.y + (h - bh) / 2, w, h: bh, s, ty: b.y + h + 16 };
  }
  function bookLights(n, B, epoly) {   // FR121: the lines n.lights names, oriented far end → book (in) or book → far end (out)
    const L = n.lights || {};
    // FR122: a light may ride a CHAIN of lines (an id list, far end → book for ask/update, book → far end for answer), each
    // joined to the next at a shared box — e.g. your friend's pipe to the internet, then the internet's line to the book
    const ride = (ids, inward) => { const list = [].concat(ids || []); if (!list.length) return null;
      let at = n.id, pts = [];
      for (const id of inward ? list.slice().reverse() : list) {   // walk outward from the book
        const e = S.data.edges.find((x) => x.id === id), p = e && epoly[id];
        if (!p || p.length < 2 || (e.from !== at && e.to !== at)) return null;   // gone, hidden, or not joined to the last one
        pts = pts.concat(e.from === at ? p : p.slice().reverse()); at = e.from === at ? e.to : e.from;
      }
      return { poly: inward ? pts.reverse() : pts, far: at }; };
    const ask = ride(L.ask, true), answer = ride(L.answer, false), update = ride(L.update, true);
    let dir = 1;   // 1 = spine left, opens to the left; -1 = spine right — the cover opens toward the line the question comes in on
    if (ask) { const sd = sideOf(ask.poly[ask.poly.length - 1], B); dir = sd === "e" ? -1 : sd === "w" ? 1 : ask.poly[0].x > B.x + B.w / 2 ? -1 : 1; }
    return { ask, answer, update, dir };
  }
  function anchorBox(n, b) {   // FR92: lines attach to a pictogram's DRAWN icon, not its invisible box
    if (n && b && n.nodeType === "phonebook") { const B = bookGeom(n, b); return { x: B.x, y: B.y, w: B.w, h: B.h }; }   // FR119: the book
    if (!n || !b || !isPictogram(n)) return b;
    const g = pictoGeom(b, labelOf(n).split("\n")), bb = ICON_BOX[n.icon] || [0, 0, 24, 24], k = g.s / 24;
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
  const nodeName = (n) => labelOf(n).replace(/\s*\n\s*/g, " ").trim() || n.id;   // the label on one line
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

  /* ---------- FR118: the gatehouse router — windows under the pipes, gates + moving lights over them ---------- */
  const GH_T = 8;   // one loop: your friend gets in through the gates you opened, then a request bounces off a shut fire wall
  const ghAnim = (p, attrs) => el(attrs.path ? "animateMotion" : attrs.type ? "animateTransform" : "animate", { dur: GH_T + "s", repeatCount: "indefinite", ...attrs }, p);
  const ghPorts = (list) => list.some(({ e }) => gateMode(e) === "lane" || (e.open || []).includes("port"));
  function blockedLoop(g, poly, pw) {   // FR142: a pipe nobody gets through (e.blocked) — a light comes in from its start, stops short of its end, turns red with a ✕ and backs off, every GH_T s (mirrored in gen_flow_svg.py blocked_svg)
    const L = polyLen(poly) || 1, R1 = pw * 0.45, stop = Math.max(0, 1 - (R1 + 2) / L), back = Math.max(0, 1 - (R1 + 42) / L), f = (v) => +v.toFixed(4);
    const lg = el("g", { class: "blocked gh-anim", "pointer-events": "none", opacity: 0 }, g);
    ghAnim(lg, { path: "M " + poly.map((q) => `${q.x} ${q.y}`).join(" L "), keyPoints: `0;0;${f(stop)};${f(back)};${f(back)}`, keyTimes: "0;0.05;0.2;0.24;1", calcMode: "linear" });
    ghAnim(lg, { attributeName: "opacity", values: "0;0;1;1;0;0", keyTimes: "0;0.04;0.06;0.44;0.5;1" });
    for (const r of [[R1, 0.3], [pw * 0.22, 1]]) ghAnim(el("circle", { r: f(r[0]), fill: "#ffffff", opacity: r[1] }, lg), { attributeName: "fill", values: "#ffffff;#ffffff;#ff5c5c;#ff5c5c", keyTimes: "0;0.2;0.22;1" });
    const q = polyAt(poly, L * stop), x = el("text", { class: "blocked", x: f(q.x), y: f(q.y - R1 * 1.6), "text-anchor": "middle", fill: "#ff5c5c", opacity: 0, "pointer-events": "none" }, g);
    Object.assign(x.style, { fontSize: Math.max(14, R1 * 2.2) + "px", fill: "#ff5c5c" }); x.textContent = "✕";
    ghAnim(x, { attributeName: "opacity", values: "0;0;1;1;0;0", keyTimes: "0;0.2;0.22;0.44;0.5;1" });
  }
  function polyUpTo(poly, dist) {   // FR147: the polyline from its start up to a distance along it (the last point interpolated)
    const out = [poly[0]]; let left = dist;
    for (let i = 1; i < poly.length; i++) { const a = poly[i - 1], b = poly[i], L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L >= left) { const t = L ? left / L : 0; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); return out; }
      out.push(b); left -= L; }
    return out;
  }
  function polyFrom(poly, dist) { return polyUpTo(poly.slice().reverse(), Math.max(0, polyLen(poly) - dist)).reverse(); }   // FR149: the polyline from a distance along it to its end
  function polyAt(poly, dist) {   // the point at a distance along a polyline
    for (let i = 1; i < poly.length; i++) { const L = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
      if (dist <= L || i === poly.length - 1) { const t = L ? Math.max(0, Math.min(1, dist / L)) : 0; return { x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * t, y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * t }; }
      dist -= L; }
    return poly[poly.length - 1];
  }
  const polyLen = (poly) => poly.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - poly[i].x, q.y - poly[i].y), 0);
  function distTo(poly, pt) { const r = projPoly(poly, pt); let d = 0; for (let i = 1; i <= r.i; i++) d += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    return d + r.t * Math.hypot(poly[r.i + 1].x - poly[r.i].x, poly[r.i + 1].y - poly[r.i].y); }
  function gatehouseUnder(list) {   // dark windows (and, for tunnels, the faint unused front door) — under the pipes
    const { e } = list[0], gh = GH[e.id], W = gateWins(gh), G = W.G, sw = Math.max(1.5, gh.R.w * 0.008), ports = ghPorts(list);
    for (const w of ports ? [W.fire, W.port] : [W.fire]) el("rect", { x: w.x, y: w.y, width: w.w, height: w.h, rx: w.w * 0.1, fill: "#0b0e14", stroke: "#6e7681", "stroke-width": sw }, gUnder);
    if (list.every(({ e: x }) => gateMode(x) === "lane"))
      el("line", { x1: gh.mp, y1: G.rowY, x2: gh.mq, y2: G.rowY, stroke: "#3a414b", "stroke-width": Math.max(3, (e.pw || 22) * 0.25) }, gUnder);
    const fs = Math.max(9, Math.min(15, gh.R.w * 0.042));   // labels above the windows
    const lbl = (w, t) => { const x = el("text", { x: w.cx, y: w.y - fs * 0.6, "text-anchor": "middle", fill: "#c9d1d9" }, gUnder); x.style.fontSize = fs + "px"; x.textContent = t; };
    lbl(W.fire, "🔥 fire wall");
    if (ports) lbl(W.port, "🚧 port 443");
    else ["no", "receptionist"].forEach((t, i) => {   // below the pipe that runs along the row
      const x = el("text", { x: W.port.cx, y: G.rowY + (e.pw || 22) / 2 + 6 + fs * (1 + i * 1.15), "text-anchor": "middle", fill: "#8b949e" }, gUnder); x.style.fontSize = fs * 0.9 + "px"; x.textContent = t; });
  }
  function flame(p, x, y, s, begin) {   // a small flickering flame standing on the bricks (base at x, y; s = scale)
    const g = el("g", { transform: `translate(${x} ${y}) scale(${s})` }, p), f = el("g", {}, g);
    el("path", { d: "M0 0 C-4 0 -5 -3 -4 -6 C-3 -8 -1 -9 0 -12 C1 -9 4 -8 4 -5 C5 -2 3 0 0 0 Z", fill: "#f97316", stroke: "#7c2d12", "stroke-width": 0.6 }, f);
    el("path", { d: "M0 0 C-2 0 -2.5 -2 -2 -3.5 C-1.5 -4.5 -0.5 -5 0 -7 C0.5 -5 2 -4.5 2 -3 C2.5 -1.5 1.5 0 0 0 Z", fill: "#fde047" }, f);
    el("animateTransform", { attributeName: "transform", type: "scale", values: "1 1;1.12 0.88;0.92 1.12;1 1", dur: "0.8s", begin: begin + "s", repeatCount: "indefinite" }, f);
  }
  function gatehouseGates(rid, list, quiet, story, gp) {   // the fire wall + port barrier over the pipes, and the moving lights (quiet = shut and still, FR126;
    // story = a step of the view's story: the server's call out over a tunnel isn't shown again, FR134; gp = FR141: the gates the story worked by
    // hand, { firewall: [[t, open 0…1], …], T: the step's length })
    const { e, poly } = list[0], gh = GH[e.id], W = gateWins(gh), G = W.G, F = W.fire, P = W.port, ports = ghPorts(list), row = gateMode(e) === "row";
    const g = el("g", { class: "edge gatehouse" + (S.selEdge === e.id ? " sel" : ""), "data-edge": e.id }, gNodes);
    if (NEW_SET && NEW_SET.has(rid)) g.classList.add("stepnew");   // FR125: the gates fade in with their router
    // 🔥 the fire wall: bricks with flames, sliding down into the floor to open (clipped to its window)
    const clip = el("clipPath", { id: "ghc-" + rid }, g); el("rect", { x: F.x + 1, y: F.y + 1, width: F.w - 2, height: F.h - 2 }, clip);
    const wg = el("g", {}, el("g", { "clip-path": `url(#ghc-${rid})` }, g)), bw = F.w - 4, bh = F.h - 4, rh = bh / 6;
    el("rect", { x: F.x + 2, y: F.y + 2, width: bw, height: bh, fill: "#8a3b2a", stroke: "#0a140a", "stroke-width": 1.2 }, wg);
    for (let r = 0; r < 6; r++) { const y = F.y + 2 + r * rh;
      el("line", { x1: F.x + 2, y1: y, x2: F.x + 2 + bw, y2: y, stroke: "#5a2418", "stroke-width": 1.2 }, wg);
      for (const f of r % 2 ? [1 / 6, 1 / 2, 5 / 6] : [1 / 3, 2 / 3]) el("line", { x1: F.x + 2 + f * bw, y1: y, x2: F.x + 2 + f * bw, y2: y + rh, stroke: "#5a2418", "stroke-width": 1.2 }, wg); }
    const fsc = F.w / 36;
    flame(wg, F.x + F.w * 0.27, F.y + F.h * 0.25, fsc, 0); flame(wg, F.x + F.w * 0.73, F.y + F.h * 0.38, fsc, 0.3); flame(wg, F.x + F.w * 0.45, F.y + F.h * 0.9, fsc, 0.55);
    // 🚧 the port barrier (the receptionist): lifts to open
    let arm = null; const hx = P.x + P.w * 0.125, hy = G.rowY;
    if (ports) {
      el("rect", { x: P.x + P.w * 0.03, y: hy + P.w * 0.15, width: P.w * 0.17, height: Math.max(4, P.y + P.h - 2 - (hy + P.w * 0.15)), rx: 2, fill: "#c9d1d9" }, g);
      arm = el("g", {}, g);
      el("rect", { x: P.x + P.w * 0.075, y: hy - P.w * 0.1, width: P.w * 0.85, height: P.w * 0.2, rx: P.w * 0.07, fill: "#a3c55a", stroke: "#0a140a", "stroke-width": 1 }, arm);
      for (const f of [0.32, 0.55, 0.78]) el("rect", { x: P.x + P.w * f, y: hy - P.w * 0.1, width: P.w * 0.1, height: P.w * 0.2, fill: "#0b0e14" }, arm);
      el("circle", { cx: hx, cy: hy, r: P.w * 0.075, fill: "#0b0e14" }, g);
    }
    if (story && gp && gp.firewall && gp.firewall.length) {   // FR141: the fire wall as the story left it or works it: slid down = open, and it stays so
      const f = (v) => +v.toFixed(4), tk = (t) => f(Math.max(0, Math.min(1, t / gp.T))), kv = gp.firewall[0][0] > 0 ? [[0, gp.firewall[0][1]], ...gp.firewall] : gp.firewall.slice();
      if (kv[kv.length - 1][0] < gp.T) kv.push([gp.T, kv[kv.length - 1][1]]);
      if (kv.some((v) => v[1] !== kv[0][1])) el("animateTransform", { attributeName: "transform", type: "translate", values: kv.map((v) => `0 ${f(F.h * v[1])}`).join(";"), keyTimes: kv.map((v) => tk(v[0])).join(";"), dur: f(gp.T) + "s", repeatCount: "1", fill: "freeze", begin: f(S.stepT0) + "s" }, wg);
      else if (kv[0][1]) wg.setAttribute("transform", `translate(0 ${f(F.h * kv[0][1])})`);
    }
    if (story && row) return;   // FR141: on a direct route the story's visitors are runners and the wall is worked by hand — no lights
    if (quiet) return;   // FR126: nobody comes in in this step — no lights, the gates stay shut
    // the moving lights (your friend's request · a request at a shut gate)
    const pw = e.pw || 22, R1 = pw * 0.45, R2 = pw * 0.22, d = "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "), L = polyLen(poly) || 1;
    const light = () => { const lg = el("g", { class: "gh-anim", "pointer-events": "none" }, g); el("circle", { r: R1, fill: "#ffffff", opacity: 0.3 }, lg); el("circle", { r: R2, fill: "#ffffff" }, lg); return lg; };
    const f3 = (v) => Math.max(0, Math.min(1, v)).toFixed(4);
    const red = (lg, t) => { for (const c of lg.children) ghAnim(c, { attributeName: "fill", values: "#ffffff;#ffffff;#ff5c5c;#ff5c5c", keyTimes: `0;${t};${(+t + 0.02).toFixed(2)};1` }); };
    const cross = (pt, t0) => { const x = el("text", { x: pt.x, y: pt.y - R1 * 1.6, "text-anchor": "middle", fill: "#ff5c5c", opacity: 0, "pointer-events": "none" }, g);
      Object.assign(x.style, { fontSize: Math.max(14, R1 * 2.2) + "px", fill: "#ff5c5c" }); x.textContent = "✕";   // inline: beats .edge text
      ghAnim(x, { attributeName: "opacity", values: "0;0;1;1;0;0", keyTimes: `0;${t0};${(t0 + 0.02).toFixed(2)};${(t0 + 0.12).toFixed(2)};${(t0 + 0.16).toFixed(2)};1` }); };
    const gap = G.ww / 2 + R1 + 2;
    if (row) {   // your friend's request comes in from the far (internet) end: the fire wall slides down, the barrier lifts
      const opensPort = (e.open || []).includes("port"), dF = distTo(poly, { x: F.cx, y: F.cy }), dP = distTo(poly, { x: P.cx, y: P.cy });
      const fF = f3((dF + gap) / L), fP = f3((dP + gap) / L), a = light();
      if (opensPort) ghAnim(a, { path: d, keyPoints: `1;${fF};${fF};${fP};${fP};0;0`, keyTimes: "0;0.1;0.15;0.21;0.26;0.42;1", calcMode: "linear" });
      else ghAnim(a, { path: d, keyPoints: `1;${fF};${fF};0;0`, keyTimes: "0;0.1;0.15;0.42;1", calcMode: "linear" });
      ghAnim(a, { attributeName: "opacity", values: "1;1;0;0", keyTimes: "0;0.42;0.45;1" });
      ghAnim(wg, { attributeName: "transform", type: "translate", values: `0 0;0 0;0 ${F.h};0 ${F.h};0 0;0 0`, keyTimes: "0;0.1;0.15;0.33;0.38;1" });
      if (arm && opensPort) ghAnim(arm, { attributeName: "transform", type: "rotate", values: [0, 0, -80, -80, 0, 0].map((v) => `${v} ${hx} ${hy}`).join(";"), keyTimes: "0;0.21;0.26;0.38;0.43;1" });
      const b = light(), fB = f3((dF + gap + 60) / L);   // later, with the gates shut again: stopped at the fire wall
      ghAnim(b, { path: d, keyPoints: `1;1;${fF};${fB};${fB}`, keyTimes: "0;0.55;0.68;0.75;1", calcMode: "linear" });
      ghAnim(b, { attributeName: "opacity", values: "0;0;1;1;0;0", keyTimes: "0;0.54;0.56;0.72;0.78;1" }); red(b, 0.67);
      cross(polyAt(poly, dF + gap), 0.68);
    } else {   // a tunnel: your server calls out over the gates, your friend comes back in on that line — nothing opens
      if (!story) {   // FR134 / FR136: in a story step neither — a runner (Jazz) takes your friend's way through the tunnel
        const a = light();
        ghAnim(a, { path: d, keyPoints: "0;0;1;1;1;0;0", keyTimes: "0;0.04;0.26;0.3;0.34;0.58;1", calcMode: "linear" });
        ghAnim(a, { attributeName: "opacity", values: "0;1;1;0;0;1;1;0;0", keyTimes: "0;0.04;0.25;0.28;0.33;0.35;0.57;0.61;1" });
      }
      const fr = [{ x: gh.mq, y: G.rowY }, { x: gh.mp, y: G.rowY }], Lr = Math.abs(gh.mq - gh.mp) || 1;   // a stranger at the front door
      const fS = f3((Math.abs(gh.mq - F.cx) - gap) / Lr), fSb = f3((Math.abs(gh.mq - F.cx) - gap - 40) / Lr), b = light();
      ghAnim(b, { path: `M ${fr[0].x} ${fr[0].y} L ${fr[1].x} ${fr[1].y}`, keyPoints: `0;0;${fS};${fSb};${fSb}`, keyTimes: "0;0.66;0.79;0.86;1", calcMode: "linear" });
      ghAnim(b, { attributeName: "opacity", values: "0;0;1;1;0;0", keyTimes: "0;0.65;0.67;0.83;0.89;1" }); red(b, 0.78);
      cross(polyAt(fr, Math.abs(gh.mq - F.cx) - gap), 0.79);
    }
  }
  // FR121: one loop of the book. Your friend's white light (the https address) comes in on n.lights.ask and slides under the
  // closed book; the cover opens TOWARD that line and the pages flip to the entry, which lights up ("✓ … matches ip …"); the
  // ip is packed into a gray light that leaves along n.lights.answer, and the far end glows. With n.lights.update the loop
  // starts with your server's ip coming in on that line (the server updates its own entry).
  function drawPhonebook(g, n, B, col, lt, under, over) {
    const { W, H } = PB, D = lt.dir, s = B.s, DARK = "#0a140a", PAGE = "#f6f1e3", INK = "#1f2328", BAR = "#d6cfbd", EDGE = "#b9b2a2", GRAY = "#9aa3ad";
    const INSIDE = shade(col, 0.7), BAND = shade(col, 1.3), CY = H / 2 - 3, MONO = "ui-monospace, monospace";
    const lines = entryOf(n).split("\n"), url = lines[0] || "", host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const ip = (lines.slice(1).join(" ").match(IP_RE) || ["?"])[0], ipt = ipTag(ip);
    const off = lt.update ? PB.U : 0, T = PB.T + off, k = (d) => +((off + d * PB.T) / T).toFixed(4);   // demo fraction → this loop
    const keys = (kv) => { const v = [...(off ? [[0, kv[0][1]]] : []), ...kv.map(([d, x]) => [k(d), x])];
      return { keyTimes: v.map((p) => p[0]).join(";"), values: v.map((p) => p[1]).join(";") }; };
    const wr = lt.write, once = lt.write || lt.read;   // FR129: written by a runner in this step — the book plays once, from then (no update light: the runner brings the entry); FR136: or read
    const anim = lt.still ? () => null : (p, a) => el(a.path ? "animateMotion" : a.type ? "animateTransform" : "animate", { dur: T + "s",   // FR136: still = shut, nothing moves
      ...(once ? { repeatCount: "1", fill: "freeze", begin: +(S.stepT0 + once.t).toFixed(3) + "s" } : { repeatCount: "indefinite" }), ...a }, p);
    const fade = (p, kv) => anim(p, { attributeName: "opacity", ...keys(kv) });
    const pathOf = (pts) => "M " + pts.map((q) => `${q.x} ${q.y}`).join(" L ");
    const motion = (p, pts, kv) => { const q = keys(kv); anim(p, { path: pathOf(pts), keyPoints: q.values, keyTimes: q.keyTimes, calcMode: "linear" }); };
    // book units: the spine at x 0, the page top at y 0; X() mirrors a span for a spine-right book (its text never mirrors)
    const X = (x0, w) => D === 1 ? x0 : -(x0 + w), hx = D === 1 ? B.x : B.x + B.w, py = B.y + 3 * s;
    const root = el("g", { transform: `translate(${hx} ${py}) scale(${s})` }, g);
    const R = (p, x, y, w, h, a) => { const r = el("rect", { x, y, width: w, height: h, ...a }, p); if (a["stroke-width"]) r.style.strokeWidth = a["stroke-width"]; return r; };   // inline: beats .node rect
    const txt = (p, x, y, t, st, a) => { const e = el("text", { x, y, ...(a || {}) }, p); Object.assign(e.style, st); e.textContent = t; return e; };   // inline: beats .node text
    const page = (p, pl, letter) => { R(p, pl, 0, W, H, { fill: PAGE, stroke: EDGE, "stroke-width": 0.8 });
      if (letter) txt(p, pl + W / 2, 11, letter, { fontSize: "9px", fontWeight: 700, fill: "#9a917d" }, { "text-anchor": "middle" }); };
    const rows = (p, pl, ys) => ys.forEach((y, i) => { R(p, pl + 7, y, 24 + (i * 11) % 22, 2.4, { rx: 1, fill: BAR }); R(p, pl + W - 33, y, 26, 2.4, { rx: 1, fill: BAR }); });   // other people: name … number
    const ROWS = [0, 1, 2, 3, 4, 5, 6].map((i) => 19 + i * 8), pl0 = X(0, W), plO = X(-W, W);   // the closed side's page / the open side's
    const cover = (p) => {
      R(p, X(0, W), -3, W, H, { rx: 4, fill: col, stroke: DARK, "stroke-width": 1.5 });
      R(p, X(0, 11), -3, 11, H, { rx: 4, fill: INSIDE, stroke: DARK, "stroke-width": 1.5 });
      for (const y of [7, H - 13]) el("line", { x1: D * 2, y1: y, x2: D * 9, y2: y, stroke: BAND, "stroke-width": 1.5 }, p);
      [["DNS", 15, CY - 1], ["PHONEBOOK", 10.5, CY + 13]].forEach(([t, fs, y]) =>
        txt(p, D * (11 + (W - 11) / 2), y, t, { fontSize: fs + "px", fontWeight: 700, letterSpacing: "1.5px", fill: "#ffffff" }, { "text-anchor": "middle" }));
      if (n.childDiagram) txt(p, D === 1 ? W - 6 : 6 - W, H - 9, "⊕ open", { fill: "rgba(255,255,255,0.8)" }, { "text-anchor": D === 1 ? "end" : "start", class: "drill" });   // FR85
    };
    const AT = [0.18, 0.25, 0.30, 0.35], HALF = [0.03, 0.022, 0.022, 0.022], C0 = 0.55, C1 = 0.58, C2 = 0.61;   // turn i (0 = the cover) starts at AT[i]; shut C0 → C2
    const turn = (i, side, draw) => { const f = el("g", side === "open" ? { class: "pb-anim", transform: "scale(0 1)" } : { class: "pb-anim" }, root), a = AT[i], h = HALF[i];
      draw(f);   // a turn folds a closed-side face into the spine, then unfolds its open-side face
      const kv = side === "open" ? [[0, "0 1"], [a + h, "0 1"], [a + 2 * h, "1 1"], [C0, "1 1"], [C1, "0 1"], [1, "0 1"]]
        : i ? [[0, "1 1"], [a, "1 1"], [a + h, "0 1"], [C2, "0 1"], [C2 + 0.005, "1 1"], [1, "1 1"]]   // a page's front comes back under the shut cover
        : [[0, "1 1"], [a, "1 1"], [a + h, "0 1"], [C1, "0 1"], [C2, "1 1"], [1, "1 1"]];
      anim(f, { attributeName: "transform", type: "scale", ...keys(kv) }); };
    R(root, X(0, W + 5), -3, W + 5, H + 7, { rx: 4, fill: INSIDE, stroke: DARK, "stroke-width": 1.5 });   // the back cover
    page(root, pl0, "Y"); rows(root, pl0, [55, 62, 69]);   // the last page: your entry
    const hl = R(root, pl0 + 5, 17, W - 10, 31, { rx: 3, fill: "#fde68a", opacity: 0, class: "pb-anim" });
    const fs = Math.min(9, (W - 24) / (Math.max(host.length, ipt.length, 1) * 0.6));
    txt(root, pl0 + 19, 30, host, { fontSize: fs + "px", fill: INK, fontFamily: MONO });
    txt(root, pl0 + 19, 42, ipt, { fontSize: fs + "px", fill: INK, fontFamily: MONO, fontWeight: 700 });
    const hit = el("circle", { cx: pl0 + 12, cy: 27, r: 9, fill: "#ffffff", stroke: INK, "stroke-width": 1, opacity: 0, class: "pb-anim" }, root);   // the white light, landed
    if (wr) {   // FR129: the entry is written while the book is open — a pencil goes along each line, a page-coloured cover slides off behind it
      const f3 = (v) => +v.toFixed(3), x0 = pl0 + 19, w1 = Math.min(W - 24, host.length * 0.6 * fs), w2 = Math.min(W - 24, ipt.length * 0.6 * fs);
      for (const [y0, d0, d1] of [[19, 0.42, 0.48], [31, 0.48, 0.54]]) {
        const m = R(root, pl0 + 15, y0, W - 20, 13, { fill: PAGE, class: "pb-anim" });
        anim(m, { attributeName: "x", ...keys([[0, f3(pl0 + 15)], [d0, f3(pl0 + 15)], [d1, f3(pl0 + W - 5)], [1, f3(pl0 + W - 5)]]) });
        anim(m, { attributeName: "width", ...keys([[0, W - 20], [d0, W - 20], [d1, 0], [1, 0]]) });
      }
      const pen = el("g", { class: "pb-anim", opacity: 0 }, root);
      el("path", { d: "M 0 0 L 2 -5 L 11 -14 L 14 -11 L 5 -2 Z", fill: "#facc15", stroke: DARK, "stroke-width": 0.8 }, pen);
      el("path", { d: "M 11 -14 L 13 -16 L 16 -13 L 14 -11 Z", fill: "#f472b6", stroke: DARK, "stroke-width": 0.8 }, pen);
      anim(pen, { attributeName: "transform", type: "translate", ...keys([[0, `${f3(x0)} 28`], [0.42, `${f3(x0)} 28`], [0.48, `${f3(x0 + w1)} 28`],
        [0.485, `${f3(x0)} 40`], [0.54, `${f3(x0 + w2)} 40`], [1, `${f3(x0 + w2)} 40`]]) });
      fade(pen, [[0, 0], [0.41, 0], [0.42, 1], [0.54, 1], [0.56, 0], [1, 0]]);
    }
    for (const [i, l] of [[3, "P"], [2, "H"], [1, "A"]]) turn(i, "closed", (f) => { page(f, pl0, l); rows(f, pl0, ROWS); });
    turn(0, "closed", cover);
    turn(0, "open", (f) => R(f, X(-W - 5, W + 5), -3, W + 5, H + 7, { rx: 4, fill: INSIDE, stroke: DARK, "stroke-width": 1.5 }));
    for (const i of [1, 2, 3]) turn(i, "open", (f) => { page(f, plO); rows(f, plO, ROWS); });
    cover(el("g", { class: "pb-still" }, root));   // prefers-reduced-motion: a still, shut book
    if (n.badge === "snail") {   // slow
      const sg = el("g", { transform: `translate(${X(W - 39, 44)} -19)` }, root);
      el("path", { d: "M2 22 Q6 15 16 16 L34 16 Q39 16 38 22 Z", fill: "#c9b38f", stroke: DARK, "stroke-width": 1.2 }, sg);
      el("circle", { cx: 16, cy: 11, r: 9, fill: "#b07a3c", stroke: DARK, "stroke-width": 1.2 }, sg);
      el("path", { d: "M16 11 m-3 0 a3 3 0 1 1 3 3 a5.5 5.5 0 1 1 5.5 -5.5", fill: "none", stroke: DARK, "stroke-width": 1.1 }, sg);
      for (const [x2, y2] of [[37, 7], [41, 10]]) { el("line", { x1: 34, y1: 16, x2, y2, stroke: "#c9b38f", "stroke-width": 1.4 }, sg); el("circle", { cx: x2, cy: y2, r: 1.8, fill: "#c9b38f" }, sg); }
    } else if (n.badge === "bolt") {   // fast
      const bx0 = X(W - 22, 17);
      el("polygon", { points: [[9, 0], [0, 15], [7, 15], [3, 28], [16, 10], [9, 10], [13, 0]].map(([a, c]) => `${bx0 + a},${c - 19}`).join(" "), fill: "#fde047", stroke: DARK, "stroke-width": 1.2 }, root);
    }
    // found: the white light's address matches an ip
    fade(hl, [[0, 0], [0.40, 0], [0.42, 1], [C2, 1], [C2 + 0.01, 0], [1, 0]]);
    if (lt.ask) {   // FR124: the landed light only when someone looks the name up
      fade(hit, [[0, 0], [0.39, 0], [0.40, 1], [C2, 1], [C2 + 0.01, 0], [1, 0]]);
      anim(hit, { attributeName: "r", ...keys([[0, 9], [0.39, 9], [0.42, 3.4], [1, 3.4]]) });
    }
    const cap = txt(root, 0, -24, "", { fontSize: "12px" }, { "text-anchor": "middle", opacity: 0, class: "pb-anim" });
    const capT = lt.ask || lt.read ? [["✓ ", "#3fb950"], [url, "#ffffff"], [" matches ", "#8b949e"], [ipt, GRAY]]   // FR124: no lookup → the entry was written
      : [["✎ ", "#f97316"], [url, "#ffffff"], [" → ", "#8b949e"], [ipt, GRAY], [" written", "#8b949e"]];
    for (const [t, fill] of capT) el("tspan", { fill }, cap).textContent = t;
    fade(cap, [[0, 0], [0.41, 0], [0.43, 1], [0.62, 1], [0.65, 0], [1, 0]]);
    // the lights ride the lines (diagram units): under the book coming in, over everything going out
    const light = (p, c, tag) => { const lg = el("g", { class: "pb-anim", opacity: 0, "pointer-events": "none" }, p);
      return { g: lg, halo: el("circle", { r: 9 * s, fill: c, opacity: 0.3 }, lg), core: el("circle", { r: 4.5 * s, fill: c }, lg),
        tag: txt(lg, 0, -14 * s, tag, { fontSize: 10 * s + "px", fill: c, fontFamily: "ui-sans-serif, system-ui, sans-serif" }, { "text-anchor": "middle" }) }; };
    const inside = (pts) => { const q = pts[pts.length - 1], c = { x: B.x + B.w / 2, y: B.y + B.h / 2 }, L = Math.hypot(c.x - q.x, c.y - q.y) || 1, t = Math.min(1, 30 * s / L);
      return [...pts, { x: q.x + (c.x - q.x) * t, y: q.y + (c.y - q.y) * t }]; };   // …and on under the closed book
    if (lt.update) {   // your server updates its own entry: its ip comes in first
      const u = light(under, GRAY, ipt), f = (t) => +(t / T).toFixed(4);
      anim(u.g, { path: pathOf(inside(lt.update.poly)), keyPoints: "0;0;1;1", keyTimes: `0;${f(0.1)};${f(PB.U - 0.3)};1`, calcMode: "linear" });
      anim(u.g, { attributeName: "opacity", values: "0;1;1;0;0", keyTimes: `0;${f(0.15)};${f(PB.U - 0.35)};${f(PB.U - 0.15)};1` });
    }
    if (lt.ask) {
      const a = light(under, "#ffffff", url);
      motion(a.g, inside(lt.ask.poly), [[0, 0], [0.15, 1], [1, 1]]);
      fade(a.g, [[0, 0], [0.02, 1], [0.15, 1], [0.17, 0], [1, 0]]);
    }
    if (lt.answer) {   // the ip, packed into a gray light (its halo shrinks onto it), travels on to the far end
      const o = light(over, GRAY, ipt), st = { x: hx + (pl0 + 60) * s, y: py + 39 * s };
      o.halo.setAttribute("r", 26 * s);
      motion(o.g, [st, ...lt.answer.poly], [[0, 0], [C0, 0], [0.78, 1], [1, 1]]);
      fade(o.g, [[0, 0], [0.47, 0], [0.48, 1], [0.78, 1], [0.80, 0], [1, 0]]);
      anim(o.halo, { attributeName: "r", ...keys([[0, 26 * s], [0.48, 26 * s], [0.53, 9 * s], [1, 9 * s]]) });
      anim(o.core, { attributeName: "r", ...keys([[0, 0], [0.49, 0], [0.53, 4.5 * s], [1, 4.5 * s]]) });
      fade(o.tag, [[0, 0], [0.635, 0], [0.655, 1], [1, 1]]);   // once it is clear of the book
      if (lt.glow) fade(el("circle", { cx: lt.glow.x, cy: lt.glow.y, r: 26 * s, fill: "#fff3a0", opacity: 0, class: "pb-anim", "pointer-events": "none" }, over),
        [[0, 0], [0.78, 0], [0.80, 0.55], [0.88, 0], [1, 0]]);
    }
  }

  /* ---------- FR124: step mode — the view told step by step, acted out by a runner (mirrored in gen_flow_svg.py) ---------- */
  const ACT = { V: 240, FADE: 0.4, HOP: 0.32, MIN: 1.2, MAX: 5, STAND: 8, WALK: 0.6, SIZE: 26, BLOW: 0.5,   // px/s · s (a run lasts 1.2–5 s, a walk at least 0.6 s;
    T: { get: 0.9, pop: 0.9, hammer: 3, give: 0.7, scene: 0.4, unscene: 0.3, put: 0.8, putIn: 0.7, open: 0.6, close: 0.5, fire: 0.8, take: 0.6, unlock: 0.5,   // a step without
      throw: 1.0, copy: 1.2, write: 6.0, hand: 0.8, show: 0.6, burn: 3.2, update: 7.6, bounce: 2.4, gate: 0.8 } };   // a script lasts its dur, else STAND; FR131: a hammer blow every BLOW s)
  const ACT_ITEMS = {   // what a runner can carry: how it looks and where it sits above its feet (keys left, the light right, texts on top)
    key:     { icon: "key", color: "#f97316", dx: -14, dy: -32, tag: "auth key" },
    token:   { icon: "key", color: "#f97316", dx: -14, dy: -32, tag: "DuckDNS token" },   // FR141: a token that is not used up (DuckDNS)
    idkey:   { icon: "key", color: "#3fb950", dx: -14, dy: -32, tag: "own key" },
    light:   { light: true, color: "#fff3a0", dx: 20, dy: -32 },   // (FR140: right of the vault above its head)
    vault:   { vault: "keepass", color: "#c9d1d9", dx: 0, dy: -40 },   // FR130: a small safe locked with the KeePass logo, above its head
    ip:      { text: "Your SelfPrivacy IP address:\n192.42.69.314", color: "#9aa3ad", dx: 0, dy: -74 },   // FR132: two lines, the last one at dy
    domain:  { text: "selfprivacy.tail1234.ts.net", color: "#f97316", dx: 0, dy: -60 },
    answer:  { book: true, color: "#9aa3ad", dx: 0, dy: -74 },   // FR136: the address a book gives for a name — its text comes from the book's entry
    answer4: { book: true, color: "#9aa3ad", dx: 0, dy: -74 },   // FR149: the IPv4 address a book gives an IPv4-only phone (`lookup` … `as`) — its text from the step's texts
    jitsi:   { img: "jitsi", color: "#4aa3ff", dx: 0, dy: -40, tag: "Jitsi call" },   // FR136: the call — the Jitsi Meet logo on a blue badge
    backup:  { icon: "backup", color: "#58a6ff", dx: -24, dy: -18 },   // FR140: your server's SelfPrivacy backup (low on its left, clear of the vault)
    olddomain: { text: "old: selfprivacy.tail1234.ts.net", color: "#8b949e", dx: 0, dy: -60 },   // FR139: the old machine's name, still at Tailscale
    oldip:   { text: "old machine's IP address:\n192.42.69.314", color: "#8b949e", dx: 0, dy: -100 },   // FR139: …and its address (above your own IP)
  };
  // FR135: the KeePass vault — a small safe (size, door inset), its door hinged left and locked with the KeePass logo (lock = the
  // logo's size); IN = where a thing lies inside it and how small (mirrored in docs/gen_flow_svg.py VAULT)
  const VAULT = { w: 34, h: 28, inset: 3, lock: 14, IN: { x: -2, y: 0, s: 0.7 } };
  const BURN_FLAMES = [[-0.34, 0.65, 0], [-0.17, 0.85, 0.3], [0, 1, 0.55], [0.17, 0.85, 0.15], [0.34, 0.65, 0.45]];   // FR140: x (of the width), size, flicker phase
  const ACTORS = ["mario", "yoshi", "jazz", "cousin"];   // FR129: who acts — "who" in a step's script (mario when left out); sprite #ic-<who> (FR149: the cousin, on an IPv4-only phone)
  const WALKERS = ["mario", "jazz", "cousin"];   // FR151: Tux, Big Buck Bunny, Ferris — their legs step between #ic-<who>-w1 / -w2 while they move (Yoshi only hops)
  // FR128 / FR129: the scene the runners work in — a brick ledge above the box where it starts (Tailscale), the fire bowl, two safes
  // side by side (a gap between them) and a shelf with two boards; geometry relative to the spot it started on (mirrored in
  // docs/gen_flow_svg.py SCENE): the ledge (x range, top, height); a safe (size, door inset, keyhole height); per safe its left edge,
  // hinge side and where a runner stands to work it; the fire bowl; the shelf (left edge, size, where to stand, its boards); how
  // small things are inside a safe / on a board. OPEN = the door's x-scale when open (swung out past its hinge). FR132: the safes
  // a safe's width further right, the shelf big enough to read (it ends left of the pipe from the internet, at x ≈ 304).
  const SCENE = { x0: -84, x1: 284, top: -72, h: 12, OPEN: -0.35, safe: { w: 44, h: 52, inset: 5, lock: 17 },
    A: { x: 16, hinge: "l", mark: 0 }, B: { x: 78, hinge: "r", mark: 137 }, F: { x: -68 },
    S: { x: 160, w: 114, h: 72, mark: 148, rows: ["top", "bottom"] }, IN: { safe: 0.22, shelf: 0.8, icon: 0.8 } };
  const r1 = (v) => Math.floor(v * 10 + 0.5) / 10;
  const kvAt = (kv, t) => { let v = 0; for (let i = 0; i < kv.length; i++) { const [a, x] = kv[i]; if (a > t) { if (i) { const [b, y] = kv[i - 1];   // FR139: a key-framed value at t
    v = a > b ? +(y + (x - y) * (t - b) / (a - b)).toFixed(4) : x; } return v; } v = x; } return v; };   // tenths, halves up (Python: math.floor(v * 10 + 0.5) / 10)
  function sceneGeo(O) {   // where the ledge, the safes (keyhole, keyhole of the open door, inside, where to stand), the fire bowl and the shelf are
    const s = SCENE.safe, top = O.y + SCENE.top, g = { O, top, x0: O.x + SCENE.x0, x1: O.x + SCENE.x1, fire: { x: O.x + SCENE.F.x, y: top } };
    for (const k of ["A", "B"]) {
      const x = O.x + SCENE[k].x, y = top - s.h, dw = s.w - 2 * s.inset, hx = SCENE[k].hinge === "l" ? x + s.inset : x + s.inset + dw, lock = { x: x + s.w / 2, y: y + s.lock };
      g[k] = { x, y, hx, dw, lock, open: { x: hx + SCENE.OPEN * (lock.x - hx), y: lock.y }, inside: { x: x + s.w / 2, y: y + s.h / 2 + 3 }, mark: { x: O.x + SCENE[k].mark, y: top } };
    }
    const sh = SCENE.S, x = O.x + sh.x, y = top - sh.h, rh = sh.h / sh.rows.length;
    g.S = { x, y, w: sh.w, h: sh.h, rh, mark: { x: O.x + sh.mark, y: top } };
    sh.rows.forEach((r, i) => { g["S." + r] = { x: x + sh.w / 2, y: y + rh * (i + 1) - 7 }; });   // where a thing stands on that board (just above it)
    return g;
  }
  // The plan of one step: per runner its path (runs and walks joined end to end; between two lines it walks across the box), the
  // key frames [time, distance] it moves between (equal distances = standing), what it carries when ([on, off] intervals), which
  // way it faces, when it shows, the signs it holds up and what it does where (hammer at a box); the scene; the things away from
  // the runners (into a keyhole, a safe, a shelf, the fire, a box, and back), each copy a track of its own; and which books get
  // written when. FR125: it starts where the step before ended (`start` = {actors: {who: {spot, at, items, face}}, scene}), so
  // one step's end state is the next one's start state; mario fades in only at the story's first step (or with nothing to follow
  // on from), every runner fades out only at its last step; a step without a script lasts its `dur`. The plan runs ONCE
  // (repeatCount 1, frozen at its end); the next step takes over from there.
  function actorPlan(step, epoly, start, first, last, boxAt, screenAt) {
    const edgeOf = (id) => S.data.edges.find((e) => e.id === id), st0 = (start && start.actors) || {};
    let T = first || !st0.mario ? ACT.FADE : 0, sc = null, nInst = 0;
    const W = {}, writes = [], ACTS = {}, reads = [], shown = [], burns = [], texts = { ...((start && start.texts) || {}), ...(step.texts || {}) };   // FR136: books looked up, things shown on boxes, texts from books (FR141: a step may set the texts of what is carried)
    const bounces = [], GT = {}, g0 = (start ? start.gates : step.gates) || {};   // FR147: where a runner was bounced off a line; FR141: the gates worked by hand — as the step before left them, or as the story's first step says
    for (const h in g0) { GT[h] = {}; for (const gn in g0[h]) GT[h][gn] = [[0, +g0[h][gn]]]; }
    const carry = (R, id, on) => { const l = R.items[id] = R.items[id] || []; if (!l.some((v) => v[1] == null)) l.push([on, null]); };   // (already holding it: nothing changes)
    const drop = (R, id, off) => { const iv = R.items[id] && R.items[id].find((v) => v[1] == null); if (iv) iv[1] = off; };
    const actor = (who) => {   // a runner: where it is, its path, what it holds, which way it faces, when it shows
      if (ACTS[who]) return ACTS[who];
      const s0 = st0[who], fc = s0 && s0.face ? s0.face : 1;
      const R = ACTS[who] = { who, pts: [], kf: [], dist: 0, runs: [], acts: [], pops: [], items: {}, inst: {}, doors: {}, inside: {}, spot: null, at: null, facing: fc, face: [[0, fc]], op: [[0, s0 ? 1 : 0]], gone: false };
      if (s0) { R.spot = s0.spot; R.at = s0.at; R.pts.push(s0.spot); R.kf.push([0, 0]); for (const id of s0.items) carry(R, id, 0); }
      return R; };
    const turn = (R, t, dx) => { if (Math.abs(dx) <= 1) return; const v = dx > 0 ? 1 : -1; if (v === R.facing) return;   // it faces where it goes or works
      R.facing = v; const l = R.face[R.face.length - 1]; if (l[0] === t) l[1] = v; else R.face.push([t, v]); };
    const goTo = (R, q, dur) => { R.kf.push([T, R.dist]); turn(R, T, q.x - R.spot.x); const L = Math.hypot(q.x - R.spot.x, q.y - R.spot.y);
      R.pts.push(q); R.runs.push([T, T + dur]); T += dur; R.dist += L; R.kf.push([T, R.dist]); R.spot = q; };
    const hand = (R, id) => ({ x: R.spot.x + ACT_ITEMS[id].dx, y: R.spot.y + ACT_ITEMS[id].dy });
    const track = (inst) => W[inst] = W[inst] || { id: inst.split("#")[0], pts: [], kf: [], d: 0, vis: [], sc: [], rot: [] };
    const newInst = (id) => id + "#" + (++nInst);
    const instOf = (R, id) => R.inst[id] || (R.inst[id] = newInst(id));   // the copy the runner holds (a new one when it got it by `get`)
    const kfAdd = (w, t, d) => { const l = w.kf[w.kf.length - 1]; if (!l || l[0] !== t || l[1] !== d) w.kf.push([t, d]); };
    const wMove = (inst, t0, t1, path) => { const w = track(inst);   // the thing goes from where it is along the path, between t0 and t1
      if (!w.pts.length) { w.pts.push(path[0]); kfAdd(w, t0, 0); path = path.slice(1); }
      kfAdd(w, t0, w.d);
      for (const q of path) { const p = w.pts[w.pts.length - 1], L = Math.hypot(q.x - p.x, q.y - p.y); if (L > 0) { w.d += L; w.pts.push(q); } }
      kfAdd(w, t1, w.d); };
    const holder = (k) => !sc || !(k === "A" || k === "B" || (k.startsWith("S.") && SCENE.S.rows.includes(k.slice(2)))) ? null   // inside a safe, or on a shelf board
      : k === "A" || k === "B" ? { at: sc.g[k].inside, safe: true } : { at: sc.g[k], safe: false };
    const inScale = (id, safe) => ACT_ITEMS[id].text ? (safe ? SCENE.IN.safe : SCENE.IN.shelf) : SCENE.IN.icon;
    const middle = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    // FR138: things stored on a box's screen (the vault on Your computer, the backup + vault on the backup laptop) stay there,
    // into the next steps; a copy can be got off them (`get` … `from`), a vault with what lies in it
    const stored = ((start && start.stored) || []).map((v) => ({ ...v, on: 0, off: null }));
    for (const v of stored) shown.push({ id: v.id, at: v.at, x: v.x, y: v.y, s: v.s, inside: v.inside });
    const itemSize = (id) => ACT_ITEMS[id].vault ? [VAULT.w, VAULT.h] : ACT_ITEMS[id].text ? [60, 12] : [18, 18];
    const slotOn = (r, slot, id) => {   // a place on a screen: the middle, or its left / right half; the thing made to fit it
      const half = slot === "left" || slot === "right", w = half ? r.w / 2 : r.w, [iw, ih] = itemSize(id);
      return { x: r.x + (slot === "left" ? w / 2 : slot === "right" ? r.w - w / 2 : r.w / 2), y: r.y + r.h / 2, s: +Math.min(0.9 * w / iw, 0.85 * r.h / ih).toFixed(4) }; };
    if (!start) for (const v of step.stored || []) { const scr = screenAt && ACT_ITEMS[v.id] ? screenAt(String(v.at)) : null; if (!scr) continue;   // FR141: a story may start with things already on a screen
      const slot = slotOn(scr, v.screen, v.id), inside = [].concat(v.inside || []);
      stored.push({ id: v.id, at: String(v.at), x: slot.x, y: slot.y, s: slot.s, inside, on: 0, off: null }); shown.push({ id: v.id, at: String(v.at), x: slot.x, y: slot.y, s: slot.s, inside }); }
    if (start && start.scene) {   // FR129: the scene the step before left standing — as it was, the doors shut, the fire out
      sc = { g: sceneGeo(start.scene.O), t0: 0, fadeIn: false, t1: null, doors: { A: [], B: [] }, lock: {}, fire: [], pops: [],
        inside: start.scene.inside.map((v) => ({ id: v.id, k: v.k, inst: null, on: 0, off: null, x: v.x, y: v.y, s: v.s })) };
    }
    for (const id in st0) actor(id);   // the runners the step before left standing
    // FR149: {"together": [branch, …]} — each branch (one action, or a list of them) starts at the same moment; the script goes on when the
    // last one is done. Flattened here: a branch starts back at the moment the group started. (A branch moves only its own runner.)
    const flat = (l) => l.flatMap((a) => a && Array.isArray(a.together) ? [{ _tg: "start" }, ...a.together.flatMap((b, i) => [...(i ? [{ _tg: "next" }] : []), ...flat([].concat(b))]), { _tg: "end" }] : [a]);
    const TG = [];
    for (const a of flat(step.play || [])) {
      if (a._tg) { if (a._tg === "start") TG.push({ t0: T, t1: T }); else { const g = TG[TG.length - 1]; g.t1 = Math.max(g.t1, T); if (a._tg === "next") T = g.t0; else { T = g.t1; TG.pop(); } } continue; }
      if (a.when != null && !boxAt(String(a.when)) && !(epoly[a.when] && epoly[a.when].length >= 2)) continue;   // FR149: {"when": id} — only where that box or line is drawn
      const R = actor(ACTORS.includes(a.who) ? a.who : "mario");
      if (a.run != null) {   // one line id, or alternatives (the first one drawn in this view wins: e_cable / e_usb)
        const e = [].concat(a.run).map(edgeOf).find((x) => x && epoly[x.id] && epoly[x.id].length >= 2); let p = e && epoly[e.id]; if (!p) continue;
        p = a.back ? p.slice().reverse() : p;
        if (a.from === "here" && R.spot) p = polyFrom(p, distTo(p, R.spot));   // FR149: it goes on from where it stands on the line (not from the line's start)
        if (typeof a.near === "number" && a.near > 0) p = polyUpTo(p, Math.max(0, polyLen(p) - a.near));   // FR149: it stops `near` px before the line's end (in a queue)
        let L = polyLen(p), seq = p;
        if (!R.pts.length) { R.pts.push(...p); R.kf.push([0, 0], [T, 0]); if (T > ACT.FADE) R.op.push([T - ACT.FADE, 0]); R.op.push([T, 1]); }   // it fades in where it starts
        else { const q = R.pts[R.pts.length - 1], gap = Math.hypot(p[0].x - q.x, p[0].y - q.y); R.kf.push([T, R.dist]);
          if (gap > 0.5) { R.pts.push(p[0]); L += gap; seq = [q, ...p]; } R.pts.push(...p.slice(1)); }
        const dur = Math.min(ACT.MAX, Math.max(ACT.MIN, r1(L / ACT.V)));
        for (let j = 1, c = 0; j < seq.length; j++) {   // each stretch that goes left or right turns it that way
          turn(R, T + (L ? c / L : 0) * dur, seq[j].x - seq[j - 1].x); c += Math.hypot(seq[j].x - seq[j - 1].x, seq[j].y - seq[j - 1].y); }
        R.runs.push([T, T + dur]); T += dur; R.dist += L; R.kf.push([T, R.dist]);
        R.spot = p[p.length - 1]; R.at = a.back ? e.from : e.to;
      } else if (a.get != null && a.from != null) {   // FR136: a copy of what is shown on a box comes off it into its hand
        const id = String(a.get); let v = R.spot && ACT_ITEMS[id] && shown.find((x) => x.id === id && x.at === String(a.from));
        if (!v && R.spot && ACT_ITEMS[id]) { const b = boxAt(String(a.from)); if (b) v = { ...middle(b), s: 0.3 }; }   // FR138: out of the box itself (the light, the backup)
        if (!v) continue;
        if (v.inside && v.inside.length) R.inside[id] = v.inside.map((x) => ({ id: x, on: T + ACT.T.show, off: null }));   // FR138: the vault's copy holds what the vault holds
        const inst = newInst(id), w = track(inst), t1 = T + ACT.T.show; turn(R, T, v.x - R.spot.x);
        wMove(inst, T, T, [{ x: v.x, y: v.y }]); wMove(inst, T, t1, [hand(R, id)]); w.vis.push([T, t1]); w.sc.push([T, v.s], [t1, 1]);
        carry(R, id, t1); R.inst[id] = inst; T = t1 + 0.2;
      } else if (a.get != null) { for (const id of [].concat(a.get)) if (ACT_ITEMS[id]) carry(R, id, T); T += ACT.T.get;
      } else if (a.pop != null) { const pd = typeof a.dur === "number" ? a.dur : ACT.T.pop;   // FR141: dur = how long it shows; bad = a red sign
        if (sc && (a.at === "A" || a.at === "B")) { const q = sc.g[a.at]; sc.pops.push([String(a.pop), q.x + SCENE.safe.w / 2, q.y - 28, T, T + pd]); }   // above a safe
        else R.pops.push([String(a.pop), T, T + pd, a.bad ? "#ff5c5c" : "#3fb950"]);
        T += pd;
      } else if (a.hammer != null) { const dur = typeof a.hammer === "number" && a.hammer > 0 ? a.hammer : ACT.T.hammer;
        if (a.at != null && String(a.at) !== R.at) { drop(R, "light", T); continue; }   // FR131: it builds only the box it names, once it got there (wifi: no line there)
        const b = boxAt(R.at), c = b ? middle(b) : null, lit = !!(R.items.light && R.items.light.some((v) => v[1] == null));
        if (c && R.spot) turn(R, T, c.x - R.spot.x);   // it faces the box it builds
        let li = null;
        if (lit && c && R.spot) {   // FR131: the install light goes from its hand into the middle of the box first
          li = instOf(R, "light"); const w = track(li), t1 = T + ACT.T.give;
          delete R.inst.light; drop(R, "light", T); wMove(li, T, T, [hand(R, "light")]); wMove(li, T, t1, [c]); w.vis.push([T, null]); w.sc.push([T, 1], [t1, 1.3]);
          T = t1;
        } else if (lit) drop(R, "light", T + 0.4);
        const t0 = T, t1 = T + dur, blows = [];   // the hammer comes down 0.15 s into every swing; each blow builds the box a ring further out of the light
        for (let k = 0; t0 + 0.15 + k * ACT.BLOW <= t1 - 0.6 + 1e-9; k++) blows.push(+(t0 + 0.15 + k * ACT.BLOW).toFixed(4));
        R.acts.push({ kind: "hammer", t0, t1, at: R.at, c, blows });
        if (li) { const w = track(li); for (const t of blows) w.sc.push([t, 1.3], [t + 0.06, 1.75], [t + 0.3, 1.3]);   // the light flares with every blow…
          w.sc.push([blows.length ? blows[blows.length - 1] + 0.3 : t0, 1.3], [t1 - 0.05, 0.3]); w.vis[w.vis.length - 1][1] = t1; }   // …and sinks into the finished box
        T = t1;
      } else if (a.appear != null) { const b = boxAt(String(a.appear)); if (!b || R.pts.length) continue;   // FR129: it comes out of a box (Yoshi, out of the Tailscale cloud)
        R.spot = a.foot ? { x: b.x + b.w / 2, y: b.y + b.h } : middle(b); R.at = String(a.appear);   // FR141: foot = at the box's bottom edge (Mario in front of your computer)
        R.pts.push(R.spot); R.kf.push([0, 0]); R.op.push([T, 0], [T + ACT.T.scene, 1]); T += ACT.T.scene;
      } else if (a.vanish && R.pts.length) { R.op.push([T, 1], [T + ACT.T.scene, 0]); R.gone = true; T += ACT.T.scene;   // …and goes back in
      } else if (a.scene === false) { if (sc && sc.t1 == null) sc.t1 = T + 0.6; T += ACT.T.unscene;   // FR129: the scene fades away
      } else if (a.scene && R.spot) {   // FR128: the ledge, the safes, the fire bowl and the shelf appear here, holding what the script says
        sc = { g: sceneGeo({ x: R.spot.x, y: R.spot.y }), t0: T, fadeIn: true, t1: null, doors: { A: [], B: [] }, lock: {}, fire: [], pops: [], inside: [] };
        for (const k in a.scene) { const h = holder(k), ids = [].concat(a.scene[k]).filter((id) => ACT_ITEMS[id]); if (!h) continue;
          ids.forEach((id, i) => sc.inside.push({ id, k, inst: null, on: T, off: null, x: h.at.x, y: h.at.y + (i - (ids.length - 1) / 2) * 8, s: inScale(id, h.safe) })); }
        T += ACT.T.scene;
      } else if (sc && ["O", "A", "B", "S"].includes(a.walk) && R.spot) {   // to a safe or the shelf, or back down to where the scene started
        const q = a.walk === "O" ? sc.g.O : a.walk === "S" ? sc.g.S.mark : sc.g[a.walk].mark;
        goTo(R, { x: q.x, y: q.y }, Math.max(ACT.WALK, r1(Math.hypot(q.x - R.spot.x, q.y - R.spot.y) / ACT.V)));
      } else if (a.put != null && ACT_ITEMS[a.put] && R.spot) {   // into a keyhole ("A.lock"), a safe or onto a shelf board ("B", "S.top"), or into a box ("server")
        const id = a.put, into = String(a.in || ""), [k, part] = into.split("."), lock = part === "lock" && sc && (k === "A" || k === "B");
        const h = lock ? null : holder(into), b = !lock && !h ? boxAt(into) : null;
        const scr = b && a.screen && screenAt ? screenAt(into) : null, slot = scr ? slotOn(scr, a.screen, id) : null;   // FR138: onto its screen, to stay
        const to = lock ? sc.g[k].lock : h ? { x: h.at.x, y: h.at.y + sc.inside.filter((v) => v.k === into && v.off == null).length * 8 } : slot ? { x: slot.x, y: slot.y } : b ? middle(b) : null;
        if (!to) continue;
        const keep = a.copy === true && !lock;   // FR132: {"copy": true} — a copy comes off what it holds and goes there; the runner keeps its own
        const inst = keep ? newInst(id) : instOf(R, id), w = track(inst), t0 = T + (keep ? 0.2 : 0), t1 = T + (lock ? 0.5 : keep ? 0.8 : 0.6);
        if (!keep) { delete R.inst[id]; drop(R, id, T); }
        turn(R, T, to.x - R.spot.x); wMove(inst, T, T, [hand(R, id)]); w.vis.push([T, null]); w.sc.push(...(keep ? [[T, 0.6], [t0, 1]] : [[T, 1]]));
        wMove(inst, t0, t1, [to]);
        if (lock) { w.sc.push([t1, 0.8]); w.rot.push([t1, 0], [T + ACT.T.put, 90]); sc.lock[k] = inst; T += ACT.T.put; }
        else if (h) { const s = inScale(id, h.safe); w.sc.push([t1, s]); w.vis[w.vis.length - 1][1] = t1; sc.inside.push({ id, k: into, inst, on: t1, off: null, x: to.x, y: to.y, s }); T += keep ? ACT.T.copy : ACT.T.putIn; }
        else if (slot) { const inside = (R.inside[id] || []).filter((v) => v.off == null).map((v) => v.id);   // FR138: it lies on the screen from now on
          w.sc.push([t1, slot.s]); w.vis[w.vis.length - 1][1] = t1; stored.push({ id, at: into, x: to.x, y: to.y, s: slot.s, inside, on: t1, off: null });
          shown.push({ id, at: into, x: to.x, y: to.y, s: slot.s, inside }); T += keep ? ACT.T.copy : ACT.T.putIn; }
        else { w.sc.push([t1, 0.3]); w.vis[w.vis.length - 1][1] = t1; T += keep ? ACT.T.copy : ACT.T.putIn; }   // FR130: into a box — it goes in and is kept there
      } else if (sc && (a.open != null || a.close != null) && ["A", "B"].includes(a.open != null ? a.open : a.close)) {   // the door swings open / shut; a key in its lock goes with it
        const k = a.open != null ? a.open : a.close, q = sc.g[k], opening = a.open != null, d = opening ? ACT.T.open : ACT.T.close;
        sc.doors[k].push([T, opening ? 1 : SCENE.OPEN], [T + d, opening ? SCENE.OPEN : 1]);
        if (sc.lock[k]) wMove(sc.lock[k], T, T + d, [opening ? q.open : q.lock]);
        T += d;
      } else if ((a.open != null || a.close != null) && (ACT_ITEMS[a.open != null ? a.open : a.close] || {}).vault
                 && (R.items[a.open != null ? a.open : a.close] || []).some((v) => v[1] == null)) {   // FR135: the door of the vault it holds swings open / shut
        const id = a.open != null ? a.open : a.close, opening = a.open != null, d = opening ? ACT.T.open : ACT.T.close, l = R.doors[id] = R.doors[id] || [];
        l.push([T, opening ? 1 : SCENE.OPEN], [T + d, opening ? SCENE.OPEN : 1]); T += d;
      } else if (sc && a.fire) { const v = kvAt(sc.fire, T); sc.fire = sc.fire.filter((k) => k[0] <= T);   // a fire starts in the bowl (FR139: one still burning goes on)
        sc.fire.push([T, v], [T + ACT.T.fire, 1]); T += ACT.T.fire;
      } else if (a.take != null && ACT_ITEMS[a.take] && R.spot && (ACT_ITEMS[String(a.from || "")] || {}).vault) {   // FR138: out of the vault it holds (over the runner)
        const box = String(a.from), v = (R.inside[box] || []).find((x) => x.id === a.take && x.off == null); if (!v) continue;
        const h = hand(R, box), inst = newInst(a.take), w = track(inst), t1 = T + ACT.T.take; v.off = T; w.over = true;
        wMove(inst, T, T, [{ x: h.x + VAULT.IN.x, y: h.y + VAULT.IN.y }]); wMove(inst, T, t1, [hand(R, a.take)]); w.vis.push([T, t1]); w.sc.push([T, VAULT.IN.s], [t1, 1]);
        carry(R, a.take, t1); R.inst[a.take] = inst; T = t1;
      } else if (a.take != null && ACT_ITEMS[a.take] && R.spot) {   // out of a keyhole ("A.lock"), out of a safe or off a shelf board ("A", "S.top")
        const id = a.take, from = String(a.from || ""), [k, part] = from.split(".");
        if (part === "lock" && sc && (k === "A" || k === "B")) { const inst = sc.lock[k]; if (!inst) continue;
          const w = track(inst), t1 = T + ACT.T.unlock; turn(R, T, sc.g[k].lock.x - R.spot.x);
          wMove(inst, T, t1, [hand(R, id)]); w.sc.push([T, 0.8], [t1, 1]); w.rot.push([T, 90], [t1, 0]); if (w.vis.length) w.vis[w.vis.length - 1][1] = t1;
          carry(R, id, t1); R.inst[id] = inst; sc.lock[k] = null; T = t1;
        } else { const v = sc && sc.inside.find((x) => x.id === id && x.k === from && x.off == null); if (!v) continue;
          const inst = v.inst || newInst(id), w = track(inst), t1 = T + ACT.T.take; v.off = T; turn(R, T, v.x - R.spot.x);
          wMove(inst, T, T, [{ x: v.x, y: v.y }]); wMove(inst, T, t1, [hand(R, id)]); w.vis.push([T, t1]); w.sc.push([T, v.s], [t1, 1]);
          carry(R, id, t1); R.inst[id] = inst; T = t1; }
      } else if (sc && a.throw != null && ACT_ITEMS[a.throw] && R.spot) {   // tossed into the fire: it shrinks away, the fire flares, then burns down
        const id = a.throw, inst = instOf(R, id), w = track(inst), from = hand(R, id), to = { x: sc.g.fire.x, y: sc.g.fire.y - 12 }, t1 = T + 0.8, arc = [];
        delete R.inst[id]; turn(R, T, to.x - R.spot.x); drop(R, id, T); wMove(inst, T, T, [from]); w.vis.push([T, T + ACT.T.throw]); w.sc.push([T, 1], [t1, 1], [T + ACT.T.throw, 0.3]);
        for (let j = 1; j <= 8; j++) { const u = j / 8; arc.push({ x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u - 160 * u * (1 - u) }); }
        wMove(inst, T, t1, arc);
        sc.fire = sc.fire.filter((k) => k[0] <= t1); sc.fire.push([t1, 1], [t1 + 0.15, 1.5], [t1 + 0.5, 1], [t1 + 1.5, 1], [t1 + 2.5, 0]);   // (FR139: a second throw flares it again)
        T += ACT.T.throw;
      } else if (a.copy != null && ACT_ITEMS[a.copy] && ACT_ITEMS[String(a.in || "")] && R.spot) {   // FR130: a copy comes out of a box into what the runner holds (the vault)
        const b = boxAt(String(a.from || "")); if (!b) continue;
        const inst = newInst(a.copy), w = track(inst), from = middle(b), into = String(a.in), t1 = T + 0.8, h = hand(R, into);
        turn(R, T, from.x - R.spot.x); wMove(inst, T, T, [from]);
        if (ACT_ITEMS[into].vault) {   // FR135: into the (open) vault — over the runner, it lands inside and lies there
          wMove(inst, T + 0.2, t1, [{ x: h.x + VAULT.IN.x, y: h.y + VAULT.IN.y }]); w.vis.push([T, t1]); w.sc.push([T, 0.6], [T + 0.2, 1], [t1, VAULT.IN.s]); w.over = true;
          (R.inside[into] = R.inside[into] || []).push({ id: a.copy, on: t1 });
        } else { wMove(inst, T + 0.2, t1, [h]); w.vis.push([T, t1 + 0.2]); w.sc.push([T, 0.6], [T + 0.2, 1], [t1, 1], [t1 + 0.2, 0.3]); }
        T += ACT.T.copy;
      } else if (a.write != null && R.spot) { const b = boxAt(String(a.write)); if (!b) continue;   // FR129: the book opens, what the runner brings goes in, the entry is written
        writes.push({ book: String(a.write), t: T + 0.2 });
        for (const id of Object.keys(R.items)) if (ACT_ITEMS[id].text && R.items[id].some((v) => v[1] == null)) {
          const inst = instOf(R, id), w = track(inst); delete R.inst[id]; drop(R, id, T + 3.4);
          wMove(inst, T + 3.4, T + 3.4, [hand(R, id)]); wMove(inst, T + 3.4, T + 3.9, [middle(b)]); w.vis.push([T + 3.4, T + 3.9]); w.sc.push([T + 3.4, 1], [T + 3.9, 0.3]); }
        T += ACT.T.write;
      } else if (a.lookup != null && R.spot) { const b = boxAt(String(a.lookup)); if (!b) continue;   // FR136: the book opens; the name it brings goes in, the address on that line comes out into its hand
        const n = node(String(a.lookup)), lines = n ? entryOf(n).split("\n") : [], ip = (lines.slice(1).join(" ").match(IP_RE) || ["?"])[0];
        const aid = a.as != null && (ACT_ITEMS[a.as] || {}).book ? String(a.as) : "answer";   // FR149: `as` = another card (answer4: the IPv4 address, its text from the step's texts)
        const t0 = T + 0.2, c = middle(b); reads.push({ book: String(a.lookup), t: t0 }); if (aid === "answer") texts.answer = ipTag(ip); turn(R, T, c.x - R.spot.x);
        for (const id of Object.keys(R.items)) if (ACT_ITEMS[id].text && R.items[id].some((v) => v[1] == null)) {   // (once the book is open at the entry)
          const inst = instOf(R, id), w = track(inst); delete R.inst[id]; drop(R, id, t0 + 3.0);
          wMove(inst, t0 + 3.0, t0 + 3.0, [hand(R, id)]); wMove(inst, t0 + 3.0, t0 + 3.5, [c]); w.vis.push([t0 + 3.0, t0 + 3.5]); w.sc.push([t0 + 3.0, 1], [t0 + 3.5, 0.3]); }
        const inst = newInst(aid), w = track(inst), u0 = t0 + 0.48 * PB.T, u1 = u0 + 0.5;   // (when the book lets the address go, FR121)
        wMove(inst, u0, u0, [c]); wMove(inst, u0, u1, [hand(R, aid)]); w.vis.push([u0, u1]); w.sc.push([u0, 0.3], [u1, 1]);
        carry(R, aid, u1); R.inst[aid] = inst; T = u1 + 0.1;
      } else if (a.give != null && ACT_ITEMS[a.give] && R.spot) {   // FR136: hand to hand, to another runner
        const O = ACTS[a.to], id = a.give; if (!O || !O.spot || O === R || !(R.items[id] && R.items[id].some((v) => v[1] == null))) continue;
        const keep = a.copy === true, inst = keep ? newInst(id) : instOf(R, id), w = track(inst), t1 = T + ACT.T.hand;   // FR149: {"copy": true} — a copy goes over, the runner keeps its own
        if (!keep) { delete R.inst[id]; drop(R, id, T); } turn(R, T, O.spot.x - R.spot.x); turn(O, T, R.spot.x - O.spot.x);
        wMove(inst, T, T, [hand(R, id)]); wMove(inst, T, t1, [hand(O, id)]); w.vis.push([T, t1]); w.sc.push([T, 1]);
        carry(O, id, t1); O.inst[id] = inst; T = t1;
      } else if (a.show != null && ACT_ITEMS[a.show] && R.spot) { const b = boxAt(String(a.at || "")); if (!b) continue;   // FR136: on a box, for all to see (the call on the server, then on the phone)
        const id = a.show, to = middle(b), held = !!(R.items[id] && R.items[id].some((v) => v[1] == null)), inst = held ? instOf(R, id) : newInst(id), w = track(inst), s = 1.3;
        if (held) { delete R.inst[id]; turn(R, T, to.x - R.spot.x); drop(R, id, T); wMove(inst, T, T, [hand(R, id)]); wMove(inst, T, T + ACT.T.show, [to]); w.sc.push([T, 1], [T + ACT.T.show, s]); }
        else { wMove(inst, T, T, [to]); w.sc.push([T, 0.3], [T + ACT.T.show, s]); }
        w.vis.push([T, null]); shown.push({ id, at: String(a.at), x: to.x, y: to.y, s }); T += ACT.T.show + 0.2;
      } else if (a.burn != null) { if (!boxAt(String(a.burn))) continue;   // FR140: a box burns down — flames over it, and it is gone
        burns.push({ at: String(a.burn), t0: T, t1: T + ACT.T.burn }); T += ACT.T.burn;
      } else if (a.update != null) { if (!boxAt(String(a.update))) continue;   // FR141: the box at the far end of the book's update line sends its address by itself: the light rides in and the entry is written (nobody carries it)
        writes.push({ book: String(a.update), t: T + 0.2, light: true }); T += ACT.T.update;
      } else if (a.bounce != null && R.pts.length) {   // FR147: it tries a line and is bounced back near its start: `at` px in, a forbidden sign lands on the line, the line's
        // label lights up and a red sign (`say`) shows for `dur` s; it springs back to the line's start (still facing in) and waits there till the sign goes
        const e = edgeOf(String(a.bounce)), p0 = e && epoly[e.id]; if (!p0 || p0.length < 2) continue;
        const p = a.back ? p0.slice().reverse() : p0, pre = polyUpTo(p, Math.min(polyLen(p), typeof a.at === "number" ? a.at : 40)), hit = pre[pre.length - 1];
        const q = R.pts[R.pts.length - 1], seq = Math.hypot(p[0].x - q.x, p[0].y - q.y) > 0.5 ? [q, ...pre] : pre;
        const go = (path, dur, face) => { const L = polyLen(path); R.kf.push([T, R.dist]); R.pts.push(...path.slice(1));
          if (face) for (let j = 1, c = 0; j < path.length; j++) { turn(R, T + (L ? c / L : 0) * dur, path[j].x - path[j - 1].x); c += Math.hypot(path[j].x - path[j - 1].x, path[j].y - path[j - 1].y); }
          R.runs.push([T, T + dur]); T += dur; R.dist += L; R.kf.push([T, R.dist]); R.spot = path[path.length - 1]; };
        go(seq, Math.max(ACT.WALK, r1(polyLen(seq) / ACT.V)), true);
        const th = T, d = typeof a.dur === "number" ? a.dur : ACT.T.bounce;
        bounces.push({ edge: e.id, x: hit.x, y: hit.y, r: (e.pw || 22) * 0.8, say: String(a.say || ""), t0: th, t1: th + d });
        go(pre.slice().reverse(), 0.5, false); R.at = a.back ? e.to : e.from; T = Math.max(T, th + d);
      } else if ((a.open === "firewall" || a.close === "firewall" || a.open === "port" || a.close === "port") && a.of != null) {   // FR141: a gate of a gatehouse router worked by hand: it slides open (or shut) and stays so, into the next steps
        const house = String(a.of), gate = a.open != null ? a.open : a.close, hg = GT[house] = GT[house] || {}, kv = hg[gate] = hg[gate] || [];
        kv.push([T, kvAt(kv, T)], [T + ACT.T.gate, a.open != null ? 1 : 0]); T += ACT.T.gate;
      } else if (typeof a.wait === "number") T += Math.max(0, a.wait);
    }
    const all = ACTORS.map((who) => ACTS[who]).filter((R) => R && R.pts.length);
    if (!all.length && !sc && !stored.length && !burns.length && !Object.keys(GT).length && !Object.keys(texts).length) return null;   // no runner, no scene, nothing stored on a screen, no gate and no texts in this step (FR145: texts are handed on even where no runner moves, e.g. a wifi view's first step)
    if (typeof step.dur === "number") T = Math.max(T, step.dur); else if (!(step.play || []).length) T = Math.max(T, ACT.STAND);   // standing time
    for (const R of all) R.kf.push([T, R.dist]);
    if (last) { for (const R of all) if (!R.gone) R.op.push([T, 1], [T + ACT.FADE, 0]); T += ACT.FADE; for (const R of all) R.kf.push([T, R.dist]); }
    const out = { T, W, scene: sc, writes, reads, texts, last, stored, burns, bounces, gates: GT, end: { actors: {}, scene: null, texts, stored: stored.filter((v) => v.off == null).map((v) => ({ id: v.id, at: v.at, x: v.x, y: v.y, s: v.s, inside: v.inside })),
      gates: Object.fromEntries(Object.entries(GT).map(([h, hg]) => [h, Object.fromEntries(Object.entries(hg).map(([gn, kv]) => [gn, kvAt(kv, T)]))])) },   // FR141: how the gates are left
      actors: all.map((R) => ({ who: R.who, pts: R.pts, L: polyLen(R.pts), kf: R.kf, runs: R.runs, acts: R.acts, pops: R.pops, items: R.items, doors: R.doors, inside: R.inside, face: R.face, op: R.op })) };
    for (const R of all) if (!R.gone) out.end.actors[R.who] = { spot: R.spot, at: R.at, face: R.facing, items: Object.keys(R.items).filter((id) => R.items[id].some((v) => v[1] == null)) };
    if (sc && sc.t1 == null) out.end.scene = { O: sc.g.O, inside: sc.inside.filter((v) => v.off == null).map((v) => ({ id: v.id, k: v.k, x: v.x, y: v.y, s: v.s })) };
    return out;
  }
  function drawActor(P, boxOf) {   // the plan, drawn: every animation runs once from the step's start (S.stepT0) and freezes at its end
    const G = el("g", { class: "actor", "pointer-events": "none", "font-family": "ui-sans-serif, system-ui, sans-serif" }, gNodes);   // (the diagram's font, as in the SVG)
    const f = (v) => +v.toFixed(4), tk = (t) => f(Math.max(0, Math.min(1, t / P.T)));
    const anim = (p, a) => el(a.path ? "animateMotion" : a.type ? "animateTransform" : "animate", { dur: f(P.T) + "s", repeatCount: "1", fill: "freeze", begin: f(S.stepT0) + "s", ...a }, p);
    const tail = P.last ? P.T - ACT.FADE : null;   // a thing still held at the end goes with the fade-out — or stays, for the next step
    const fadeIv = (p, ivs0) => {   // opacity 1 during each [on, off] (off null = held to the end), 0.05 s ramps; a constant needs no animation
      const ivs = ivs0.map(([on, off]) => [on, off == null ? tail : off]).filter(([on, off]) => off == null || off - on >= 0.12);   // (a moment's flash is left out)
      const kv = [[0, ivs.some(([on]) => on <= 0) ? 1 : 0]]; let open = false;
      for (const [on, off] of ivs) {
        if (off == null) { if (on > 0) kv.push([on, 0], [on + 0.05, 1]); open = true; continue; }
        if (on > 0) kv.push([on, 0], [on + 0.05, 1]); kv.push([off - 0.05, 1], [off, 0]); }
      kv.push([P.T, open ? 1 : 0]);
      const ks = kv.filter((v, i) => !i || v[0] >= kv[i - 1][0]);   // key times never go back
      if (ks.every((v) => v[1] === ks[0][1])) { p.setAttribute("opacity", ks[0][1]); return; }
      anim(p, { attributeName: "opacity", values: ks.map((v) => v[1]).join(";"), keyTimes: ks.map((v) => tk(v[0])).join(";") }); };
    const keyed = (kv0) => {   // [time, value] key frames over the whole plan (held before the first and after the last)
      const kv = kv0.length && kv0[0][0] > 0 ? [[0, kv0[0][1]], ...kv0] : kv0.slice();
      if (kv.length && kv[kv.length - 1][0] < P.T) kv.push([P.T, kv[kv.length - 1][1]]);
      return kv.filter((v, i) => !i || v[0] >= kv[i - 1][0]); };
    const varies = (kv) => kv.some((v) => v[1] !== kv[0][1]);
    const flips = (kv0) => { const kv = kv0.filter((v, i) => !(i + 1 < kv0.length && kv0[i + 1][0] === v[0]));   // FR151: on / off key frames — the last of a moment's, each change once
      return kv.filter((v, i) => !i || v[1] !== kv[i - 1][1]); };
    const look = (p, id, x, y, s, plain, box) => {   // a thing's look at (x, y), scaled: its icon (+ tag, unless plain), the vault (box: its door + inside), or its text
      const it = ACT_ITEMS[id], g = el("g", { transform: `translate(${f(x)} ${f(y)})` + (s !== 1 ? ` scale(${f(s)})` : ""), opacity: 0 }, p);
      if (it.icon) { const u = el("use", { href: "#ic-" + it.icon, x: -9, y: -9, width: 18, height: 18 }, g); u.style.color = it.color; }
      else if (it.light) { el("circle", { r: 9, fill: it.color, opacity: 0.35 }, g); el("circle", { r: 4.5, fill: "#fffbe0" }, g); }
      else if (it.vault) {   // FR135: a small safe — its inside, what lies in it, and its door (hinged left) with the KeePass logo as the lock
        const V = VAULT, iw = V.w - 2 * V.inset, ih = V.h - 2 * V.inset, lx = iw - V.lock - 2, ly = (ih - V.lock) / 2;
        el("rect", { x: -V.w / 2, y: -V.h / 2, width: V.w, height: V.h, rx: 3, fill: "#2d333b", stroke: it.color, "stroke-width": 1.5 }, g);
        el("rect", { x: -iw / 2, y: -ih / 2, width: iw, height: ih, fill: "#0b0e14" }, g);
        for (const v of (box && box.inside) || []) fadeIv(look(g, v.id, V.IN.x, V.IN.y, V.IN.s, true), [[v.on, v.off == null ? null : v.off]]);
        const D = el("g", {}, el("g", { transform: `translate(${-iw / 2} ${-ih / 2})` }, g));
        el("rect", { x: 0, y: 0, width: iw, height: ih, fill: "#3d444d", stroke: "#c9d1d9", "stroke-width": 1 }, D);
        const src = imgSrc("img:" + it.vault);
        if (src) el("image", { href: src, x: lx, y: ly, width: V.lock, height: V.lock }, D); else el("circle", { cx: lx + V.lock / 2, cy: ly + V.lock / 2, r: 3, fill: "#facc15" }, D);
        const dk = box && box.door ? keyed(box.door) : [];
        if (varies(dk)) anim(D, { attributeName: "transform", type: "scale", values: dk.map((v) => `${f(v[1])} 1`).join(";"), keyTimes: dk.map((v) => tk(v[0])).join(";") }); }
      else if (it.img) {   // FR136: a logo on a blue badge (Jitsi Meet)
        el("rect", { x: -9, y: -9, width: 18, height: 18, rx: 4, fill: "#1d76ba", stroke: "#c9d1d9", "stroke-width": 1 }, g);
        const src = imgSrc("img:" + it.img); if (src) el("image", { href: src, x: -7, y: -7, width: 14, height: 14 }, g); }
      const ov = P.texts && P.texts[id] != null ? P.texts[id] : null;   // FR141: a step's own text for a thing (FR145: a tag, like a text, only where the tag would show)
      const label = it.text || it.book ? (ov != null ? ov : it.text) : plain ? null : ov != null ? ov : it.tag;   // FR136: a book's address carries the text the book gave
      if (label) { const t = el("text", { x: 0, y: it.text || it.book ? 3.5 : -12, "text-anchor": "middle", fill: it.color }, g), ls = label.split("\n");
        Object.assign(t.style, { fontSize: "10px", paintOrder: "stroke", stroke: "#0b0e14", strokeWidth: "3px" });
        if (ls.length === 1) t.textContent = label;   // FR132: more lines stack upwards, the last one where a single line would be
        else ls.forEach((l, i) => { el("tspan", { x: 0, y: 3.5 - (ls.length - 1 - i) * 11 }, t).textContent = l; }); }
      return g; };
    let nBuild = 0;
    for (const A of P.actors) for (const a of A.acts) {   // world-fixed things first (under the runners): the build cover
      if (a.kind === "hammer") { const n = a.at && node(a.at), b = n && boxOf[a.at] && anchorBox(n, boxOf[a.at]); if (!b) continue;
        // FR131: the box is built up out of the light in its middle — a hole in the cover opens there, a ring wider with every blow
        const x = b.x - 2, y = b.y - 2, w = b.w + 4, h = b.h + 4, c = a.c || { x: b.x + b.w / 2, y: b.y + b.h / 2 }, nb = a.blows.length;
        const Rm = Math.max(...[[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => Math.hypot(px - c.x, py - c.y))) + 1, id = "actbuild" + nBuild++;
        const M = el("mask", { id, maskUnits: "userSpaceOnUse", x: f(x), y: f(y), width: f(w), height: f(h) }, G);
        el("rect", { x: f(x), y: f(y), width: f(w), height: f(h), fill: "#fff" }, M);
        const hole = el("circle", { cx: f(c.x), cy: f(c.y), r: 0, fill: "#000" }, M), rk = [[0, 0], [a.t0, 0]];
        if (nb) a.blows.forEach((t, i) => rk.push([t, f(Rm * i / nb)], [t + 0.12, f(Rm * (i + 1) / nb)])); else rk.push([Math.max(a.t0, a.t1 - 0.3), f(Rm)]);
        const rv = keyed(rk);
        anim(hole, { attributeName: "r", values: rv.map((v) => v[1]).join(";"), keyTimes: rv.map((v) => tk(v[0])).join(";") });
        el("rect", { x: f(x), y: f(y), width: f(w), height: f(h), fill: (S.data.meta && S.data.meta.background) || "#0b0e14", mask: `url(#${id})` }, G);
      }
    }
    for (const bn of P.burns || []) { const n = node(bn.at), b = n && boxOf[bn.at] && anchorBox(n, boxOf[bn.at]); if (!b) continue;   // FR140: flames over the box, which goes
      const c = el("rect", { x: f(b.x - 2), y: f(b.y - 2), width: f(b.w + 4), height: f(b.h + 4), fill: (S.data.meta && S.data.meta.background) || "#0b0e14", opacity: 0 }, G);
      const ck = keyed([[0, 0], [bn.t0 + 1.0, 0], [bn.t0 + 2.2, 1]]);
      anim(c, { attributeName: "opacity", values: ck.map((v) => v[1]).join(";"), keyTimes: ck.map((v) => tk(v[0])).join(";") });
      const FS = el("g", { transform: "scale(0)" }, el("g", { transform: `translate(${f(b.x + b.w / 2)} ${f(b.y + b.h)})` }, G));
      const fk = keyed([[0, 0], [bn.t0, 0], [bn.t0 + 0.6, 1], [bn.t0 + 1.4, 1.2], [bn.t1 - 0.8, 1], [bn.t1, 0]]), fs = b.h * 0.85 / 12;
      anim(FS, { attributeName: "transform", type: "scale", values: fk.map((v) => `${f(v[1])} ${f(v[1])}`).join(";"), keyTimes: fk.map((v) => tk(v[0])).join(";") });
      for (const [dx, k, ph] of BURN_FLAMES) flame(FS, f(dx * b.w), 0, f(fs * k), ph);
    }
    for (const bn of P.bounces || []) {   // FR147: a runner bounced off a line — the forbidden sign pops onto the line and stays; the line's label is lit up and the reason
      // shows under the sign while the runner is turned away
      const SB = el("g", { transform: "scale(0)" }, el("g", { transform: `translate(${f(bn.x)} ${f(bn.y)})` }, G)), sk = keyed([[0, 0], [bn.t0, 0], [bn.t0 + 0.15, 1.25], [bn.t0 + 0.3, 1]]);
      anim(SB, { attributeName: "transform", type: "scale", values: sk.map((v) => `${f(v[1])} ${f(v[1])}`).join(";"), keyTimes: sk.map((v) => tk(v[0])).join(";") });
      el("circle", { r: f(bn.r * 0.8), fill: "#0b0e14" }, SB);
      el("use", { href: "#ic-block", x: f(-bn.r), y: f(-bn.r), width: f(2 * bn.r), height: f(2 * bn.r) }, SB);
      const lb = LABELS[bn.edge];
      if (lb) { const w = lb.text.length * 6.6 + 12, x0 = lb.anchor === "middle" ? lb.x - w / 2 : lb.anchor === "end" ? lb.x - w + 6 : lb.x - 6, HG = el("g", { opacity: 0 }, G);
        el("rect", { x: f(x0), y: f(lb.y - 13), width: f(w), height: 18, rx: 4, fill: "#2a0f12", stroke: "#ff5c5c", "stroke-width": 1.5 }, HG);
        const t = el("text", { x: f(lb.x), y: f(lb.y), "text-anchor": lb.anchor, fill: "#ffb3b3" }, HG); Object.assign(t.style, { fontSize: "12px", fontWeight: "700" }); t.textContent = lb.text;
        fadeIv(HG, [[bn.t0, bn.t1]]); }
      if (bn.say) { const t = el("text", { x: f(bn.x + bn.r), y: f(bn.y + bn.r + 14), "text-anchor": "end", fill: "#ff5c5c", opacity: 0 }, G);   // (under the sign, ending at its right edge: clear of the box beyond)
        Object.assign(t.style, { fontSize: "12px", fontWeight: "700", paintOrder: "stroke", stroke: "#0b0e14", strokeWidth: "3px" }); t.textContent = bn.say; fadeIv(t, [[bn.t0, bn.t1]]); }
    }
    for (const v of P.stored || []) fadeIv(look(G, v.id, v.x, v.y, v.s, true), [[v.on, v.off]]);   // FR138: what lies on a screen
    const sc = P.scene;
    if (sc) {   // FR128 / FR129: the ledge, the safes, the fire bowl and the shelf — they fade in when the scene starts and out when it ends
      const g = sc.g, s = SCENE.safe, SG = el("g", { opacity: 0 }, G);
      const so0 = [...(sc.fadeIn ? [[0, 0], [sc.t0, 0], [sc.t0 + 0.4, 1]] : [[0, 1]]), ...(sc.t1 != null ? [[sc.t1 - 0.6, 1], [sc.t1, 0]] : [])];
      const so = keyed(so0);
      if (varies(so)) anim(SG, { attributeName: "opacity", values: so.map((v) => v[1]).join(";"), keyTimes: so.map((v) => tk(v[0])).join(";") });
      else SG.setAttribute("opacity", so.length ? so[0][1] : 1);
      el("rect", { x: f(g.x0), y: f(g.top), width: f(g.x1 - g.x0), height: SCENE.h, fill: "#9a5523", stroke: "#5c2f0d", "stroke-width": 1.5 }, SG);   // the ledge (bricks)
      for (let x = g.x0 + 16; x < g.x1 - 4; x += 16) el("line", { x1: f(x), y1: f(g.top), x2: f(x), y2: f(g.top + SCENE.h), stroke: "#5c2f0d", "stroke-width": 1.5 }, SG);
      for (const k of ["A", "B"]) { const q = g[k], dh = s.h - 2 * s.inset, x0 = SCENE[k].hinge === "l" ? 0 : -q.dw, kx = x0 + q.dw / 2, ky = s.lock - s.inset;
        el("rect", { x: f(q.x), y: f(q.y), width: s.w, height: s.h, rx: 4, fill: "#2d333b", stroke: "#c9d1d9", "stroke-width": 1.5 }, SG);
        el("rect", { x: f(q.x + s.inset), y: f(q.y + s.inset), width: q.dw, height: dh, fill: "#0b0e14" }, SG);   // inside
        for (const v of sc.inside) if (v.k === k) fadeIv(look(SG, v.id, v.x, v.y, v.s, true), [[v.on, v.off]]);
        const D = el("g", {}, el("g", { transform: `translate(${f(q.hx)} ${f(q.y + s.inset)})` }, SG));   // the door, turning on its hinge
        el("rect", { x: x0, y: 0, width: q.dw, height: dh, fill: "#3d444d", stroke: "#c9d1d9", "stroke-width": 1 }, D);
        el("circle", { cx: f(kx), cy: f(ky), r: 3.4, fill: "#facc15" }, D);   // the keyhole (yellow, like the logo's)
        el("path", { d: `M ${f(kx - 1.8)} ${f(ky + 1)} L ${f(kx + 1.8)} ${f(ky + 1)} L ${f(kx + 3)} ${f(ky + 9)} L ${f(kx - 3)} ${f(ky + 9)} Z`, fill: "#facc15" }, D);
        const dk = keyed(sc.doors[k]);
        if (varies(dk)) anim(D, { attributeName: "transform", type: "scale", values: dk.map((v) => `${f(v[1])} 1`).join(";"), keyTimes: dk.map((v) => tk(v[0])).join(";") });
      }
      const SH = g.S;   // FR129: the shelf — a frame with its boards (FR132: two), and what stands on them
      el("rect", { x: f(SH.x), y: f(SH.y), width: SH.w, height: SH.h, fill: "#2b1d12", stroke: "#8b5a2b", "stroke-width": 1.5 }, SG);
      for (let i = 1; i <= SCENE.S.rows.length; i++) el("line", { x1: f(SH.x), y1: f(SH.y + SH.rh * i), x2: f(SH.x + SH.w), y2: f(SH.y + SH.rh * i), stroke: "#8b5a2b", "stroke-width": 2.5 }, SG);
      for (const v of sc.inside) if (v.k.startsWith("S.")) fadeIv(look(SG, v.id, v.x, v.y, v.s, true), [[v.on, v.off]]);
      const FG = el("g", { transform: `translate(${f(g.fire.x)} ${f(g.fire.y)})` }, SG);   // the fire bowl; the fire starts, flares, burns down
      el("path", { d: "M -13 -9 L 13 -9 L 9 0 L -9 0 Z", fill: "#6e7681", stroke: "#2d333b", "stroke-width": 1.2 }, FG);
      const FS = el("g", {}, el("g", { transform: "translate(0 -9)" }, FG)), fk = keyed(sc.fire);
      if (varies(fk)) anim(FS, { attributeName: "transform", type: "scale", values: fk.map((v) => `${f(v[1])} ${f(v[1])}`).join(";"), keyTimes: fk.map((v) => tk(v[0])).join(";") });
      else FS.setAttribute("transform", `scale(${fk.length ? f(fk[0][1]) : 0})`);
      flame(FS, -6, 0, 1.2, 0); flame(FS, 0, 0, 1.7, 0.3); flame(FS, 6, 0, 1.2, 0.55);
    }
    const drawTrack = (w) => {   // things away from the runners — into a keyhole, a safe, a shelf, the fire or a box, and back
      const WG = el("g", { opacity: 0 }, G), kk = keyed(w.kf);
      if (w.d > 0) anim(WG, { path: "M " + w.pts.map((q) => `${f(q.x)} ${f(q.y)}`).join(" L "), keyPoints: kk.map((v) => f(Math.min(1, v[1] / w.d))).join(";"), keyTimes: kk.map((v) => tk(v[0])).join(";"), calcMode: "linear" });
      else WG.setAttribute("transform", `translate(${f(w.pts[0].x)} ${f(w.pts[0].y)})`);
      fadeIv(WG, w.vis);
      const IG = el("g", {}, WG), sk = keyed(w.sc), rk = keyed(w.rot);   // it shrinks into a keyhole / safe / box and turns in a lock
      if (varies(sk)) anim(IG, { attributeName: "transform", type: "scale", values: sk.map((v) => `${f(v[1])} ${f(v[1])}`).join(";"), keyTimes: sk.map((v) => tk(v[0])).join(";") });
      const RG = el("g", {}, IG);
      if (varies(rk)) anim(RG, { attributeName: "transform", type: "rotate", values: rk.map((v) => f(v[1])).join(";"), keyTimes: rk.map((v) => tk(v[0])).join(";") });
      look(RG, w.id, 0, 0, 1, true).setAttribute("opacity", 1);
    };
    for (const inst in P.W) if (!P.W[inst].over) drawTrack(P.W[inst]);   // (FR135: what lands in a vault a runner holds goes over the runner)
    for (const A of P.actors) {   // the runners: along their paths, or standing where the step before left them
      const R = el("g", { opacity: 0 }, G);
      if (A.pts.length >= 2) anim(R, { path: "M " + A.pts.map((q) => `${f(q.x)} ${f(q.y)}`).join(" L "), keyPoints: A.kf.map((k) => f(Math.min(1, k[1] / A.L))).join(";"), keyTimes: A.kf.map((k) => tk(k[0])).join(";"), calcMode: "linear" });
      else R.setAttribute("transform", `translate(${f(A.pts[0].x)} ${f(A.pts[0].y)})`);
      const ro = keyed(A.op);   // it fades in / out where it appears and vanishes, and at the story's ends
      if (varies(ro)) anim(R, { attributeName: "opacity", values: ro.map((v) => v[1]).join(";"), keyTimes: ro.map((v) => tk(v[0])).join(";") });
      else R.setAttribute("opacity", ro.length ? ro[0][1] : 1);
      const hop = [[0, 0]];   // hops while running: up 4 every half hop
      for (const [t0, t1] of A.runs) { hop.push([t0, 0]); for (let k = 1, t = t0 + ACT.HOP / 2; t < t1 - 0.05; k++, t = t0 + k * ACT.HOP / 2) hop.push([t, k % 2 ? -4 : 0]); hop.push([t1, 0]); }
      hop.push([P.T, 0]);
      const H = el("g", {}, R);
      if (A.runs.length) anim(H, { attributeName: "transform", type: "translate", values: hop.map((h) => `0 ${h[1]}`).join(";"), keyTimes: hop.map((h) => tk(h[0])).join(";") });
      const FL = el("g", {}, H), fv = keyed(A.face);   // the sprite faces where it goes (what it holds doesn't turn)
      if (varies(fv)) anim(FL, { attributeName: "transform", type: "scale", values: fv.map((v) => `${v[1]} 1`).join(";"), keyTimes: fv.map((v) => tk(v[0])).join(";"), calcMode: "discrete" });
      else if (fv.length && fv[0][1] === -1) FL.setAttribute("transform", "scale(-1 1)");
      const sp = { x: -ACT.SIZE / 2, y: -ACT.SIZE, width: ACT.SIZE, height: ACT.SIZE };
      if (!WALKERS.includes(A.who) || !A.runs.length) el("use", { href: "#ic-" + A.who, ...sp }, FL);
      else {   // FR151: it walks — a step at every low of its hop (frame 1, then frame 2), upright in between (frame 0, standing)
        const wk = [[0, 0]];
        for (const [t0, t1] of A.runs) { wk.push([t0, 1]);
          for (let k = 0, t = t0 + ACT.HOP / 4; t < t1 - 0.05; k++, t = t0 + ACT.HOP / 4 + k * ACT.HOP / 2) wk.push([t, [0, 2, 0, 1][k % 4]]);
          wk.push([t1, 0]); }
        const kv = keyed(wk);
        ["", "-w1", "-w2"].forEach((sfx, i) => { const u = el("use", { href: "#ic-" + A.who + sfx, ...sp, opacity: i ? 0 : 1 }, FL);
          const ks = flips(kv.map(([t, v]) => [t, v === i ? 1 : 0]));
          if (varies(ks)) anim(u, { attributeName: "opacity", values: ks.map((v) => v[1]).join(";"), keyTimes: ks.map((v) => tk(v[0])).join(";"), calcMode: "discrete" }); });
      }
      for (const id in A.items) fadeIv(look(H, id, ACT_ITEMS[id].dx, ACT_ITEMS[id].dy, 1, false, { door: A.doors && A.doors[id], inside: A.inside && A.inside[id] }), A.items[id]);
      for (const [text, t0, t1, col] of A.pops) { const t = el("text", { x: 0, y: -46, "text-anchor": "middle", fill: col || "#3fb950", opacity: 0 }, H);   // FR141: a sign may be red (bad)
        Object.assign(t.style, { fontSize: "12px", fontWeight: "700", paintOrder: "stroke", stroke: "#0b0e14", strokeWidth: "3px" }); t.textContent = text; fadeIv(t, [[t0, t1]]); }
      for (const a of A.acts) if (a.kind === "hammer") {   // FR131: a real hammer in its right hand (it turns with the sprite): down fast, up slowly, a blow every BLOW s
        const hg = el("g", { transform: "translate(9 -16)", opacity: 0 }, FL); fadeIv(hg, [[a.t0, a.t1]]);
        el("use", { href: "#ic-claw-hammer", x: -11, y: -18.33, width: 22, height: 22 }, hg);
        el("animateTransform", { attributeName: "transform", type: "rotate", additive: "sum", values: "-25;70;-25", keyTimes: "0;0.3;1", dur: ACT.BLOW + "s",
          begin: f(S.stepT0 + a.t0) + "s", repeatCount: "indefinite" }, hg);
      }
    }
    for (const inst in P.W) if (P.W[inst].over) drawTrack(P.W[inst]);
    if (sc) for (const [text, x, y, t0, t1] of sc.pops) { const t = el("text", { x: f(x), y: f(y), "text-anchor": "middle", fill: "#3fb950", opacity: 0 }, G);   // a sign above a safe
      Object.assign(t.style, { fontSize: "12px", fontWeight: "700", paintOrder: "stroke", stroke: "#0b0e14", strokeWidth: "3px" }); t.textContent = text; fadeIv(t, [[t0, t1]]); }
  }
  function stepPlans(epoly, boxOf) {   // FR125 / FR129: the plans of steps 0…step, each starting where the one before ended (and every step's length)
    const st = stepsNow(); if (S.step == null || !st[S.step]) return null;
    const boxAt = (id) => { const n = node(id); return n && boxOf[id] ? anchorBox(n, boxOf[id]) : null; };
    const screenAt = (id) => { const n = node(id), b = boxOf[id], q = n && ICON_SCREEN[n.icon]; if (!b || !q || !isPictogram(n)) return null;   // FR138: its screen (the laptop's)
      const g = pictoGeom(b, labelOf(n).split("\n")), k = g.s / 24; return { x: g.x + q[0] * k, y: g.y + q[1] * k, w: q[2] * k, h: q[3] * k }; };
    let P = null, prev = null; const durs = [];
    for (let k = 0; k <= S.step; k++) { P = actorPlan(st[k], epoly, prev, k === 0, k === st.length - 1, boxAt, screenAt); prev = P && P.end;
      durs.push(P ? P.T : (typeof st[k].dur === "number" ? st[k].dur : ACT.STAND)); }
    return { P, durs };
  }
  function drawStep(SP, boxOf) {   // the active step's caption (bottom-right) and its runners
    const cap = $("stepcap"), st = stepsNow(), s = S.step != null && st[S.step];
    $("stepenter").hidden = !!s || !st.length;   // FR137: the whole view of a story offers to tell it step by step
    if (!s) { cap.hidden = true; S.capEdit = null; S.stepDur = 0; return; }
    if (S.capEdit !== s) {   // (left as it is while its text is being edited)
      S.capEdit = null; cap.hidden = false; cap.textContent = "";
      const head = document.createElement("div"); head.className = "sc-head";
      const no = document.createElement("span"); no.textContent = `step ${S.step}`;
      const title = document.createElement("b"); title.textContent = s.title || s.id;
      const btn = (text, tip) => { const b = document.createElement("button"); b.className = "btn"; b.textContent = text; b.title = tip; return b; };
      const n = st.length, ip = (S.step - 1 + n) % n, inx = (S.step + 1) % n, name = (i) => `${i} ${st[i].label || st[i].title || st[i].id}`;
      const prev = btn("⏮", `previous step (${name(ip)})`), next = btn("⏭", `next step (${name(inx)})`);   // FR137: round and round, like playing
      prev.onclick = () => setStep(ip); next.onclick = () => setStep(inx);
      const rw = btn("⏪", "back 2 s — hold: play backwards (4×)"), ff = btn("⏩", "ahead 2 s — hold: fast forward (4×)");   // FR128
      rw.onpointerdown = (ev) => { ev.preventDefault(); seekStart(-1); }; ff.onpointerdown = (ev) => { ev.preventDefault(); seekStart(1); };
      const pl = btn(S.play ? "⏸" : "▶", S.play ? "pause — everything stops where it is" : "play on, the steps one after another"); pl.onclick = togglePlay;   // FR125 / FR128
      const all = btn("✕", "the whole view (no steps)"); all.onclick = () => setStep(null);
      head.append(no, title, prev, rw, pl, ff, next, all); cap.appendChild(head);
      const body = document.createElement("div"); body.className = "sc-body"; body.textContent = s.caption || ""; cap.appendChild(body);
      if (S.backend) { body.classList.add("editable"); body.title = "double-click to edit · Enter keeps it, Esc drops it";   // FR137: the caption is edited in place
        body.ondblclick = (ev) => { ev.stopPropagation(); editCaption(body, s); }; }
      for (const c of cmdsOf(s)) {   // FR152: the step's commands, one monospace line each (written in full, scrolls sideways), with a copy button
        const row = document.createElement("div"); row.className = "sc-cmd";
        const pre = document.createElement("pre"); pre.textContent = c; pre.title = c;
        const cp = btn("⧉", "copy this command"); cp.onclick = async () => { try { await navigator.clipboard.writeText(c); status("command copied"); } catch (_) { status("could not copy — select the line and copy it"); } };
        row.append(pre, cp); cap.appendChild(row); }
      const o = S.backend && selObj();   // editing the story: the selected box or line in this step or not
      if (o) { const inS = (s.show || []).includes(o.id), foot = document.createElement("div"); foot.className = "sc-foot";
        const m = btn(inS ? "☑ in step" : "☐ in step", `${o.id}: ${inS ? "take out of" : "show from"} step ${S.step} on`); m.id = "stepmember";
        m.onclick = () => { s.show = inS ? s.show.filter((x) => x !== o.id) : [...(s.show || []), o.id]; markDirty(true); render(); };
        foot.appendChild(m); cap.appendChild(foot); }
    }
    // FR125: this step's runners follow on from the previous steps' (the end of one is the start of the next)
    S.stepDurs = SP ? SP.durs : [];   // FR128: every step's length so far (⏪ goes back into them)
    S.stepDur = S.stepDurs[S.step] != null ? S.stepDurs[S.step] : ACT.STAND;   // how long the step plays before the next one
    if (SP && SP.P) drawActor(SP.P, boxOf);
  }

  function render() {
    gEdges.textContent = ""; gNodes.textContent = ""; gUnder.textContent = ""; applyView();
    STEP_BEGIN = S.step != null && stepsNow()[S.step] ? +S.stepT0.toFixed(3) + "s" : null;   // FR126
    for (const k in GH) delete GH[k];   // FR118: crossings are recomputed for this view
    for (const k in LABELS) delete LABELS[k];   // FR147
    svg.style.background = (S.data.meta && S.data.meta.background) ? S.data.meta.background : "";
    if (S.data.meta && typeof S.data.meta.ground === "number") drawGround(gEdges, S.data.meta.ground);
    const vis = S.data.nodes.filter(visible);
    const boxOf = {}; for (const n of vis) boxOf[n.id] = rbox(n);
    const sNow = S.step != null && stepsNow()[S.step];   // FR125: what this step adds fades in while the step starts
    NEW_SET = sNow && svg.getCurrentTime() - S.stepT0 < 0.8 ? new Set(sNow.show || []) : null;
    const gates = [];   // FR118: routes crossing a gatehouse router — its windows go under the pipes, its gates over them

    let selPoly = null;
    const epoly = {}, pbUnder = el("g", { class: "pb-lights" }), pbOver = el("g", { class: "pb-lights" });   // FR121: lines the book lights ride
    const gFront = el("g", { class: "front-edges" });   // FR96: z "front" lines, put above the boxes once they're drawn
    const gSleeve = el("g", { class: "sleeves" });   // NT3: sleeves go above every tunnel (so the tunnel shows INSIDE them)
    for (const e of S.data.edges) {
      if (!visible(e)) continue;
      const ends = edgeEnds(e, boxOf); if (!ends) continue;
      const { a, b } = ends, kind = e.kind || "plain";
      const nh = nestHost(e), sl = nh ? sleevePoly(e, nh) : isLan(e) ? ownCable(e, a, b) : null;   // NT14: every LAN line is a cable
      const g = el("g", { class: "edge k-" + kind + (S.selEdge === e.id ? " sel" : ""), "data-edge": e.id }, e.z === "front" ? gFront : sl && sl.poly ? gSleeve : gEdges);
      if (NEW_SET && NEW_SET.has(e.id)) g.classList.add("stepnew");   // FR125
      let mx, my, iconOnLine = false, aside = 0;
      const role = roleOf(e);
      if (sl && sl.poly) {   // NT1–NT4: the link drawn as a see-through sleeve around the tunnel it carries; its icon sits on it
        epoly[e.id] = sl.poly;   // FR124: the step mode's runner can walk a cable
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
        epoly[e.id] = poly;   // FR122: a book's light can ride a tunnel too (your friend's pipe to the internet)
        el("path", { class: "hit", d: "M " + poly.map((p) => `${p.x} ${p.y}`).join(" L "), fill: "none" }, g);
        drawMarioPipe(g, poly, e.color || "#8b949e", e.pw, e.casing);
        if (e.blocked && S.step == null) blockedLoop(g, poly, e.pw || 22);   // FR142: a blocked pipe — in the whole view a visitor knocks and bounces, round and round (in a story step the script says when)
        if (e.gate && GH[e.id] && !e.path) gates.push({ e, poly });   // FR118: this route crosses a gatehouse router
        if (S.selEdge === e.id) selPoly = poly;
        const m = (e.via && e.via.length) || e.labelMid ? longestMid(poly) : poly[Math.max(1, Math.floor(poly.length / 2)) - 1]; mx = m.x; my = m.y;   // FR142: labelMid = on the longest level stretch
        if (m.v) aside = (e.pw || 22) / 2 + 6;   // upright stretch: the label goes beside the pipe, not across it
      } else {
        // arrows connect side-MIDPOINT → side-midpoint, straight or 90° only, snap-to-straight (via zRoute)
        const poly = dedupe(pipePoly(a, b, e));
        epoly[e.id] = poly;
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
      if (e.label) { const t = el("text", aside ? { x: mx + aside, y: my + 4, "text-anchor": "start" }
          : { x: mx, y: my - (isTube(e) ? 18 : iconOnLine ? EBADGE / 2 + 12 : 4), "text-anchor": "middle" }, g);
        if (iconOnLine) t.setAttribute("class", "halo");
        t.textContent = e.label; LABELS[e.id] = { x: +t.getAttribute("x"), y: +t.getAttribute("y"), anchor: t.getAttribute("text-anchor"), text: e.label }; }
    }

    const SP = stepPlans(epoly, boxOf);   // FR129: the active step's plans — before the books are drawn (a runner may write one)
    const houses = {};   // FR118: gatehouse router id → the routes through it (the first one drives the animation)
    for (const gt of gates) (houses[gt.e.gate] = houses[gt.e.gate] || []).push(gt);
    // draw containers first, then normal nodes, then contained children on top
    const rank = (n) => activeContainerOf(n) ? 2 : (isContainer(n) ? 0 : 1);
    for (const n of [...vis].sort((a, b) => rank(a) - rank(b))) {
      const pal = PALETTE[n.color] || PALETTE.note, bx = boxOf[n.id];
      const g = el("g", { class: "node" + (isContainer(n) ? " container" : "") + (S.sel === n.id ? " sel" : ""),
                          "data-id": n.id }, gNodes);
      if (NEW_SET && NEW_SET.has(n.id)) g.classList.add("stepnew");   // FR125: a box this step adds fades in
      const T = NODE_TYPES[n.nodeType], r = T ? T.rx(bx) : 8;   // FR82: block shape = what the box IS
      const lines = labelOf(n).split("\n"), cx = bx.x + bx.w / 2;
      if (isPictogram(n)) {   // FR89: a device IS its icon — no box; the (invisible) box still sizes + anchors it
        // FR99: the click area + selection outline are the DRAWN icon (its measured outline), not the larger layout box
        const hb = anchorBox(n, bx);
        const rect = el("rect", { x: hb.x, y: hb.y, width: hb.w, height: hb.h, rx: 3, ry: 3, fill: "transparent", stroke: "none" }, g);
        if (S.sel === n.id) { rect.setAttribute("stroke", pal.stroke); rect.style.strokeWidth = 1.5; }
        const pg = pictoGeom(bx, lines);
        const sc = ICON_SCREEN[n.icon], scr = sc && imgSrc(n.screen), k24 = pg.s / 24;   // FR127: a picture on the icon's screen (n.screen = "img:<key>"), under its outline
        if (scr) el("image", { href: scr, x: pg.x + sc[0] * k24, y: pg.y + sc[1] * k24, width: sc[2] * k24, height: sc[3] * k24, preserveAspectRatio: "xMidYMid meet", class: "nscreen" }, houses[n.id] ? gUnder : g).style.cursor = "pointer";
        const ic = drawIcon(houses[n.id] ? gUnder : g, n.icon, pg.x, pg.y, pg.s, pal.stroke);   // FR118: a gatehouse sits under its pipes
        if (NEW_SET && NEW_SET.has(n.id)) ic.classList.add("stepnew");   // FR125 (the icon lives outside the node's group)
        if (houses[n.id]) gatehouseUnder(houses[n.id]);
        lines.forEach((ln, i) => { const t = el("text", { x: cx, y: pg.ty + i * 15, "text-anchor": "middle", class: "halo" }, g); t.textContent = ln; });
      } else if (n.nodeType === "phonebook") {   // FR119 / FR121: drawn as the DNS book; click area + selection = the closed book
        const B = bookGeom(n, bx), lt = bookLights(n, B, epoly);
        const wr = SP && SP.P && SP.P.writes.find((w) => w.book === n.id); if (wr) { if (!wr.light) lt.update = null; lt.write = wr; }   // FR129: a runner writes it in this step (FR141: or the server's own light brings the entry — the update light rides in first)
        // FR133: a book a runner writes in this view's story opens the way it was written — spine left, the entry on the right-hand
        // page — in every step and in the whole view, also when someone looks a name up from its right
        const rd = SP && SP.P && SP.P.reads.find((w) => w.book === n.id); if (rd) { lt.ask = lt.answer = lt.update = null; lt.read = rd; }   // FR136: a runner looks it up in this step (it is the lights)
        if (stepsNow().some((st) => (st.play || []).some((a) => a.write === n.id || a.update === n.id))) {   // (FR141: a book the server updates in the story counts too)
          lt.dir = 1;
          if (S.step != null && stepsNow()[S.step] && !(wr && wr.light)) lt.update = null;   // FR134: in the story the runner brought the entry — no update light on any step (FR141: except when the server sends it)
          if (S.step != null && stepsNow()[S.step] && !wr && !rd) { lt.ask = lt.answer = null; lt.still = true; }   // FR136: …and it only opens to be written or read
        }
        const rect = el("rect", { x: B.x, y: B.y, width: B.w, height: B.h, rx: 5, fill: "transparent", stroke: "none" }, g);
        if (S.sel === n.id) { rect.setAttribute("stroke", pal.stroke); rect.style.strokeWidth = 1.5; }
        const fn = lt.answer && node(lt.answer.far), fb = fn && boxOf[fn.id] && anchorBox(fn, boxOf[fn.id]);
        if (fb) lt.glow = { x: fb.x + fb.w / 2, y: fb.y + fb.h / 2 };   // where the answer lands
        drawPhonebook(g, n, B, pal.stroke, lt, pbUnder, pbOver);
        lines.forEach((ln, i) => { const t = el("text", { x: cx, y: B.ty + i * 15, "text-anchor": "middle", class: "halo" }, g); t.textContent = ln; });
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
      if (n.childDiagram && n.nodeType !== "phonebook") {   // (a phonebook has it on its cover, FR121)
        const d = el("text", { x: bx.x + bx.w - Math.max(8, r * 0.7), y: bx.y + 14, "text-anchor": "end", class: "drill" }, g); d.textContent = "⊕ open"; }
    }
    for (const id in houses) if (node(id) && visible(node(id))) { const gp = SP && SP.P && SP.P.gates && SP.P.gates[id];   // FR141: the gates the story worked by hand
      gatehouseGates(id, houses[id], !visitorsNow(), S.step != null && !!stepsNow()[S.step], gp ? { ...gp, T: SP.P.T } : null); }   // FR118: gates + lights, over the pipes (FR126 / FR134)
    gEdges.appendChild(gSleeve);   // NT3: after all tunnels, still under the boxes
    gEdges.appendChild(pbUnder);   // FR121: lights coming into a book slide UNDER it
    gNodes.appendChild(gFront);   // FR102: "front" lines go above the gate badges too (an arrowhead on a gate stays visible)
    gNodes.appendChild(pbOver);   // FR121: the answer leaves over everything
    drawStep(SP, boxOf);   // FR124: the active step's runners (over everything) and its caption
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
    $("ep-gaterow").style.display = "none";   // FR102's gate size: retired by FR118 (the gates are windows of the router)
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
    if (key === "gate" || key === "firewall") { const w = gateOf(pe, key === "firewall" ? "firewall" : "port"); return w && { x: w.x, y: w.y, w: w.w, h: w.h }; }   // FR118: the window's outline
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
    for (const pe of S.data.edges) {   // FR118: on (or next to) a gate window → attach to that gate itself
      if (pe.id === skipEdge) continue;
      for (const [key, which] of [["firewall", "firewall"], ["gate", "port"]]) {
        const w = gateOf(pe, which);
        if (w && wp.x >= w.x - tol / 2 && wp.x <= w.x + w.w + tol / 2 && wp.y >= w.y - tol / 2 && wp.y <= w.y + w.h + tol / 2)
          return { pipe: pe.id, key, pt: { x: w.cx, y: w.cy }, snapped: true, box: { x: w.x, y: w.y, w: w.w, h: w.h } };
      }
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
      t.textContent = (labelOf(n) || n.id).split("\n")[0]; t.style.fill = "#c9d1d9"; t.style.opacity = "0.75"; t.style.fontSize = "11px";
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
        b.onclick = () => { const wasLast = S.step != null && S.step === stepsNow().length - 1;   // FR148: from a story's last step to the new view's last step
          S.toggle[t.id] = o.value; normalizeToggles(); clampStep(); if (wasLast) S.step = null; lastByDefault(); writeHash(); dropHiddenSel();
          if (S.step != null) startStep(S.step); else { buildToggles(); render(); }   // FR125: a step starts over in the new view
          applyAnchor(); };   // FR104: the anchored box stays on its spot in every view
        seg.appendChild(b);
      }
      wrap.appendChild(seg); bar.appendChild(wrap);
    }
    if (stepsNow().length) clampStep();   // FR124: this view's story — FR137: run from the caption bottom-right (drawStep), not from here
    bar.appendChild(anchorButton());   // FR104
    bar.appendChild(nailButton());     // FR106
  }
  const selObj = () => S.selEdge ? S.data.edges.find((e) => e.id === S.selEdge) : S.sel ? node(S.sel) : null;   // the selected box or line
  function startStep(i) {   // FR124 / FR125: show step i from its start state (null = the whole view); the selection is kept so ☐ in step can add it
    S.step = i; clampStep(); S.stepT0 = svg.getCurrentTime(); writeHash(); buildToggles(); render(); applyPause(); schedule();
  }
  function applyPause() {   // FR128: ⏸ stops the clock at once — everything freezes where it is; ▶ (or the whole view) runs it on from there
    if (S.step != null && !S.play) svg.pauseAnimations(); else svg.unpauseAnimations();
  }
  // FR128: ⏪ / ⏩ move the story's clock — within a step by moving the page's clock, into another step by drawing that one with
  // its start set back by how far in it is; back stops at the story's start, ahead goes round (3 → 0) like playing does
  function seekBy(dt) {
    const st = stepsNow(); if (S.step == null || !st.length) return;
    let i = S.step, local = svg.getCurrentTime() - S.stepT0 + dt;
    while (local < 0 && i > 0) { i -= 1; local += S.stepDurs[i]; }   // back into the steps before (drawStep keeps their lengths)
    if (local < 0) local = 0;
    if (i !== S.step) { S.step = i; S.stepT0 = svg.getCurrentTime() - local; writeHash(); buildToggles(); render(); }
    else if (local < S.stepDur) svg.setCurrentTime(S.stepT0 + local);
    while (local >= S.stepDur) {   // ahead into the next steps (a step's end is the next one's start) — each one's length is known once it is drawn
      local -= S.stepDur; S.step = (S.step + 1) % st.length; S.stepT0 = svg.getCurrentTime() - local; writeHash(); buildToggles(); render();
    }
    applyPause(); schedule();
  }
  const SEEK = { dir: 0, t0: 0, last: 0, held: false, raf: 0 };   // a click on ⏪ / ⏩ = 2 s; held = 4× backwards / forwards
  function seekStart(dir) { cancelAnimationFrame(SEEK.raf); Object.assign(SEEK, { dir, t0: performance.now(), held: false }); SEEK.raf = requestAnimationFrame(seekTick); }
  function seekTick(now) {
    if (!SEEK.dir) return;
    if (now - SEEK.t0 > 250) {
      if (!SEEK.held) { SEEK.held = true; SEEK.last = now; }
      const dt = Math.min(0.1, (now - SEEK.last) / 1000); SEEK.last = now;
      if (dt > 0) seekBy(SEEK.dir > 0 ? (S.play ? 3 : 4) * dt : -(S.play ? 5 : 4) * dt);   // the clock itself runs on while playing
    }
    SEEK.raf = requestAnimationFrame(seekTick);
  }
  function seekEnd() { if (!SEEK.dir) return; cancelAnimationFrame(SEEK.raf); if (!SEEK.held) seekBy(SEEK.dir * 2); SEEK.dir = 0; }
  window.addEventListener("pointerup", seekEnd); window.addEventListener("pointercancel", seekEnd);
  function schedule() {   // FR125: while playing, the next step follows as soon as this one's animation has run once (round and round)
    clearTimeout(S.playTimer); S.playTimer = null;
    const st = stepsNow(); if (!S.play || S.step == null || !st.length) return;
    const i = S.step, left = Math.max(0.05, S.stepDur - (svg.getCurrentTime() - S.stepT0));
    S.playTimer = setTimeout(() => { if (S.step === i && S.play) startStep((i + 1) % st.length); }, left * 1000);
  }
  function togglePlay() {
    S.play = !S.play; writeHash(); buildToggles(); render(); applyPause(); schedule();
    status(S.play ? "playing the steps one after another" : "paused — everything stops where it is; ⏪ ⏩ still move it");
  }
  function setStep(i) {
    if (i == null && S.step != null) S.lastStep = S.step;   // FR137: ▶ step by step comes back to it
    S.whole = i == null;   // FR148: ✕ = the whole view (;step=all), a step number = that step
    startStep(i);
    const s = S.step != null && stepsNow()[S.step], o = selObj();
    status(s ? `step <b>${S.step}</b> — ${s.title || s.id}${o && !visible(o) ? ` · <b>${o.id}</b> is not in this step — ☐ in step adds it` : ""}` : "the whole view");
  }
  $("stepenter").onclick = () => setStep(S.lastStep != null ? S.lastStep : 0);
  function editCaption(body, s) {   // FR137: a double-click on the caption edits it in place — Enter (or clicking away) keeps it, Esc drops it
    if (!S.backend || S.capEdit) return;
    S.capEdit = s; clearTimeout(S.playTimer); S.playTimer = null;   // the story waits while you type
    body.contentEditable = "true"; body.focus(); getSelection().selectAllChildren(body);
    const done = (keep) => { if (S.capEdit !== s) return; S.capEdit = null; body.contentEditable = "false";
      const v = body.textContent.replace(/\s+/g, " ").trim();
      if (keep && v !== (s.caption || "")) { s.caption = v; markDirty(true); status(`caption of step <b>${S.step}</b> changed`); }
      render(); schedule(); };
    body.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); done(true); } else if (ev.key === "Escape") { ev.preventDefault(); done(false); } };
    body.onblur = () => done(true);
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
    // FR117: the ◧ link opens the test matrix filtered to this setup-map view (its columns = Install × Network,
    // its rows = Reach × Name — the same toggles); other diagrams link to the whole matrix.
    const ml = $("matrixlink");
    if (ml) ml.href = "index.html" + (S.id === "setup-map" ? h.replace(/^#setup-map;?/, "#") : "");
    if (S.step != null && stepsNow().length) h += `;step=${S.step}` + (S.play ? "" : ";play=0");   // FR124 / FR125: the step (and a pause) are part of the link
    else if (S.whole && stepsNow().length) h += ";step=all";   // FR148: the whole view of a story (without a step a link opens at its last step)
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
      if (toggleState) for (const k in toggleState) if (k !== "step" && k !== "play") S.toggle[k] = toggleState[k];
      S.step = toggleState && /^\d+$/.test(toggleState.step || "") ? +toggleState.step : null;   // FR124: #…;step=i
      S.whole = !!toggleState && toggleState.step === "all";   // FR148: #…;step=all = the whole view, no step = the last step
      S.play = !(toggleState && toggleState.play === "0");   // FR125: ;play=0 = paused
      clearTimeout(S.playTimer); S.stepT0 = svg.getCurrentTime();
      normalizeToggles(); clampStep(); lastByDefault(); writeHash();
      buildCrumbs(); buildPicker(); buildToggles(); buildLegend();
      const v = savedView() || recallView(id); if (v) { S.view = { x: v.x, y: v.y, k: v.k }; applyView(); } else fit();   // FR112, FR94
      applyAnchor();   // FR104: an anchored box sits on its spot in this diagram too (its zoom kept)
      render(); applyPause(); schedule();   // FR125: a step opened from a link plays on (FR128: or stands still, paused)
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
    stepAdopt(id);   // FR124: and only from the active step on
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
    if (S.selEdge) { S.data.edges = S.data.edges.filter((e) => e.id !== S.selEdge); stepForget(S.selEdge); status(`deleted edge ${S.selEdge}`); S.selEdge = null; markDirty(true); render(); return; }
    if (!S.sel) { status("nothing selected"); return; }
    stepForget(S.sel); S.data.edges.filter((e) => e.from === S.sel || e.to === S.sel).forEach((e) => stepForget(e.id));   // FR124: gone from every step too
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
        const b = rbox(n), lines = labelOf(n).split("\n").filter((l) => l), lh = lines.length * 15;
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
          stepAdopt(S.data.edges[S.data.edges.length - 1].id);   // FR124
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
        stepAdopt(id);   // FR124
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
    stepAdopt(it.id);   // FR124: a pasted item joins the active step
    markDirty(true); refreshSwatchSel(); render(); status(`pasted <b>${it.id}</b>${clip.from !== S.id ? ` (from ${clip.from})` : ""} — only in this view; 👁 show-when to widen`);
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Control" || ev.key === "Meta") setCtrl(true);
    const textField = ev.target.tagName === "TEXTAREA" || ev.target.isContentEditable || (ev.target.tagName === "INPUT" && !["range", "color", "button", "checkbox"].includes(ev.target.type));   // (FR137: the caption)
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
        const sc = (sym.getAttribute("data-screen") || "").split(" ").map(Number);   // FR127: where a picture can sit on it
        if (sc.length === 4 && sc.every((v) => !isNaN(v))) ICON_SCREEN[sym.id.replace(/^ic-/, "")] = sc;
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
