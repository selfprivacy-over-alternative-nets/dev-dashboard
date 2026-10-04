/* SelfPrivacy test matrix dashboard.
 * Reshapes testresults/results.jsonl into: branch/commit → group → test → network × setup × {local,ci}.
 * Collapsed cell = latest run's status dot; click a dot → drawer with that config's full run
 * history on the selected commit, each run expandable to its log + screenshots + video.
 * Networks and setups are a FIXED canonical list; absent combos render as ⚪ N/A.
 */
(() => {
  "use strict";

  const NETWORKS = [
    ["tor", "Tor"], ["tor+https", "Tor+https"], ["chutney", "Chutney"],
    ["chutney+https", "Chutney+https"], ["https", "Https"], ["yggdrasil", "Yggdrasil"], ["hyphanet", "Hyphanet"],
  ];
  const SETUPS = ["vm-local", "lan-setup-0a", "lan-setup-0b", "lan-setup-0c", "lan-setup-0d",
                  "lan-setup-1", "lan-setup-2", "usb-0a", "usb-0b", "usb-0c"];
  const HOSTS = [["local", "L"], ["ci", "C"]];
  const IS_PAGES = location.hostname.endsWith("github.io");

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const relTime = (iso) => {
    if (!iso) return "";
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (isNaN(d)) return iso;
    if (d < 90) return Math.round(d) + "s ago";
    if (d < 5400) return Math.round(d / 60) + "m ago";
    if (d < 172800) return Math.round(d / 3600) + "h ago";
    return Math.round(d / 86400) + "d ago";
  };
  const groupOf = (r) => r.group || r.level || r.category || "misc";
  const hostOf = (r) => (r.env === "ci" ? "ci" : "local");
  const netOf = (r) => (!r.transport || r.transport === "-" ? "" : r.transport);

  let MODEL = null, SEL = null, CELLS = [], CAT = {};
  // L3 runs the Flutter app against an external deployed box (needs --ip/--key). L1/L2 are
  // self-contained nixosTests that spin their own VM.
  const needsBox = (e) => e.level === "L3";
  function cmdFor(e, net, setup) {
    if (e.category === "install" || e.level === "install")
      return `./dash run ${e.id} --on ${setup} --ip <box-ip> --env NETBOOT=<auto|off> --env TRANSPORT=<https|onion|none> --env FLAKE=<flake> --env MAC=<mac> --env KEY=<ssh-key> --env DOMAIN=<domain>`;
    let c = `./dash run ${e.id}`;
    if (net) c += ` --net ${net}`;
    // "test-vm" is a self-contained nixosTest's intrinsic method, not a setup you pass; only
    // emit --on for real deploy setups so the hover command is the exact minimal working one.
    if (setup && setup !== "<setup>" && setup !== "test-vm") c += ` --on ${setup}`;
    if (needsBox(e)) c += ` --ip <box-ip> --env KEY=<ssh-key>`;
    return c;
  }
  const isInstall = (e) => e.category === "install" || e.level === "install";
  // Which setup columns a test's grid shows:
  //  - explicit per-entry `setups`                       → those;
  //  - an entry with a declared `method` (installs, or   → just that method (e.g. "test-vm"
  //    self-contained nixosTests like L2 "test-vm")         for L2, "lan-setup-0" for installs);
  //  - L3 runs the app against a box deployed per setup  → all deploy SETUPS;
  //  - otherwise a self-contained nixosTest (L1)         → a single "test-vm" column.
  function setupsFor(e) {
    if (Array.isArray(e.setups) && e.setups.length) return e.setups;
    if (e.method) return [e.method];
    if (e.level === "L3") return SETUPS;
    return ["test-vm"];
  }
  // Which column a run lands in: its --on setup if it's one of the columns, else the test's
  // primary column (so a self-contained run recorded with method "-" still shows).
  function colOf(run, cols) {
    const m = run.method;
    return (m && m !== "-" && cols.includes(m)) ? m : cols[0];
  }
  // Hover text: what a group (= level) tests, straight from the catalog `levels`.
  function groupDesc(g) {
    return (CAT.levels && CAT.levels[g]) ||
      (g === "install"
        ? "Install — provision a real backend onto a device/VM via a setup method, then verify it is reachable and correct."
        : "");
  }
  // Hover text for a ⚪ N/A cell: why this network isn't exercised here. Roadmap transports
  // (catalog `future_networks`, e.g. Yggdrasil/Hyphanet) aren't implemented yet; otherwise the
  // transport works but this particular test doesn't cover it.
  function naReason(e, nk, nlabel) {
    const future = new Set(CAT.future_networks || []);
    const base = String(nk).split("+")[0];
    if (future.has(nk) || future.has(base))
      return `${nlabel} transport isn't implemented yet — on the roadmap (catalog future_networks).`;
    return `N/A — ${e.id} doesn't exercise ${nlabel} (its networks: ${(e.networks || []).join(", ") || "none"}).`;
  }

  async function fetchFirst(paths) {
    for (const p of paths) {
      try { const r = await fetch(p, { cache: "no-store" }); if (r.ok) return await r.text(); } catch (e) {}
    }
    return "";
  }

  async function load() {
    const [catTxt, resTxt] = await Promise.all([
      fetchFirst(["catalog.json"]),
      fetchFirst(["testresults/results.jsonl", "data/results.jsonl"]),
    ]);
    try { CAT = JSON.parse(catTxt || "{}"); } catch (e) { CAT = {}; }
    const recs = resTxt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    MODEL = build(recs);
    renderStates();
    // Always show the catalog overview (every test as TODO). A selected state overlays its results.
    if (MODEL.states.length) selectState(MODEL.states[0]);
    else { SEL = null; renderTop(); renderMatrix(); }
  }

  // Each run records the state of ALL config repos in `repos[]` (name/branch/commit/dirty/diff).
  // Older records carry only the single top-level repo/commit → treated as a 1-repo state.
  function reposList(r) {
    if (Array.isArray(r.repos) && r.repos.length)
      return r.repos.map((x) => ({ name: x.name || x.repo || "?", repo: x.repo || x.name || "?", branch: x.branch || "", commit: x.commit || "?", dirty: !!x.dirty, diff: x.diff_hash || x.diff || "" }));
    return [{ name: r.repo || "?", repo: r.repo || "?", branch: r.branch || "", commit: r.commit || "?", dirty: !!r.dirty, diff: r.diff_hash || "" }];
  }
  const stateKeyOf = (r) => reposList(r).map((x) => x.name + ":" + x.commit).sort().join("|");

  // Mismatch between the local selfprivacy-api checkout and the DEPLOYED flake.lock pin:
  // the deploy builds the pinned rev, so if the api checkout differs/is dirty the api under
  // test ≠ what ran. Derived from the recorded repos[] (api commit) + pins (api rev).
  function pinMismatch(s) {
    const api = (s.repos || []).find((x) => x.name === "api" || x.repo === "selfprivacy-api");
    const pin = s.pins && s.pins["selfprivacy-api"];
    if (!api || !pin) return null;
    const a = String(api.commit || ""), p = String(pin), n = Math.min(a.length, p.length);
    if (n && a.slice(0, n) !== p.slice(0, n)) return { kind: "rev", checkout: api.commit, pin: p };
    if (api.dirty) return { kind: "dirty", checkout: api.commit, pin: p };
    return null;
  }

  // A "state" = one combination of all repo commits — i.e. exactly what was under test.
  function build(recs) {
    const smap = new Map(), byState = new Map();
    for (const r of recs) {
      const list = reposList(r), key = stateKeyOf(r);
      if (!byState.has(key)) byState.set(key, []);
      byState.get(key).push(r);
      let s = smap.get(key);
      if (!s) { s = { key, repos: list, pins: r.pins || null, ts: r.ts || "", dirty: false, n: 0 }; smap.set(key, s); }
      s.n++;
      if ((r.ts || "") > s.ts) s.ts = r.ts;
      if (list.some((x) => x.dirty)) s.dirty = true;
      if (r.pins && !s.pins) s.pins = r.pins;
      if (r.box_stamp) s.fromBox = true;        // server identity recorded from the box stamp
      if (r.box_stale) s.staleBox = true;       // a run ran against a box ≠ the code (forced)
      if (list.length > s.repos.length) s.repos = list;   // keep the richest snapshot for the combo
    }
    const states = [...smap.values()].sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    return { states, byState };
  }

  function renderStates() {
    const host = $("#commits"); host.innerHTML = "";
    if (!MODEL.states.length) { const d = document.createElement("div"); d.className = "repo"; d.textContent = "no runs yet — grid shows todo"; host.appendChild(d); return; }
    for (const s of MODEL.states) {
      const el = document.createElement("div");
      el.className = "commit"; el.dataset.key = s.key;
      const chips = s.repos.map((x) => `<span class="chip${x.dirty ? " d" : ""}" title="${esc(x.name)} @ ${esc(x.branch || "?")}${x.dirty ? " · dirty" : ""}">${esc(x.name)}:${esc(x.commit)}</span>`).join(" ");
      const pm = pinMismatch(s);
      el.innerHTML = `<div class="chips">${chips}${s.dirty ? ' <span class="dirty">⚠</span>' : ""}` +
        `${pm ? ' <span class="dirty" title="api checkout ≠ deployed pin">≠pin</span>' : ""}` +
        `${s.staleBox ? ' <span class="dirty" title="a run ran against a box that did not match the code">⚠ stale-box</span>' : ""}` +
        `${s.fromBox ? ' <span class="chip" title="server state recorded from the box stamp (source of truth)">📌 box</span>' : ""}</div>` +
        `<span class="meta">${esc(relTime(s.ts))} · ${s.n} run${s.n === 1 ? "" : "s"}</span>`;
      el.onclick = () => selectState(s);
      host.appendChild(el);
    }
  }

  function selectState(s) {
    SEL = s;
    for (const el of document.querySelectorAll(".commit")) el.classList.toggle("sel", el.dataset.key === s.key);
    renderTop(); renderMatrix();
  }

  // All repos of the selected combination (clean AND dirty) + deployed flake.lock pins.
  function configDetailsHtml() {
    const s = SEL;
    let h = `<div class="poptitle">Config under test — all repos used:</div><ul class="dirtylist">`;
    for (const x of s.repos)
      h += `<li><b>${esc(x.name)}</b> @ <span class="br">${esc(x.branch || "(unknown branch)")}</span> · <code>${esc(x.commit)}</code> ` +
        (x.dirty ? `<span class="dirty">⚠ dirty (diff ${esc(x.diff || "?")})</span>` : `<span class="muted">clean</span>`) + `</li>`;
    h += `</ul>`;
    if (s.pins && Object.keys(s.pins).length)
      h += `<div class="poptitle" style="margin-top:8px">Deployed versions (flake.lock pins):</div><ul class="dirtylist">` +
        Object.entries(s.pins).map(([k, v]) => `<li>${esc(k)} · <code>${esc(v)}</code></li>`).join("") + `</ul>`;
    if (s.fromBox) h += `<div class="poptitle" style="margin-top:8px">📌 server state recorded from the box's /etc/dev-test-build.json (the device — source of truth).</div>`;
    if (s.staleBox) h += `<div class="poptitle err" style="margin-top:8px">⚠ a run here ran against a box whose deployed state did NOT match the code (forced with --allow-dirty).</div>`;
    const pm = pinMismatch(s);
    if (pm) h += `<div class="poptitle err" style="margin-top:8px">⚠ api checkout ≠ deployed pin: ` +
      (pm.kind === "dirty" ? `checkout <code>${esc(pm.checkout)}</code> matches the pin but was DIRTY` : `checkout <code>${esc(pm.checkout)}</code> vs deployed pin <code>${esc(pm.pin)}</code>`) +
      ` — the api under test was NOT what the deploy built.</div>`;
    return h;
  }

  function renderTop() {
    const top = $("#top"); top.innerHTML = "";
    if (!SEL) {
      const m = document.createElement("span"); m.className = "subj";
      m.textContent = "Overview — no runs recorded yet; every applicable cell is ☐ todo (hover a cell for its command). Run tests, then pick a state on the left.";
      top.append(m);
      const lg0 = document.createElement("span"); lg0.className = "legend";
      lg0.textContent = "☐ todo · 🟢 pass · 🔴 fail · 🟠 slow · ⚪ N/A   (L=local · C=CI)";
      top.append(lg0);
      return;
    }
    const s = SEL;
    const chips = document.createElement("span"); chips.className = "chips";
    chips.innerHTML = s.repos.map((x) => `<span class="chip${x.dirty ? " d" : ""}">${esc(x.name)} ${esc(x.branch || "?")}@${esc(x.commit)}</span>`).join(" ");
    top.append(chips);
    if (s.pins && Object.keys(s.pins).length) {
      const p = document.createElement("span"); p.className = "pins";
      p.textContent = "deployed: " + Object.entries(s.pins).map(([k, v]) => `${k.replace("selfprivacy-", "")}@${String(v).slice(0, 8)}`).join(" · ");
      top.append(p);
    }
    const info = document.createElement("span"); info.className = "cmdbtn"; info.style.cursor = "help"; info.textContent = "ⓘ config";
    attachPop(info, configDetailsHtml);  // hover/click → every repo+branch+commit used (even clean) + pins
    top.append(info);
    if (s.dirty) {
      const w = document.createElement("span"); w.className = "warn"; w.style.cursor = "help"; w.textContent = "⚠ dirty state";
      attachPop(w, configDetailsHtml);
      top.append(w);
    }
    if (pinMismatch(s)) {
      const w = document.createElement("span"); w.className = "warn"; w.style.cursor = "help"; w.textContent = "⚠ api ≠ pin";
      attachPop(w, configDetailsHtml);
      top.append(w);
    }
    if (s.staleBox) {
      const w = document.createElement("span"); w.className = "warn"; w.style.cursor = "help"; w.textContent = "⚠ stale-box";
      attachPop(w, configDetailsHtml);
      top.append(w);
    }
    if (s.fromBox) {
      const b = document.createElement("span"); b.className = "pins"; b.title = "server state recorded from the box's stamp (source of truth)";
      b.textContent = "📌 from box stamp";
      top.append(b);
    }
    const lg = document.createElement("span"); lg.className = "legend";
    lg.textContent = "☐ todo · 🟢 pass · 🔴 fail · 🟠 slow · ⚪ N/A   (L=local · C=CI)";
    top.append(lg);
  }

  function statusClass(s) { return s === "pass" ? "pass" : s === "fail" ? "fail" : s === "slow" ? "slow" : "na"; }

  // Results for the SELECTED state, grouped by test id. Empty when no state selected.
  function resultsByTest() {
    const idx = new Map();
    if (!SEL) return idx;
    for (const r of (MODEL.byState.get(SEL.key) || [])) {
      if (!idx.has(r.id)) idx.set(r.id, []);
      idx.get(r.id).push(r);
    }
    return idx;
  }

  // The matrix is CATALOG-driven: every test is shown as the overview (☐ todo per applicable
  // network×setup×host), with results from the selected state overlaid on top. Columns are
  // PER TEST (setupsFor): self-contained nixosTests (L1/L2) get a single "test-vm" column,
  // L3 gets the deploy setups, an install gets its own method.
  function renderMatrix() {
    CELLS = [];
    const RES = resultsByTest();
    const entries = [...(CAT.tests || []), ...(CAT.installs || [])];
    const groups = new Map();
    for (const e of entries) {
      const g = e.group || e.level || e.category || "misc";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
    const host = $("#matrix"); host.innerHTML = "";
    if (!entries.length) { host.innerHTML = '<p class="muted" style="padding:16px">catalog.json has no tests.</p>'; return; }
    for (const [g, ents] of [...groups.entries()].sort()) {
      ents.sort((a, b) => a.id.localeCompare(b.id));
      const gd = document.createElement("details"); gd.className = "group"; gd.open = true;
      const gsum = document.createElement("summary");
      gsum.innerHTML = `<span class="caret">▶</span><span title="${esc(groupDesc(g))}">${esc(g)}</span><span class="count">${ents.length}</span>`;
      const gcmd = mkCmdBtn("run group"); attachCmd(gcmd, `./dash run ${ents.map((e) => e.id).join(" ")}`); gsum.appendChild(gcmd);
      gd.appendChild(gsum);
      for (const e of ents) {
        const td = document.createElement("details"); td.className = "test";
        const tsum = document.createElement("summary");
        tsum.innerHTML = `<span class="caret">▶</span><span class="tname" title="${esc(e.desc || "")}">${esc(e.id)}</span>`;
        const tcmd = mkCmdBtn("run"); attachCmd(tcmd, cmdFor(e, (e.networks || [])[0] || "", "<setup>")); tsum.appendChild(tcmd);
        const built = buildGrid(e, RES.get(e.id) || []);
        const roll = document.createElement("span"); roll.className = "roll"; roll.innerHTML = built.counts; tsum.appendChild(roll);
        td.appendChild(tsum);
        const wrap = document.createElement("div"); wrap.className = "mtx"; wrap.appendChild(built.el);
        td.appendChild(wrap);
        gd.appendChild(td);
      }
      host.appendChild(gd);
    }
  }

  function buildGrid(e, runs) {
    const supported = new Set(e.networks || []);
    const hasNet = supported.size > 0;
    const cols = setupsFor(e);
    // bucket this test's runs into the grid by net|column|host (newest first). colOf maps a
    // setup-less run (method "-", e.g. a self-contained L1/L2 nixosTest) to the primary column,
    // so a recorded pass always lands in a cell instead of being orphaned.
    const buckets = new Map();
    for (const r of runs) {
      const k = netOf(r) + "|" + colOf(r, cols) + "|" + hostOf(r);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    for (const a of buckets.values()) a.sort((x, y) => (y.ts || "").localeCompare(x.ts || ""));
    const rows = hasNet ? NETWORKS : [["", isInstall(e) ? "(deploy)" : "(any)"]];
    let p = 0, f = 0, s = 0, todo = 0;
    const tbl = document.createElement("table"); tbl.className = "grid";
    let head = '<thead><tr><th class="net"></th>';
    for (const col of cols) head += `<th>${esc(col)}</th>`;
    // sub-header: each setup column holds two dots (local, then CI) — label the split.
    head += '</tr><tr><th class="net"></th>';
    for (const col of cols) head += `<th class="sub">local · ci</th>`;
    head += "</tr></thead>";
    let body = "<tbody>";
    for (const [nk, nlabel] of rows) {
      body += `<tr><th class="net">${esc(nlabel)}</th>`;
      for (const col of cols) {
        body += '<td><span class="cell">';
        for (const [hk, hl] of HOSTS) {
          const rr = buckets.get(nk + "|" + col + "|" + hk) || [];
          if (rr.length) {
            const idx = CELLS.push({ id: e.id, net: nk, setup: col, host: hk, runs: rr, cmd: cmdFor(e, nk, col) }) - 1;
            const st = statusClass(rr[0].status);
            if (st === "pass") p++; else if (st === "fail") f++; else if (st === "slow") s++;
            const n = rr.length > 1 ? `<span class="n">${rr.length}</span>` : "";
            body += `<span class="dot ${st}" data-cell="${idx}" title="${esc(hl)}: ${esc(rr[0].status)} · ${esc(relTime(rr[0].ts))} · click for history">${n}</span>`;
          } else {
            const applicable = !hasNet || supported.has(nk);
            if (applicable) {
              todo++;
              const idx = CELLS.push({ id: e.id, net: nk, setup: col, host: hk, runs: [], cmd: cmdFor(e, nk, col) }) - 1;
              body += `<span class="dot todo" data-cell="${idx}" title="${esc(hl)}: todo — hover for the command"></span>`;
            } else {
              body += `<span class="dot na" title="${esc(naReason(e, nk, nlabel))}"></span>`;
            }
          }
        }
        body += "</span></td>";
      }
      body += "</tr>";
    }
    body += "</tbody>";
    tbl.innerHTML = head + body;
    tbl.addEventListener("mouseover", (ev) => {
      const d = ev.target.closest(".dot[data-cell]"); if (!d) return;
      const c = CELLS[+d.dataset.cell]; if (c && c.cmd) showPop(d, `<button class="copy" data-cmd="${esc(c.cmd)}">copy</button><pre>${esc(c.cmd)}</pre>`);
    });
    tbl.addEventListener("mouseout", (ev) => { if (ev.target.closest(".dot[data-cell]")) popTimer = setTimeout(() => { pop.style.display = "none"; }, 300); });
    tbl.addEventListener("click", (ev) => {
      const d = ev.target.closest(".dot[data-cell]"); if (!d) return;
      const c = CELLS[+d.dataset.cell]; if (c && c.runs.length) openCell(+d.dataset.cell);
    });
    const counts = `<span title="pass">🟢${p}</span> <span title="fail">🔴${f}</span> <span title="slow">🟠${s}</span> <span title="todo">☐${todo}</span>`;
    return { el: tbl, counts };
  }

  // ---- shared hover/click popover (commands with copy, dirty-state details, …) ----
  const pop = $("#pop"); let popTimer = null;
  function mkCmdBtn(label) { const b = document.createElement("span"); b.className = "cmdbtn"; b.textContent = "⌘ " + label; return b; }
  function showPop(el, html) {
    clearTimeout(popTimer);
    pop.innerHTML = html;
    const r = el.getBoundingClientRect();
    pop.style.display = "block";
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)) + "px";
    pop.style.top = (r.bottom + 6) + "px";
  }
  function attachPop(el, html) {
    const get = () => (typeof html === "function" ? html() : html);
    el.addEventListener("mouseenter", () => showPop(el, get()));
    el.addEventListener("click", (e) => { e.preventDefault(); showPop(el, get()); });
    el.addEventListener("mouseleave", () => { popTimer = setTimeout(() => { pop.style.display = "none"; }, 300); });
  }
  function attachCmd(el, cmd) { attachPop(el, `<button class="copy" data-cmd="${esc(cmd)}">copy</button><pre>${esc(cmd)}</pre>`); }
  pop.addEventListener("mouseenter", () => clearTimeout(popTimer));
  pop.addEventListener("mouseleave", () => { pop.style.display = "none"; });
  pop.addEventListener("click", (e) => { const b = e.target.closest(".copy"); if (b && b.dataset.cmd != null) { navigator.clipboard.writeText(b.dataset.cmd); b.textContent = "copied ✓"; } });

  // ---- detail drawer: a config's run history on this commit ----
  function openCell(idx) {
    const c = CELLS[idx]; if (!c) return;
    const netLabel = (NETWORKS.find((n) => n[0] === c.net) || [c.net, c.net || "(no network)"])[1];
    $("#dtitle").textContent = `${c.id} · ${netLabel} · ${c.setup} · ${c.host.toUpperCase()}`;
    const cmd = `./dash run ${c.id}` + (c.net ? ` --net ${c.net}` : "") + ` --on ${c.setup}`;
    let h = `<div style="position:relative;margin-bottom:10px"><button class="copy" style="position:absolute;top:0;right:0" onclick="navigator.clipboard.writeText(this.nextElementSibling.textContent)">copy</button><pre style="white-space:pre-wrap;margin:0;padding-right:48px">${esc(cmd)}</pre></div>`;
    h += `<p class="muted">${c.runs.length} run(s) on ${esc(SEL.repo)}@${esc(SEL.commit)}, newest first:</p>`;
    c.runs.forEach((r, i) => {
      h += `<details class="run" ${i === 0 ? "open" : ""} data-run="${idx}:${i}">` +
        `<summary><span class="dot ${statusClass(r.status)}"></span><b>${esc(r.status)}</b>` +
        `<span class="rmeta">${esc(r.ts)} · ${esc(relTime(r.ts))} · ${esc(r.duration_s)}s · exit ${esc(r.exit_code)} · ${esc(r.host || "")}</span></summary>` +
        `<div class="rbody">${r.error ? `<div class="err">${esc(r.error)}</div>` : ""}<div class="lazy muted">opening…</div></div></details>`;
    });
    const db = $("#dbody"); db.innerHTML = h;
    db.querySelectorAll("details.run").forEach((d) => {
      const [ci, ri] = d.dataset.run.split(":").map(Number);
      const r = CELLS[ci].runs[ri];
      const fill = () => { if (d.dataset.filled) return; d.dataset.filled = "1"; fillRun(d.querySelector(".rbody"), r); };
      if (d.open) fill();
      d.addEventListener("toggle", () => { if (d.open) fill(); });
    });
    $("#drawer").classList.add("open");
  }

  async function fillRun(box, r) {
    const a = r.artifacts || {};
    let h = "";
    // log
    const logPath = r.log_path || a.client_log;
    if (logPath && !IS_PAGES) {
      try { const t = await fetch(logPath, { cache: "no-store" }).then((x) => (x.ok ? x.text() : "")); h += `<pre class="log">${esc(t || "(empty log)")}</pre>`; }
      catch (e) { h += `<p class="muted">log: ${esc(logPath)} (fetch failed)</p>`; }
    } else if (logPath) { h += `<p class="muted">log: ${esc(logPath)} — run the dashboard locally to view</p>`; }
    // screenshots (local hosting only)
    const shots = a.screenshots || [];
    if (shots.length) {
      h += IS_PAGES ? `<p class="muted">📷 ${shots.length} screenshot(s) — run locally to view</p>`
        : `<div class="shots">` + shots.map((p) => `<a href="${esc(p)}" target="_blank"><img loading="lazy" src="${esc(p)}"></a>`).join("") + `</div>`;
    }
    // video (local only, never committed)
    if (a.video) {
      h += IS_PAGES ? `<p class="muted">▶ video — local artifact, run locally to view</p>`
        : `<p><a href="${esc(a.video)}" target="_blank">▶ play recording</a></p>`;
    }
    if (a.server_log && !IS_PAGES) h += `<p><a href="${esc(a.server_log)}" target="_blank">server log</a></p>`;
    box.querySelector(".lazy").outerHTML = h || `<p class="muted">no log/media recorded</p>`;
  }

  load();
})();
