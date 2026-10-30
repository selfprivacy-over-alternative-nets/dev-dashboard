"use strict";

// The test matrix, aligned with the setup diagram (flow.html#setup-map, data docs/diagrams/setup-map.json):
//   columns = setups = the diagram's Install × Network views (cable-0a … usb-0c, vm)  [× local | ci]
//   rows    = reach rows = the diagram's Reach × Name views (+ harness-only rows the diagram doesn't have)
// The toggle bar mirrors the diagram's toggles (same labels) as show/hide filters; ▦ opens a diagram view.
const ENVS = ["local", "ci"];
const GLYPH = { pass: "🟢", slow: "🟠", fail: "🔴", skip: "⚪" };
const IS_PAGES = location.hostname.endsWith("github.io");
const $ = (id) => document.getElementById(id);
const DIAGRAM_JSON = "docs/diagrams/setup-map.json";

let CATALOG = null;
let RECORDS = [];
let ALIGN = null;          // [] = matrix matches the diagram; else the mismatches
const OPEN = new Set();    // open cell ids
const FOLD = new Set();    // folded reach groups
// Filters = the diagram's toggles, multi-select. A set holds the HIDDEN values (empty = show everything).
const HIDE = { method: new Set(), net: new Set(), reach: new Set(), name: new Set(), client: new Set() };

async function fetchFirst(paths) {
  for (const p of paths) {
    try { const r = await fetch(p, { cache: "no-store" }); if (r.ok) return await r.text(); } catch (_) {}
  }
  return "";
}

async function boot() {
  try {
    const [cat, jsonl, diag] = await Promise.all([
      fetch("catalog.json", { cache: "no-store" }).then((r) => r.json()),
      // dash writes to the separate testresults repo when it is cloned here; data/ holds the older history (and is
      // all the Pages build has). Show both, one record per run_id.
      Promise.all(["testresults/results.jsonl", "data/results.jsonl"].map((p) => fetchFirst([p]))).then((t) => t.join("\n")),
      fetch(DIAGRAM_JSON, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    CATALOG = cat;
    const seen = new Set();
    RECORDS = jsonl.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .filter((r) => { const k = r.run_id || JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
    ALIGN = diag ? alignment(diag) : ["could not load " + DIAGRAM_JSON];
  } catch (e) {
    $("appmatrix").innerHTML = `<div class="empty">Could not load data (${e}). Serve with <b>./dash serve</b>.</div>`;
    return;
  }
  readHash();
  // Bind defensively: a stale/cached index.html could be missing a newer control (e.g. #f-allruns).
  // One absent element must never abort boot() and leave the whole board blank.
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  ["f-commit", "f-config", "f-demo", "f-allruns"].forEach((id) => on(id, "change", render));
  on("f-commit", "change", buildConfigOptions);
  on("f-demo", "change", () => { buildCommitOptions(); buildConfigOptions(); });
  on("reload", "click", boot);
  window.addEventListener("hashchange", () => { readHash(); render(); });
  buildCommitOptions();
  buildConfigOptions();
  render();
}

// ── the catalog's view of the setup diagram ─────────────────────────────────
const SM = () => CATALOG.setup_map || { methods: [], nets: [], reaches: [], names: [] };
const SETUPS = () => CATALOG.setups || [];
const ROWS = () => CATALOG.reach_rows || [];
const setupById = (id) => SETUPS().find((s) => s.id === id) || (CATALOG.harness_setups || []).find((s) => s.id === id);
const rowById = (id) => ROWS().find((r) => r.id === id);
const kindOf = (s) => (s && s.backend === "box" ? "box" : "vm");
const labelOf = (list, id) => ((list || []).find((x) => x.id === id) || {}).label || id;
const diagUrl = () => SM().url || "flow.html#setup-map";
// A record's canonical setup: diagram setup ids, the harness test-vm, or a legacy alias (lan-setup-0d → cable-0d,
// vm-local → vm). Unknown legacy ids (lan-setup-0, native-ethernet, usb) map to no column.
function setupOf(r) {
  const m = r.method;
  if (!m || m === "-") return m;
  const s = [...SETUPS(), ...(CATALOG.harness_setups || [])].find((x) => x.id === m || (x.aliases || []).includes(m));
  return s ? s.id : m;
}
// A record's reach row: recorded by dash since the diagram alignment; older records are derived from the transport
// where that is unambiguous (tor → .onion, chutney → .onion over chutney, https on the VM/test-VM → local).
function rowOf(r) {
  if (r.reach_row) return r.reach_row;
  if (r.reach) {
    const hit = ROWS().find((x) => x.reach === r.reach && (x.name || null) === (r.reach_name || null) && x.net === r.transport);
    if (hit) return hit.id;
  }
  if (r.transport === "tor") return "onion";
  if (r.transport === "chutney") return "onion-chutney";
  if (r.transport === "tor+https") return "onion-https";               // the old matrix's placeholder networks
  if (r.transport === "chutney+https") return "onion-chutney-https";
  if (r.transport === "https" && kindOf(setupById(setupOf(r))) === "vm") return "local";
  return null;
}
// The diagram view of a (setup, row) cell → flow.html#setup-map;method=…;net=…;reach=…;name=… — "" when there is
// none: the harness test-vm, a future or greyed-out row, or a harness row whose reach isn't a diagram Reach (local
// https). A harness row whose reach IS one (onion over chutney) maps to that view, which it simulates. Mirrors dash's
// diagram_view.
function cellDiagram(setupId, row) {
  const s = SETUPS().find((x) => x.id === setupId);
  if (!s) return "";
  const parts = [`method=${s.method}`].concat(s.net ? [`net=${s.net}`] : []);
  if (row) {
    if (row.future || row.greyed || !SM().reaches.some((x) => x.id === row.reach)) return "";
    parts.push(`reach=${row.reach}`); if (row.name) parts.push(`name=${row.name}`);
  }
  return `${diagUrl()};${parts.join(";")}`;
}
const dLink = (href, title) => href ? `<a class="dlink" href="${esc(href)}" target="_blank" title="${esc(title || "open this view of the setup diagram")}">▦</a>` : "";

// Compare the catalog's axes with the diagram's toggles — the same check as `./dash setups --check`.
function alignment(diag) {
  const out = [];
  const tg = {}; for (const t of ((diag.meta || {}).toggles || [])) tg[t.id] = t;
  const opts = (tid) => ((tg[tid] || {}).options || []).map((o) => [o.value, o.label || ""]);
  const sm = SM();
  for (const [tid, key] of [["method", "methods"], ["net", "nets"], ["reach", "reaches"], ["name", "names"]]) {
    const want = JSON.stringify(opts(tid)), have = JSON.stringify((sm[key] || []).map((x) => [x.id, x.label || ""]));
    if (want !== have) out.push(`toggle '${tid}': diagram ${want} ≠ catalog ${have}`);
  }
  const diagMethods = opts("method").map((o) => o[0]);
  for (const s of SETUPS()) if (!diagMethods.includes(s.method)) out.push(`setup ${s.id}: Install '${s.method}' is not a diagram option`);
  const netOrder = opts("net").map((o) => o[0]);
  const nw = (((tg.net || {}).optionsWhen || {}).method) || {};
  for (const [m] of opts("method")) {
    const allowed = m in nw ? netOrder.filter((n) => (nw[m] || []).includes(n)) : netOrder;
    const want = allowed.length ? allowed.map((n) => `${m}-${n}`) : [m];
    const have = SETUPS().filter((s) => s.method === m).map((s) => s.id);
    if (JSON.stringify(want) !== JSON.stringify(have)) out.push(`Install=${m}: diagram views ${want.join(",")} ≠ matrix setups ${have.join(",")}`);
  }
  for (const s of SETUPS()) {
    const allowed = s.method in nw ? (nw[s.method] || []) : netOrder;
    const want = allowed.length ? s.id.split("-").slice(1).join("-") : null;
    if ((s.net || null) !== want) out.push(`setup ${s.id}: net field ${JSON.stringify(s.net)} doesn't match its id`);
  }
  const rw = (((tg.name || {}).optionsWhen || {}).reach) || {};
  const rows = ROWS().filter((r) => !r.harness && !r.future && !r.greyed).map((r) => `${r.reach}|${r.name || ""}`);
  const views = [];
  for (const [r] of opts("reach")) {
    const names = r in rw ? opts("name").map((o) => o[0]).filter((n) => (rw[r] || []).includes(n)) : opts("name").map((o) => o[0]);
    const have = ((sm.reaches || []).find((x) => x.id === r) || {}).names || [];
    if (JSON.stringify(have) !== JSON.stringify(names)) out.push(`Reach=${r}: diagram names ${JSON.stringify(names)} ≠ catalog names ${JSON.stringify(have)}`);
    for (const n of (names.length ? names : [""])) {
      views.push(`${r}|${n}`);
      if (!rows.includes(`${r}|${n}`)) out.push(`diagram view reach=${r}${n ? ";name=" + n : ""} has no matrix row`);
    }
  }
  for (const rr of rows) if (!views.includes(rr)) out.push(`matrix reach row ${rr.replace("|", " ")} is not a diagram view`);
  return out;
}

// ── filters (the diagram's toggles) + URL hash  (#method=cable,vm;reach=onion — values SHOWN) ──
// Reach chips beyond the diagram's: one per reach that only the matrix has (harness local https, greyed-out relays,
// future transports), labelled by its row without the " · net" / "(…)" suffix.
const extraReaches = () => {
  const seen = new Set(SM().reaches.map((x) => x.id)), out = [];
  for (const r of ROWS()) {
    if (seen.has(r.reach)) continue;
    seen.add(r.reach);
    out.push({ id: r.reach, label: r.label.replace(/ · .*$/, "").replace(/\s*\(.*\)$/, ""), desc: r.desc, harness: r.harness, future: r.future, greyed: r.greyed });
  }
  return out;
};
const TOGGLES = () => [
  { id: "method", label: "install", title: "the setup diagram's Install toggle — show/hide setup columns", opts: SM().methods },
  { id: "net", label: "network", title: "the setup diagram's Network toggle — show/hide setup columns (the VM has none)", opts: SM().nets },
  { id: "reach", label: "reach", title: "the setup diagram's Reach toggle (+ harness-only / greyed-out / future rows) — show/hide row groups",
    opts: [...SM().reaches, ...extraReaches()] },
  { id: "name", label: "name", title: "the setup diagram's Name toggle — show/hide the reach rows that use it", opts: SM().names },
  { id: "client", label: "client", title: "which app the L3 flows drive", opts: [{ id: "desktop", label: "desktop" }, { id: "android", label: "android" }] },
];
function readHash() {
  for (const k in HIDE) HIDE[k].clear();
  const parts = (location.hash || "").replace(/^#/, "").split(";").filter(Boolean);
  for (const p of parts) {
    const [k, v] = p.split("=");
    const t = TOGGLES().find((x) => x.id === k);
    if (!t || v == null) continue;
    const show = new Set(v.split(",").filter(Boolean));
    for (const o of t.opts) if (!show.has(o.id)) HIDE[k].add(o.id);
  }
}
function writeHash() {
  const parts = [];
  for (const t of TOGGLES()) if (HIDE[t.id].size) parts.push(`${t.id}=${t.opts.filter((o) => !HIDE[t.id].has(o.id)).map((o) => o.id).join(",")}`);
  history.replaceState(null, "", parts.length ? "#" + parts.join(";") : location.pathname + location.search);
}
function buildToggles() {
  $("toggles").innerHTML = TOGGLES().map((t) =>
    `<span class="ctl" title="${esc(t.title)}"><label>${esc(t.label)}</label><span class="chips">` +
    t.opts.map((o) => `<span class="nettab ${HIDE[t.id].has(o.id) ? "" : "on"} ${o.harness ? "harness" : ""} ${o.future ? "fut" : ""} ${o.greyed ? "greyed" : ""}" data-t="${t.id}" data-v="${esc(o.id)}" ` +
      `title="${esc((o.desc || o.label) + (o.harness ? " — harness-only (not a diagram view)" : o.future ? " — roadmap, not wired yet" : o.greyed ? " — greyed out: " + o.greyed : "") + " · click to show/hide, double-click to show only this")}">${esc(o.label)}</span>`).join("") +
    `</span></span>`).join("") +
    `<span class="ctl"><a class="dlink big" href="${esc(diagUrl())}" target="_blank" title="open the setup diagram">▦ setup diagram</a></span>`;
  $("toggles").querySelectorAll(".nettab").forEach((el) => {
    el.addEventListener("click", () => { const s = HIDE[el.dataset.t]; s.has(el.dataset.v) ? s.delete(el.dataset.v) : s.add(el.dataset.v); writeHash(); render(); });
    el.addEventListener("dblclick", () => {
      const t = TOGGLES().find((x) => x.id === el.dataset.t); HIDE[t.id].clear();
      for (const o of t.opts) if (o.id !== el.dataset.v) HIDE[t.id].add(o.id);
      writeHash(); render();
    });
  });
}
const shownSetups = () => SETUPS().filter((s) => !HIDE.method.has(s.method) && (!s.net || !HIDE.net.has(s.net)));
const shownRows = () => ROWS().filter((r) => !HIDE.reach.has(r.reach) && !(r.name && HIDE.name.has(r.name)));

// ── commit / config filters ──────────────────────────────────────────────────
const commitKey = (r) => `${r.repo} ${r.commit}`;
const configKey = (r) => (r.dirty ? (r.diff_hash || "dirty") : "clean");
const demoOn = () => $("f-demo").checked;
const scan = () => RECORDS.filter((r) => demoOn() || !r.demo);

function buildCommitOptions() {
  const sel = $("f-commit"), prev = sel.value, by = new Map();
  for (const r of scan()) { const k = commitKey(r); const c = by.get(k); if (!c || r.ts > c.ts) by.set(k, r); }
  const items = [...by.entries()].sort((a, b) => (a[1].ts < b[1].ts ? 1 : -1));
  sel.innerHTML = `<option value="*">● latest (all repos)</option>` +
    items.map(([k, r]) => `<option value="${esc(k)}">${esc(r.commit)} · ${esc(r.repo)} · ${esc(trunc(r.subject, 26))}</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
function buildConfigOptions() {
  const sel = $("f-config"), ck = $("f-commit").value, cfgs = new Map();
  for (const r of scan()) {
    if (ck !== "*" && commitKey(r) !== ck) continue;
    const k = configKey(r);
    if (!cfgs.has(k)) cfgs.set(k, k === "clean" ? "clean" : `dirty · ${k}${r.config_label ? " — " + r.config_label : ""}`);
  }
  const items = [...cfgs.entries()].sort((a, b) => (a[0] === "clean" ? -1 : b[0] === "clean" ? 1 : 0));
  sel.innerHTML = `<option value="*">any</option>` + items.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join("");
}
function filtered() {
  const ck = $("f-commit").value, cfg = $("f-config").value;
  return RECORDS.filter((r) => {
    if (!demoOn() && r.demo) return false;
    if (ck !== "*" && commitKey(r) !== ck) return false;
    if (cfg !== "*" && configKey(r) !== cfg) return false;
    return true;
  });
}

// ── exact commands (every arg explicit; <PLACEHOLDERS> = your own values) ────
function cellCmd(e, setupId, row) {
  const s = setupById(setupId);
  if (e.cmd_template) return e.cmd_template.split("{setup}").join(setupId).replace("{wifi}", s && s.target_wifi ? (e.wifi_args || "") : "");
  if (e.level === "L1") return `./dash run ${e.id}`;
  if (e.level === "L2") return `./dash run ${e.id} --net ${row.net}`;
  if (e.level === "L3") {
    const reach = `--reach ${row.reach}${row.name ? " --name " + row.name : ""} --net ${row.net}`;
    const boxArgs = kindOf(s) === "box" ? " --ip <BOX_LAN_IP> --key <SSH_KEY>" : "";
    if (e.implemented === false)
      return `# not automated yet (${e.cmd}) — drive the ${e.client} app by hand, then log the result:\n` +
        `./dash report ${e.id} --status <pass|fail> --duration <seconds> --on ${setupId} ${reach}${boxArgs}`;
    if (!(row.l3_wired || []).includes(kindOf(s))) {
      if (kindOf(s) !== "box") return `# not wired: L3 over ${row.label} on the VM has no automated test yet (the VM is not reachable over a public route)`;
      return `# no automated L3 over ${row.label} yet — drive the app, then log the result:\n` +
        `./dash app --domain <HOST> --token <API_TOKEN> --apex\n` +
        `./dash report ${e.id} --status <pass|fail> --duration <seconds> --on ${setupId} ${reach} --ip <BOX_LAN_IP> --key <SSH_KEY>`;
    }
    let c = `./dash run ${e.id} --on ${setupId} ${reach}`;
    if (kindOf(s) === "box") c += SM().box_args || " --ip <BOX_LAN_IP> --key <SSH_KEY> --token <API_TOKEN>";
    return c;
  }
  return `./dash run ${e.id}`;
}

// ── render ───────────────────────────────────────────────────────────────────
function render() {
  $("demobanner").className = "demobanner" + (demoOn() ? " show" : "");
  buildToggles();
  renderAlign();
  const recs = filtered();
  const idx = new Map();
  for (const r of recs) { const k = r.id; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(r); }
  for (const l of idx.values()) l.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const states = [];
  renderLevels();
  renderUnit(idx, states);
  renderL2(idx, states);
  renderAppMatrix(idx, states);
  renderSummary(states, recs);
  renderLegend();
  bindCells();
}

function renderAlign() {
  const el = $("alignbanner"); if (!el) return;
  if (!ALIGN || !ALIGN.length) { el.className = "alignbanner ok"; el.innerHTML = `✓ matrix axes = the <a href="${esc(diagUrl())}" target="_blank">setup diagram</a>'s toggles (Install × Network → setup columns, Reach × Name → row groups)`; return; }
  el.className = "alignbanner bad";
  el.innerHTML = `⚠ the matrix no longer matches the <a href="${esc(diagUrl())}" target="_blank">setup diagram</a> — update catalog.json / networks.md / test_matrix.md (see <code>./dash setups --check</code>):<br>` + ALIGN.map(esc).join("<br>");
}

function renderLevels() {
  const L = CATALOG.levels;
  $("levels").innerHTML = `<div class="grouphead">what the levels mean</div><div class="levels">` +
    Object.keys(L).map((k) => `<span class="lv"><b>${k}</b> — ${esc(L[k])}</span>`).join("") + `</div>`;
}

function runsFor(idx, id, row, setup, env) {
  let l = idx.get(id) || [];
  if (row !== undefined) l = l.filter((r) => rowOf(r) === row);
  if (setup !== undefined) l = l.filter((r) => setupOf(r) === setup);
  if (env !== undefined) l = l.filter((r) => r.env === env);
  return l;
}
// One matrix cell: its <td> plus (when unfolded) the full-width detail row with the exact command + diagram view.
function cell(cid, runs, entry, cmd, diag, total) {
  return [`<td class="cell ${OPEN.has(cid) ? "open" : ""}" data-cell="${esc(cid)}">${cellHtml(runs, entry)}</td>`,
          detailRow(cid, runs, entry, total, cmd, diag)];
}

function renderUnit(idx, states) {
  const rows = CATALOG.tests.filter((t) => t.level === "L1");
  const body = rows.map((t) => {
    let details = "";
    let tds = `<td class="rowname" title="${esc(t.desc + runTip(t))}"><span class="lvl">L1 · </span>${esc(t.name)}</td>`;
    for (const env of ENVS) {
      const runs = runsFor(idx, t.id, undefined, undefined, env);
      states.push(runs.length ? runs[0].status : "norun");
      const cid = `${t.id}|-|-|${env}`;
      const [td, det] = cell(cid, runs, t, cellCmd(t), "", 3);
      tds += td; details += det;
    }
    return `<tr>${tds}</tr>` + details;
  }).join("");
  $("unit").innerHTML = `<div class="grouphead">unit (L1) <small>— fast, no setup / reach / network; runs both locally and on CI</small></div>` +
    `<table style="min-width:360px"><thead><tr><th class="rowname">test</th><th class="env">local</th><th class="env">ci</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderL2(idx, states) {
  const tests = CATALOG.tests.filter((t) => t.level === "L2");
  const rows = [...new Set(tests.flatMap((t) => t.reach_rows || []))].map(rowById).filter(Boolean).filter((r) => shownRows().includes(r));
  if (!rows.length) { $("l2").innerHTML = `<div class="grouphead">backend integration (L2)</div><div class="empty">Its reach rows are hidden — show <b>.onion</b> / <b>local https</b> above.</div>`; return; }
  const total = 1 + rows.length * 2;
  // no ▦ here: L2 runs in the harness test-vm, which is not a view of the setup diagram
  const h1 = rows.map((r) => `<th class="net" colspan="2" title="${esc(r.desc)}">${esc(r.label)}</th>`).join("");
  const h2 = rows.map(() => `<th class="env">local</th><th class="env">ci</th>`).join("");
  const body = tests.map((t) => {
    let tds = `<td class="rowname" title="${esc(t.desc + runTip(t))}"><span class="lvl">L2 · </span>${esc(t.name)}</td>`;
    let details = "";
    for (const r of rows) {
      for (const env of ENVS) {
        const runs = runsFor(idx, t.id, r.id, undefined, env);
        states.push(runs.length ? runs[0].status : "norun");
        const cid = `${t.id}|test-vm|${r.id}|${env}`;
        const [td, det] = cell(cid, runs, t, cellCmd(t, "test-vm", r), cellDiagram("test-vm", r), total);
        tds += td; details += det;
      }
    }
    return `<tr>${tds}</tr>` + details;
  }).join("");
  $("l2").innerHTML = `<div class="grouphead">backend integration (L2) <small>— a throwaway NixOS backend test-VM (harness setup <code>test-vm</code>, not a diagram view); runs locally AND on CI. tor = the onion route, https = local https inside the VM</small></div>` +
    `<table><thead><tr><th class="rowname" rowspan="2">test</th>${h1}</tr><tr>${h2}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderAppMatrix(idx, states) {
  const setups = shownSetups();
  const rows = shownRows();
  if (!setups.length) { $("appmatrix").innerHTML = `<div class="grouphead">setups × reach (install · reach · L3)</div><div class="empty">Every setup is hidden — switch an <b>install</b> / <b>network</b> value back on.</div>`; return; }
  const total = 1 + setups.length * 2;
  const methods = SM().methods.filter((m) => setups.some((s) => s.method === m.id));
  const h1 = `<tr><th class="rowname" rowspan="3">setup →<br>reach ↓ · test</th>` + methods.map((m) => {
    const n = setups.filter((s) => s.method === m.id).length;
    return `<th class="method" colspan="${n * 2}" title="${esc(m.desc)}">${esc(m.label)} ${dLink(`${diagUrl()};method=${m.id}`)}<small>install: ${esc(m.install || "")}</small></th>`;
  }).join("") + `</tr>`;
  const h2 = `<tr>` + setups.map((s) => `<th class="net" colspan="2" title="${esc(s.desc + (s.aliases && s.aliases.length ? "  (old id: " + s.aliases.join(", ") + ")" : ""))}">` +
    `${esc(s.net ? labelOf(SM().nets, s.net) : "on this computer")}<br><code>${esc(s.id)}</code> ${dLink(s.diagram)}</th>`).join("") + `</tr>`;
  const h3 = `<tr>` + setups.map(() => `<th class="env">local</th><th class="env">ci</th>`).join("") + `</tr>`;

  const installRow = () => {
    let tds = `<td class="rowname" title="install the backend on this setup (wipe + NixOS), network- and reach-independent">install <span class="lvl">· time</span></td>`;
    let details = "";
    for (const s of setups) {
      const fam = SM().methods.find((m) => m.id === s.method) || {};
      const inst = (CATALOG.installs || []).find((i) => i.id === fam.install) || { id: fam.install || "install." + s.id, level: "install", cmd: "@manual" };
      for (const env of ENVS) {
        if (env === "ci") { tds += npCell("installs can't run on CI (need real VirtualBox / hardware)"); continue; }
        const ids = [...new Set([`install.${s.id}`, inst.id, ...(s.aliases || []).map((a) => "install." + a)])];
        const seenRun = new Set();
        const runs = ids.flatMap((k) => idx.get(k) || [])
          .filter((r) => setupOf(r) === s.id && r.env === env && !seenRun.has(r.run_id) && seenRun.add(r.run_id))
          .sort((a, b) => (a.ts < b.ts ? 1 : -1));
        states.push(runs.length ? runs[0].status : "norun");
        const cid = `install|${s.id}|-|${env}`;
        const [td, det] = cell(cid, runs, inst, cellCmd(inst, s.id), cellDiagram(s.id), total);
        tds += td; details += det;
      }
    }
    return `<tr>${tds}</tr>` + details;
  };

  const applyRow = (row) => {
    const ent = (CATALOG.reaches || []).find((e) => e.reach_row === row.id);
    if (!ent) return "";
    let tds = `<td class="rowname" title="${esc(ent.desc + runTip(ent))}">make reachable <span class="lvl">· ${esc(ent.id)}</span></td>`;
    let details = "";
    for (const s of setups) {
      for (const env of ENVS) {
        if (env === "ci") { tds += npCell("a reach apply configures a real box over SSH — can't run on CI"); continue; }
        if (kindOf(s) === "vm") {
          tds += row.reach === "onion" ? npCell("the VM's .onion is created by install.vm itself (always on)")
            : niCell("not wired for the VM: tools/add-cloudflare.sh drives an installed BOX over SSH");
          continue;
        }
        const runs = runsFor(idx, ent.id, undefined, s.id, env);
        states.push(runs.length ? runs[0].status : "norun");
        const cid = `${ent.id}|${s.id}|${row.id}|${env}`;
        const [td, det] = cell(cid, runs, ent, cellCmd(ent, s.id), cellDiagram(s.id, row), total);
        tds += td; details += det;
      }
    }
    return `<tr>${tds}</tr>` + details;
  };

  const flowRows = (row, client) => CATALOG.tests.filter((t) => t.level === "L3" && t.client === client).map((t) => {
    let tds = `<td class="rowname" title="${esc(t.desc + runTip(t))}">${esc(t.name)} <span class="lvl">· ${esc(client)}</span></td>`;
    let details = "";
    for (const s of setups) {
      for (const env of ENVS) {
        if (row.setups && !row.setups.includes(s.id)) { tds += npCell(`harness-only on ${row.setups.join(" / ")}: ${row.desc}`); continue; }
        if (!(t.networks || []).includes(row.net)) { tds += npCell(`the ${client} flows don't run over ${row.net}`); continue; }
        if (env === "ci") { tds += npCell("app tests can't run on CI — need VirtualBox / real hardware / Tor"); continue; }
        const runs = runsFor(idx, t.id, row.id, s.id, env);
        const wired = (row.l3_wired || []).includes(kindOf(s));
        states.push(runs.length ? runs[0].status : (t.implemented === false || !wired ? "todo" : "norun"));
        const cid = `${t.id}|${s.id}|${row.id}|${env}`;
        if (!runs.length && t.implemented !== false && !wired) { tds += niCell(`not wired into dash yet — ${row.desc}`); continue; }
        const [td, det] = cell(cid, runs, t, cellCmd(t, s.id, row), cellDiagram(s.id, row), total);
        tds += td; details += det;
      }
    }
    return `<tr>${tds}</tr>` + details;
  }).join("");

  let body = `<tr class="group"><td colspan="${total}">install — per setup (network- &amp; reach-independent)</td></tr>` + installRow();
  for (const row of rows) {
    const folded = FOLD.has(row.id);
    const gr = row.greyed ? " greyed" : "";
    body += `<tr class="group reachgrp${gr}" data-fold="${esc(row.id)}"><td colspan="${total}" title="${esc(row.desc + (row.greyed ? "\n\ngreyed out: " + row.greyed : ""))}"><span class="caret">${folded ? "▸" : "▾"}</span> ` +
      `reach: ${esc(row.label)} ${dLink(row.diagram, row.harness ? "nearest diagram view (this row is harness-only)" : "open this Reach view of the setup diagram")}` +
      `<small> — ${row.future ? "roadmap, no flags yet" : row.greyed ? esc(row.greyed) : esc("--reach " + row.reach + (row.name ? " --name " + row.name : "") + " --net " + row.net)}</small></td></tr>`;
    if (folded) continue;
    if (row.future || row.greyed) {
      const why = row.future ? "roadmap transport — not wired yet" : `greyed out — ${row.greyed}`;
      body += `<tr class="${gr.trim()}"><td class="rowname">${row.future ? "roadmap transport" : "greyed out"}</td>${setups.map(() => npCell(why) + npCell(why)).join("")}</tr>`;
      continue;
    }
    body += applyRow(row);
    for (const client of ["desktop", "android"]) if (!HIDE.client.has(client)) body += flowRows(row, client);
  }
  $("appmatrix").innerHTML =
    `<div class="grouphead">setups × reach — install · make reachable · app flows (L3) <small>— columns = the setup diagram's Install × Network views, row groups = its Reach × Name views (▦ opens that view). N/A = not meant to run here (hover for why), ○ = valid but not automated yet. Click a cell for its exact command, runs, logs &amp; video.</small></div>` +
    `<table class="mtx"><thead>${h1}${h2}${h3}</thead><tbody>${body}</tbody></table>`;
  $("appmatrix").querySelectorAll("tr.reachgrp").forEach((tr) => tr.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    const id = tr.dataset.fold; FOLD.has(id) ? FOLD.delete(id) : FOLD.add(id); render();
  }));
}

// ── cells & details ─────────────────────────────────────────────────────────
const showAllRuns = () => { const el = $("f-allruns"); return el ? el.checked : false; };
function runTip(t) { return t && t.run ? "\n\n▶ how to run (edit the <PLACEHOLDERS>):\n" + t.run : ""; }
function cellHtml(runs, entry) {
  if (runs.length) {
    // Default: only the most recent run per cell (compact). "all runs" stacks the full history.
    // Either way, clicking the cell unfolds every run's details below.
    const shown = showAllRuns() ? runs : runs.slice(0, 1);
    const more = (!showAllRuns() && runs.length > 1)
      ? `<span class="more" title="+${runs.length - 1} older run(s) — tick “all runs” up top, or click the cell for full history">+${runs.length - 1}</span>`
      : "";
    return shown.map(runChip).join("") + more;
  }
  if (entry && entry.implemented === false)
    return `<span class="ni" title="not implemented — no automated test is written for this flow yet">○</span>`;
  return `<span class="norun" title="not run — this test exists and the combination is valid, but no run is recorded for the selected commit / config / env. Click for the exact command.">·</span>`;
}
function runChip(r) {
  const st = r.status || "skip";
  const vid = r.artifacts && r.artifacts.video ? ` <span class="vidmark" title="screen recording">▶</span>` : "";
  const when = fmtWhen(r.ts);
  const where = `${r.repo || ""}@${r.commit || ""}${r.dirty ? ` (dirty ${r.diff_hash})` : ""}`;
  const cfg = r.config_label ? ` · cfg: ${r.config_label}` : "";
  const forced = r.forced ? ` · FORCED past: ${(r.forced_reasons || []).join(", ")}` : "";
  const title = `${st} · ${fmtDur(r.duration_s)} · ${when} · ${where}${cfg}${forced}${r.error ? ` · ${r.error}` : ""}`;
  return `<span class="run st-${st} ${r.demo ? "demo" : ""} ${r.forced ? "forced" : ""}" title="${esc(title)}">` +
    `<span class="g">${GLYPH[st] || "⚪"}</span>${r.forced ? `<span class="fq" title="forced past a gate with --allow-dirty">!</span>` : ""}<span class="d">${st === "skip" ? "—" : fmtDur(r.duration_s)}</span>${vid}</span>`;
}
function detailRow(cid, runs, entry, total, cmd, diag) {
  if (!OPEN.has(cid)) return "";
  const inner = runs.length ? runs.map(runDetail).join("")
    : `<div class="meta">No runs for this cell.${entry && entry.cmd === "@todo" ? " The automated test isn't written yet." : ""}</div>`;
  const runBlock = cmd
    ? `<div class="runlabel">run this cell — copy &amp; fill the <code>&lt;PLACEHOLDERS&gt;</code>:</div><pre class="runcmd">${esc(cmd)}</pre>`
    : (entry && entry.run ? `<div class="runlabel">how to run this test — copy &amp; edit the <code>&lt;PLACEHOLDERS&gt;</code>:</div><pre class="runcmd">${esc(entry.run)}</pre>` : "");
  const dl = diag ? `<div class="meta">▦ <a href="${esc(diag)}" target="_blank">this cell's view in the setup diagram</a> <code>${esc(diag.replace(/^.*#/, "#"))}</code></div>` : "";
  return `<tr class="details"><td colspan="${total || 3}"><div class="detail"><div class="head">${esc(cid.replace(/\|/g, "  ·  "))}</div>${dl}${runBlock}${inner}</div></td></tr>`;
}
// Human, EXPLICIT network provenance — states the network by NAME and explains the port,
// so nobody has to know "9050 = Tor / 9009 = chutney". Data comes from the recorded
// dial_domain/socks_port (parsed from the app's own launch command), not from guessing.
const NET_INFO = {
  tor:     { label: "Tor",     blurb: "the real, public Tor network" },
  chutney: { label: "chutney", blurb: "a private, self-contained Tor test-network — NOT the real Tor" },
  https:   { label: "HTTPS",   blurb: "a direct clearnet connection secured with TLS" },
};
function provenanceHtml(r) {
  if (!r.dial_domain) return "";
  const info = NET_INFO[r.transport] || { label: r.transport, blurb: "" };
  const isOnion = /\.onion$/.test(r.dial_domain) || r.transport === "tor" || r.transport === "chutney";
  let how;
  if (isOnion) {
    // Only cite a port when we actually recorded it — never fabricate 9050/9009.
    how = `through the <b>${esc(info.label)}</b> network's proxy` +
          (r.socks_port ? ` (SOCKS port ${esc(r.socks_port)})` : ``);
  } else {
    how = `directly over TLS (no onion, no proxy)`;
  }
  return `<div class="prov"><span class="provhead">🔌 Connected over ${esc(info.label)}</span>` +
    `<span class="provbody"> — ${esc(info.blurb)}. The app reached the backend at ` +
    `<code>${esc(r.dial_domain)}</code> ${how}.</span></div>`;
}
function runDetail(r) {
  const media = (label, p) => !p ? "" : (IS_PAGES ? `<span class="local">${label} (local only)</span>` : `<a href="${esc(p)}" target="_blank">${label}</a>`);
  const a = r.artifacts || {};
  let arts = "";
  if (r.level === "L3" || a.client_log || a.server_log || a.video || (a.screenshots && a.screenshots.length)) {
    const vid = a.video ? (IS_PAGES ? `<span class="video">▶ video — run locally to view</span>` : `<a class="video" href="${esc(a.video)}" target="_blank">▶ play recording</a>`)
      : (r.records_video ? `<span class="local">▶ video pending</span>` : "");
    arts = `<div class="arts">${media("client CLI log", a.client_log)}${media("server log", a.server_log)}${vid}</div>`;
    const shots = a.screenshots || [];
    if (shots.length) {
      arts += IS_PAGES
        ? `<div class="shots"><span class="local">📷 ${shots.length} step screenshot(s) — run locally to view</span></div>`
        : `<div class="shots">` + shots.map((p) => {
            const step = (p.split("/").pop() || "").replace(/\.png$/, "").replace(/^\d+-/, "");
            return `<a class="shot" href="${esc(p)}" target="_blank" title="${esc(step)}"><img loading="lazy" src="${esc(p)}" alt="${esc(step)}"><span>${esc(step)}</span></a>`;
          }).join("") + `</div>`;
    }
  }
  const setup = setupOf(r), row = rowOf(r);
  return `<div class="runline"><span class="head">${GLYPH[r.status] || "⚪"} ${esc(r.status)}${r.duration_s ? " · " + fmtDur(r.duration_s) : ""}</span> ` +
    `<span class="meta">· ${esc(fmtWhen(r.ts))} · ${esc(r.env)} · ${esc(r.repo)}@${esc(r.commit)}${r.dirty ? " (dirty " + esc(r.diff_hash) + ")" : ""}` +
    `${r.config_label ? " · " + esc(r.config_label) : ""}${setup && setup !== "-" ? " · " + esc(setup) + (setup !== r.method ? " (recorded as " + esc(r.method) + ")" : "") : ""}` +
    `${row ? " · " + esc(row) : ""}${r.transport && r.transport !== "-" ? " · " + esc(r.transport) : ""}</span>` +
    (r.forced ? `<div class="err">FORCED past: ${esc((r.forced_reasons || []).join(", "))} (--allow-dirty) — not a clean pass</div>` : "") +
    provenanceHtml(r) +
    (r.error ? `<div class="err">${esc(r.error)}</div>` : "") + arts +
    (r.demo ? `<div class="demoflag">— illustrative DEMO record —</div>` : "") + `</div>`;
}

function renderSummary(states, recs) {
  const c = { pass: 0, slow: 0, fail: 0, todo: 0, norun: 0, skip: 0 };
  for (const s of states) c[s] = (c[s] || 0) + 1;
  const done = c.pass + c.slow + c.fail, pct = done ? Math.round((c.pass / done) * 100) : 0;
  const slow = recs.filter((r) => r.duration_s > 0).sort((a, b) => b.duration_s - a.duration_s)[0];
  $("summary").innerHTML =
    `<span><b>${pct}%</b> of run cells pass</span>` +
    `<span class="k-pass">🟢 ${c.pass}</span><span class="k-slow">🟠 ${c.slow}</span><span class="k-fail">🔴 ${c.fail}</span>` +
    `<span class="k-skip">○ ${c.todo} not automated yet · · ${c.norun} not run</span>` +
    `<span>· ${recs.length} runs recorded</span>` +
    (slow ? `<span>· slowest <b>${esc(slow.name)}</b> ${fmtDur(slow.duration_s)}</span>` : "");
}
function renderLegend() {
  $("legend").innerHTML =
    `<b>Axes = the <a href="${esc(diagUrl())}" target="_blank">setup diagram</a>:</b> a column is a <b>setup</b> (<code>--on</code>) = one Install × Network view (<code>cable-0a</code> … <code>usb-0c</code>, <code>vm</code>); a row group is a <b>reach</b> (<code>--reach</code> [<code>--name</code>]) = one Reach × Name view, plus the transport the app speaks (<code>--net</code>). <b>▦</b> opens the matching diagram view; the toolbar toggles are the diagram's, as show/hide filters (double-click = only this; the URL keeps the selection). Harness-only rows (chutney, local https) and the <code>test-vm</code> exist only in the test harness, not in the diagram. <span class="greyed">Greyed-out rows</span> (Tor + https, chutney + https, ngrok, Pinggy, LocalTunnel) are kept for reference but can't run: no diagram view, no test (hover for why).<br>` +
    `<b>🟢 pass</b> · <b>🟠 slow</b> · <b>🔴 fail</b> — each shows its duration; <b>!</b> = forced past a gate with <code>--allow-dirty</code> (not a clean pass); <b>hover a run</b> for when · commit · dirty-config, or <b>click</b> to unfold the exact command, error, logs &amp; video. Multiple runs stack newest-first.<br>` +
    `<b>○ not automated yet</b> — a valid combination with no automated test (not written, or not wired into dash for that backend). &nbsp; <b>· not run</b> — test exists &amp; the combo is valid, but no run recorded for this commit/config/env. &nbsp; <b>N/A</b> — this combo isn't meant to run (hover for why: CI can't drive the app/install; harness-only rows are VM-only; future transports).<br>` +
    `By default each cell shows only its <b>most recent</b> run (older ones as <b>+N</b>); tick <b>all runs</b> up top to stack the full history. Pick a <b>commit</b> then a <b>config</b> to compare clean vs dirty. Videos/logs are local-only (<code>./dash serve</code>); on Pages they're placeholders.`;
}
function bindCells() {
  document.querySelectorAll(".cell[data-cell]").forEach((el) =>
    el.addEventListener("click", (ev) => { if (ev.target.closest("a")) return; const id = el.dataset.cell; OPEN.has(id) ? OPEN.delete(id) : OPEN.add(id); render(); }));
}

// ── utils ────────────────────────────────────────────────────────────────
// "not applicable" — this combination isn't meant to run (CI limits / harness-only row / future transport).
// Shown as a muted "N/A" (NOT a red 🔴, which is reserved for tests that actually ran and failed).
const npCell = (reason) => `<td class="cell np" title="not applicable — ${esc(reason)}">N/A</td>`;
// "not automated yet" — a valid combination (a real diagram view) that no automated test covers yet.
const niCell = (reason) => `<td class="cell np ni" title="○ ${esc(reason)}">○</td>`;
function fmtDur(s) {
  s = Number(s) || 0;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 90) return Math.round(s) + "s";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}m${String(sec).padStart(2, "0")}s`;
}
// Records store UTC (ISO + 'Z'); render in the viewer's LOCAL timezone plus a relative "ago", so a
// run made 15 min ago doesn't read as 2h old just because the viewer is in UTC+2.
function relTime(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60), mm = m % 60; if (h < 24) return `${h}h${mm ? ` ${mm}m` : ""} ago`;
  const days = Math.round(h / 24); return `${days}d ago`;
}
function fmtWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const local = d.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return `${local} (${relTime((Date.now() - d.getTime()) / 1000)})`;
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

boot();
