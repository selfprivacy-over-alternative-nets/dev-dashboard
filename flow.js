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
  };
  const COLOR_KEYS = Object.keys(PALETTE);
  const ICONS = ["laptop", "server", "router", "cloud", "phone", "usb", "ethernet", "wifi", "safe", "relay", "tor"];
  const EDGE_KINDS = ["plain", "cable", "wifi", "usb", "lan", "internet", "tunnel", "tor"];

  const $ = (id) => document.getElementById(id);
  const svg = $("svg"), gViewport = $("viewport"), gNodes = $("nodes"), gEdges = $("edges");

  const S = {
    id: null, data: null, index: { diagrams: [], root: "overview" },
    backend: false, dirty: false,
    sel: null, selEdge: null,
    toggle: {},                       // active toggle state {toggleId: value}
    view: { x: 40, y: 40, k: 1 },
    mode: "idle", pending: null, drag: null, panStart: null,
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
    if (c && depth < 6) { const p = node(c); if (p) { const pb = { x: p.x, y: p.y };
      x = pb.x + (typeof n.cdx === "number" ? n.cdx : 16);
      y = pb.y + (typeof n.cdy === "number" ? n.cdy : 56); } }
    // grow to enclose active contained children (if this node is a container)
    for (const k of S.data.nodes) {
      if (!visible(k) || activeContainerOf(k) !== n.id) continue;
      const r = rbox(k, depth + 1);
      w = Math.max(w, r.x + r.w + 14 - x);
      h = Math.max(h, r.y + r.h + 14 - y);
    }
    return { x, y, w, h };
  }
  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
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

  // Super-Mario-style warp pipes (FR42/FR52): ORTHOGONAL routing (H/V, 90° elbows — never diagonal),
  // authentic lip + shaded body + black outline. Routing: explicit e.path if given, else an auto Z-route.
  function shade(hex, f) {
    const m = (hex || "#8b949e").replace("#", "");
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    const h = (v) => Math.max(0, Math.min(255, Math.round(v * f))).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }
  function dedupe(pts) { const o = []; for (const p of pts) { const q = o[o.length - 1]; if (!q || Math.abs(q.x - p.x) > 0.5 || Math.abs(q.y - p.y) > 0.5) o.push({ x: p.x, y: p.y }); } return o; }
  function zRoute(a, b) {   // orthogonal border-to-border route (H-V-H or V-H-V)
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    if (Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y)) {
      const sx = cb.x >= ca.x ? a.x + a.w : a.x, ex = cb.x >= ca.x ? b.x : b.x + b.w, mx = (sx + ex) / 2;
      return [{ x: sx, y: ca.y }, { x: mx, y: ca.y }, { x: mx, y: cb.y }, { x: ex, y: cb.y }];
    }
    const sy = cb.y >= ca.y ? a.y + a.h : a.y, ey = cb.y >= ca.y ? b.y : b.y + b.h, my = (sy + ey) / 2;
    return [{ x: ca.x, y: sy }, { x: ca.x, y: my }, { x: cb.x, y: my }, { x: cb.x, y: ey }];
  }
  const pipePoly = (aBox, bBox, e) => (Array.isArray(e.path) && e.path.length >= 2) ? e.path.map((p) => ({ x: p.x, y: p.y })) : zRoute(aBox, bBox);
  function drawMarioPipe(parent, poly, color) {
    const pts = dedupe(poly); if (pts.length < 2) return;
    const dark = shade(color, 0.5), light = shade(color, 1.55), OL = "#0a140a", BODY = 22;
    const ln = (x1, y1, x2, y2, s, w) => el("line", { x1, y1, x2, y2, stroke: s, "stroke-width": w }, parent);
    const d = "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L ");
    el("path", { d, fill: "none", stroke: OL, "stroke-width": BODY + 6, "stroke-linejoin": "round" }, parent);
    el("path", { d, fill: "none", stroke: color, "stroke-width": BODY, "stroke-linejoin": "round" }, parent);
    for (let i = 1; i < pts.length; i++) {
      const A = pts[i - 1], B = pts[i];
      if (Math.abs(A.y - B.y) < 0.5) { ln(A.x, A.y - 6, B.x, B.y - 6, light, 4); ln(A.x, A.y + 7, B.x, B.y + 7, dark, 4); }
      else { ln(A.x - 6, A.y, B.x - 6, B.y, light, 4); ln(A.x + 7, A.y, B.x + 7, B.y, dark, 4); }
    }
    const rim = (p, q) => { const dx = p.x - q.x, dy = p.y - q.y, L = Math.hypot(dx, dy) || 1, px = -dy / L * 19, py = dx / L * 19;
      ln(p.x - px, p.y - py, p.x + px, p.y + py, OL, 18); ln(p.x - px * 0.9, p.y - py * 0.9, p.x + px * 0.9, p.y + py * 0.9, color, 13);
      ln(p.x - px * 0.9, p.y - py * 0.9, p.x + px * 0.9, p.y + py * 0.9, light, 3); };
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
        drawMarioPipe(g, poly, e.color || "#8b949e");
        const m = poly[Math.max(1, Math.floor(poly.length / 2)) - 1]; mx = m.x; my = m.y;
      } else {
        const p1 = border(a, b), p2 = border(b, a);
        el("line", { class: "hit", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }, g);
        const w = el("line", { class: "wire", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, "marker-end": "url(#arrow)" }, g);
        if (e.color) w.setAttribute("stroke", e.color);
        mx = (p1.x + p2.x) / 2; my = (p1.y + p2.y) / 2;
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
      if (n.seeThrough) rect.setAttribute("fill-opacity", "0.3");   // FR54: pipes visible through the router
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
    S.data.nodes.forEach((n) => { if (n.container === S.sel) { delete n.container; delete n.containerWhen; } });
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
      const n = node(nid), w = toWorld(ev), contained = !!activeContainerOf(n);
      S.drag = { id: nid, contained, wx0: w.x, wy0: w.y,
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
    if (S.mode === "drag" && S.drag) {
      const w = toWorld(ev), n = node(S.drag.id), dx = w.x - S.drag.wx0, dy = w.y - S.drag.wy0;
      if (S.drag.contained) { n.cdx = S.drag.cdx0 + dx; n.cdy = S.drag.cdy0 + dy; }
      else { n.x = S.drag.x0 + dx; n.y = S.drag.y0 + dy; }
      markDirty(true); render();
    } else if (S.mode === "pan" && S.panStart) {
      S.view.x = S.panStart.vx + (ev.clientX - S.panStart.x); S.view.y = S.panStart.vy + (ev.clientY - S.panStart.y); applyView();
    }
  });
  function endPointer(ev) { if (S.mode) { try { svg.releasePointerCapture(ev.pointerId); } catch (_) {} }
    S.mode = "idle"; S.drag = null; S.panStart = null; svg.classList.remove("panning"); }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
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
  window.addEventListener("keydown", (ev) => {
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
    if (ev.key === "Delete" || ev.key === "Backspace") { if (S.sel || S.selEdge) { ev.preventDefault(); delSel(); } }
    else if (ev.key === "Escape") { if (S.pending) { S.pending = null; svg.classList.remove("addedge"); status("cancelled"); } }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); save(); }
  });
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
