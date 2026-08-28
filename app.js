"use strict";

const ENVS = ["local", "ci"];
const GLYPH = { pass: "🟢", slow: "🟠", fail: "🔴", skip: "⚪" };
const IS_PAGES = location.hostname.endsWith("github.io");
const $ = (id) => document.getElementById(id);

let CATALOG = null;
let RECORDS = [];
const SHOWN = {};          // network -> shown as column?
const OPEN = new Set();    // open cell ids

async function boot() {
  try {
    const [cat, jsonl] = await Promise.all([
      fetch("catalog.json", { cache: "no-store" }).then((r) => r.json()),
      fetch("data/results.jsonl", { cache: "no-store" }).then((r) => (r.ok ? r.text() : "")),
    ]);
    CATALOG = cat;
    RECORDS = jsonl.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    $("appmatrix").innerHTML = `<div class="empty">Could not load data (${e}). Serve with <b>./dash serve</b>.</div>`;
    return;
  }
  for (const n of CATALOG.networks) SHOWN[n] = true;   // show ALL networks by default
  ["f-commit", "f-config", "f-demo"].forEach((id) => $(id).addEventListener("change", render));
  $("f-commit").addEventListener("change", buildConfigOptions);
  $("f-demo").addEventListener("change", () => { buildCommitOptions(); buildConfigOptions(); });
  $("reload").addEventListener("click", boot);
  buildCommitOptions();
  buildConfigOptions();
  buildNetTabs();
  render();
}

// ── filters ────────────────────────────────────────────────────────────────
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
function buildNetTabs() {
  $("nettabs").innerHTML = CATALOG.networks.map((n) =>
    `<span class="nettab ${SHOWN[n] ? "on" : ""} ${fut(n) ? "future" : ""}" data-net="${n}" title="${fut(n) ? "future transport — not wired yet" : "show/hide this network's columns"}">${n}</span>`).join("");
  $("nettabs").querySelectorAll(".nettab").forEach((el) =>
    el.addEventListener("click", () => { const n = el.dataset.net; SHOWN[n] = !SHOWN[n]; render(); }));
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
const shownNets = () => CATALOG.networks.filter((n) => SHOWN[n]);
const fut = (n) => CATALOG.future_networks.includes(n);

// Can this (level, method) run on GitHub Actions CI?  (network only gates via 'future')
function canRunCI(level, method) {
  if (level === "L1" || level === "L2") return true;         // nix VMs run on CI
  return method === "test-vm";                                // app/install (VBox, hardware) can't
}

// ── render ───────────────────────────────────────────────────────────────
function render() {
  $("demobanner").className = "demobanner" + (demoOn() ? " show" : "");
  buildNetTabs();
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

function renderLevels() {
  const L = CATALOG.levels;
  $("levels").innerHTML = `<div class="grouphead">what the levels mean</div><div class="levels">` +
    Object.keys(L).map((k) => `<span class="lv"><b>${k}</b> — ${esc(L[k])}</span>`).join("") + `</div>`;
}

function runsFor(idx, id, net, method, env) {
  let l = idx.get(id) || [];
  if (net !== undefined) l = l.filter((r) => r.transport === net);
  if (method !== undefined) l = l.filter((r) => r.method === method);
  if (env !== undefined) l = l.filter((r) => r.env === env);
  return l;
}

function envHead(nets) {
  // two header rows: network (colspan 2) then local|ci
  const h1 = nets.map((n) => `<th class="net ${fut(n) ? "future" : ""}" colspan="2" title="${fut(n) ? "future" : "network"}">${n}</th>`).join("");
  const h2 = nets.map(() => `<th class="env">local</th><th class="env">ci</th>`).join("");
  return { h1, h2 };
}

function renderUnit(idx, states) {
  const rows = CATALOG.tests.filter((t) => t.level === "L1");
  const body = rows.map((t) => {
    let details = "";
    let tds = `<td class="rowname" title="${esc(t.desc)}"><span class="lvl">L1 · </span>${esc(t.name)}</td>`;
    for (const env of ENVS) {
      const runs = runsFor(idx, t.id, undefined, undefined, env);
      states.push(runs.length ? runs[0].status : "norun");
      const cid = `${t.id}|-|-|${env}`;
      tds += `<td class="cell ${OPEN.has(cid) ? "open" : ""}" data-cell="${esc(cid)}">${cellHtml(runs, t)}</td>`;
      details += detailRow(cid, runs, t, 3);
    }
    return `<tr>${tds}</tr>` + details;
  }).join("");
  $("unit").innerHTML = `<div class="grouphead">unit (L1) <small>— fast, no VM/network; runs both locally and on CI</small></div>` +
    `<table style="min-width:360px"><thead><tr><th class="rowname">test</th><th class="env">local</th><th class="env">ci</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderL2(idx, states) {
  const nets = shownNets();
  const { h1, h2 } = envHead(nets);
  const total = 1 + nets.length * 2;
  const rows = CATALOG.tests.filter((t) => t.level === "L2");
  const body = rows.map((t) => {
    let tds = `<td class="rowname" title="${esc(t.desc)}"><span class="lvl">L2 · </span>${esc(t.name)}</td>`;
    let details = "";
    for (const n of nets) {
      if (fut(n)) { tds += npPair("future transport — not wired yet"); continue; }
      if (!t.networks.includes(n)) { tds += npPair("L2 runs on " + t.networks.join(" / ") + " only"); continue; }
      for (const env of ENVS) {
        const runs = runsFor(idx, t.id, n, t.method || "test-vm", env);
        states.push(runs.length ? runs[0].status : "norun");
        const cid = `${t.id}|${t.method || "test-vm"}|${n}|${env}`;
        tds += `<td class="cell ${OPEN.has(cid) ? "open" : ""}" data-cell="${esc(cid)}">${cellHtml(runs, t)}</td>`;
        details += detailRow(cid, runs, t, total);
      }
    }
    return `<tr>${tds}</tr>` + details;
  }).join("");
  $("l2").innerHTML = `<div class="grouphead">backend integration (L2) <small>— NixOS backend in the automated test-VM; runs locally AND on CI</small></div>` +
    `<table><thead><tr><th class="rowname" rowspan="2">test</th>${h1}</tr><tr>${h2}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderAppMatrix(idx, states) {
  const nets = shownNets();
  const methods = CATALOG.install_methods.filter((m) => m.id !== "test-vm");
  const per = nets.length * 2;               // net × env
  const total = 1 + methods.length * per;
  if (!nets.length) { $("appmatrix").innerHTML = `<div class="grouphead">app usage (L3)</div><div class="empty">Enable a network above.</div>`; return; }

  const h1 = `<tr><th class="rowname" rowspan="3">flow</th>` +
    methods.map((m) => `<th class="method" colspan="${per}" title="${esc(m.desc)}">${esc(m.label)}<small>${esc(m.group)}</small></th>`).join("") + `</tr>`;
  const h2 = `<tr>` + methods.map(() => nets.map((n) => `<th class="net ${fut(n) ? "future" : ""}" colspan="2">${n}</th>`).join("")).join("") + `</tr>`;
  const h3 = `<tr>` + methods.map(() => nets.map(() => `<th class="env">local</th><th class="env">ci</th>`).join("")).join("") + `</tr>`;

  const installRow = () => {
    let tds = `<td class="rowname" title="how long the backend install took (network-independent)">backend install <span class="lvl">· time</span></td>`;
    let details = "";
    for (const m of methods) {
      const inst = CATALOG.installs.find((i) => i.method === m.id) || { id: m.id, level: "install", cmd: "@manual" };
      for (const n of nets) {
        if (fut(n)) { tds += npPair("future transport — not wired yet"); continue; }
        for (const env of ENVS) {
          if (env === "ci") { tds += npCell("installs can't run on CI (need real VirtualBox/hardware)"); continue; }
          const runs = runsFor(idx, inst.id, undefined, undefined, env);
          states.push(runs.length ? runs[0].status : "norun");
          const cid = `${inst.id}|install|${n}|${env}`;
          tds += `<td class="cell ${OPEN.has(cid) ? "open" : ""}" data-cell="${esc(cid)}">${cellHtml(runs, inst)}</td>`;
          details += detailRow(cid, runs, inst, total);
        }
      }
    }
    return `<tr>${tds}</tr>` + details;
  };

  const flowRows = (client) => CATALOG.tests.filter((t) => t.level === "L3" && t.client === client).map((t) => {
    let tds = `<td class="rowname" title="${esc(t.desc)}">${esc(t.name)}</td>`;
    let details = "";
    for (const m of methods) {
      for (const n of nets) {
        if (fut(n)) { tds += npPair("future transport — not wired yet"); continue; }
        if (!t.networks.includes(n)) { tds += npPair("not applicable for the " + client + " app"); continue; }
        for (const env of ENVS) {
          if (env === "ci" && !canRunCI(t.level, m.id)) { tds += npCell("app tests can't run on CI — need VirtualBox / real hardware / Tor"); continue; }
          const runs = runsFor(idx, t.id, n, m.id, env);
          states.push(runs.length ? runs[0].status : (t.implemented === false ? "todo" : "norun"));
          const cid = `${t.id}|${m.id}|${n}|${env}`;
          tds += `<td class="cell ${OPEN.has(cid) ? "open" : ""}" data-cell="${esc(cid)}">${cellHtml(runs, t)}</td>`;
          details += detailRow(cid, runs, t, total);
        }
      }
    }
    return `<tr>${tds}</tr>` + details;
  }).join("");

  const grp = (label, sub, html) => `<tr class="group"><td colspan="${total}">${label}${sub ? ` — ${sub}` : ""}</td></tr>` + html;
  $("appmatrix").innerHTML =
    `<div class="grouphead">app usage (L3) <small>— columns: install method × network × [local | ci]. ✕ = can't run on CI. Click a cell to unfold runs, errors, logs &amp; video.</small></div>` +
    `<table><thead>${h1}${h2}${h3}</thead><tbody>` +
    grp("installation", "deploy time per method (network-independent)", installRow()) +
    grp("desktop app", "flutter app on Ubuntu / NixOS", flowRows("desktop")) +
    grp("android app", "selfprivacy apk + orbot", flowRows("android")) +
    `</tbody></table>`;
}

// ── cells & details ─────────────────────────────────────────────────────────
function cellHtml(runs, entry) {
  if (runs.length) return runs.map(runChip).join("");
  if (entry && entry.implemented === false)
    return `<span class="ni" title="not implemented — no automated test is written for this flow yet">○</span>`;
  return `<span class="norun" title="not run — this test exists and the combination is valid, but no run is recorded for the selected commit / config / network / env. Start one with ./dash here or ./dash run.">·</span>`;
}
function runChip(r) {
  const st = r.status || "skip";
  const vid = r.artifacts && r.artifacts.video ? ` <span class="vidmark" title="screen recording">▶</span>` : "";
  const when = (r.ts || "").replace("T", " ").replace("Z", " UTC");
  const where = `${r.repo || ""}@${r.commit || ""}${r.dirty ? ` (dirty ${r.diff_hash})` : ""}`;
  const cfg = r.config_label ? ` · cfg: ${r.config_label}` : "";
  const title = `${st} · ${fmtDur(r.duration_s)} · ${when} · ${where}${cfg}${r.error ? ` · ${r.error}` : ""}`;
  return `<span class="run st-${st} ${r.demo ? "demo" : ""}" title="${esc(title)}">` +
    `<span class="g">${GLYPH[st] || "⚪"}</span><span class="d">${st === "skip" ? "—" : fmtDur(r.duration_s)}</span>${vid}</span>`;
}
function detailRow(cid, runs, entry, total) {
  if (!OPEN.has(cid)) return "";
  const inner = runs.length ? runs.map(runDetail).join("")
    : `<div class="meta">No runs for this cell.${entry && entry.cmd === "@todo" ? " The automated test isn't written yet." : ""}</div>`;
  return `<tr class="details"><td colspan="${total || 3}"><div class="detail"><div class="head">${esc(cid.replace(/\|/g, "  ·  "))}</div>${inner}</div></td></tr>`;
}
function runDetail(r) {
  const media = (label, p) => !p ? "" : (IS_PAGES ? `<span class="local">${label} (local only)</span>` : `<a href="${esc(p)}" target="_blank">${label}</a>`);
  const a = r.artifacts || {};
  let arts = "";
  if (r.level === "L3" || a.client_log || a.server_log || a.video) {
    const vid = a.video ? (IS_PAGES ? `<span class="video">▶ video — run locally to view</span>` : `<a class="video" href="${esc(a.video)}" target="_blank">▶ play recording</a>`)
      : (r.records_video ? `<span class="local">▶ video pending</span>` : "");
    arts = `<div class="arts">${media("client CLI log", a.client_log)}${media("server log", a.server_log)}${vid}</div>`;
  }
  return `<div class="runline"><span class="head">${GLYPH[r.status] || "⚪"} ${esc(r.status)}${r.duration_s ? " · " + fmtDur(r.duration_s) : ""}</span> ` +
    `<span class="meta">· ${esc(r.ts)} · ${esc(r.env)} · ${esc(r.repo)}@${esc(r.commit)}${r.dirty ? " (dirty " + esc(r.diff_hash) + ")" : ""}` +
    `${r.config_label ? " · " + esc(r.config_label) : ""}${r.method && r.method !== "-" ? " · " + esc(r.method) : ""}${r.transport && r.transport !== "-" ? " · " + esc(r.transport) : ""}</span>` +
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
    `<span class="k-skip">○ ${c.todo} not implemented · · ${c.norun} not run</span>` +
    `<span>· ${recs.length} runs recorded</span>` +
    (slow ? `<span>· slowest <b>${esc(slow.name)}</b> ${fmtDur(slow.duration_s)}</span>` : "");
}
function renderLegend() {
  $("legend").innerHTML =
    `<b>🟢 pass</b> · <b>🟠 slow</b> · <b>🔴 fail</b> — each shows its duration; <b>hover a run</b> for when · commit · dirty-config, or <b>click</b> to unfold error, logs &amp; video. Multiple runs stack newest-first.<br>` +
    `<b>○ not implemented</b> — no automated test written for this flow yet. &nbsp; <b>· not run</b> — test exists &amp; the combo is valid, but no run recorded for this commit/config/network/env. &nbsp; <b>✕ not possible</b> — this combo can't run (hover for why: CI can't do app/install methods; future transports; or N/A for the client). &nbsp; <b>▶</b> recording · <b>ᶜ</b> CI run.<br>` +
    `Every network shows two columns — <b>local</b> and <b>ci</b>. CI runs L1 + L2 (nix VMs) but not the app/install methods, so those CI cells are ✕. Toggle networks up top.<br>` +
    `Multiple runs <b>stack newest-first</b>. Click a cell to <b>unfold</b> runs, errors, CLI log, server log, video. Pick a <b>commit</b> then a <b>config</b> to compare clean vs dirty. Videos/logs are local-only (<code>./dash serve</code>); on Pages they're placeholders.`;
}
function bindCells() {
  document.querySelectorAll(".cell[data-cell]").forEach((el) =>
    el.addEventListener("click", () => { const id = el.dataset.cell; OPEN.has(id) ? OPEN.delete(id) : OPEN.add(id); render(); }));
}

// ── utils ────────────────────────────────────────────────────────────────
// "not possible" — this combination can't run (CI / future transport / N/A). One clear glyph, ✕.
const npCell = (reason) => `<td class="cell np" title="not possible — ${esc(reason)}">✕</td>`;
const npPair = (reason) => npCell(reason) + npCell(reason);
function fmtDur(s) {
  s = Number(s) || 0;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 90) return Math.round(s) + "s";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}m${String(sec).padStart(2, "0")}s`;
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

boot();
