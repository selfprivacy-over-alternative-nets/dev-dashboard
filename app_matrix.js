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

  let MODEL = null, SEL = null, CELLS = [];

  async function fetchFirst(paths) {
    for (const p of paths) {
      try { const r = await fetch(p, { cache: "no-store" }); if (r.ok) return await r.text(); } catch (e) {}
    }
    return "";
  }

  async function load() {
    const resTxt = await fetchFirst(["testresults/results.jsonl", "data/results.jsonl"]);
    const recs = resTxt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    MODEL = build(recs);
    renderCommits();
    if (MODEL.commits.length) selectCommit(MODEL.commits[0]);
    else $("#matrix").innerHTML = '<p class="muted" style="padding:16px">No results yet. Run a test, then <code>./dash publish</code>.</p>';
  }

  function build(recs) {
    const cmap = new Map();
    for (const r of recs) {
      const key = (r.repo || "?") + "@" + (r.commit || "?");
      let c = cmap.get(key);
      if (!c) { c = { key, repo: r.repo || "?", branch: r.branch || "", commit: r.commit || "?", subject: r.subject || "", ts: r.ts || "", dirty: false, n: 0 }; cmap.set(key, c); }
      c.n++;
      if ((r.ts || "") > c.ts) c.ts = r.ts;
      if (r.dirty) c.dirty = true;
      if (!c.subject && r.subject) c.subject = r.subject;
      if (!c.branch && r.branch) c.branch = r.branch;
    }
    const commits = [...cmap.values()].sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    const byCommit = new Map();
    for (const r of recs) {
      const k = (r.repo || "?") + "@" + (r.commit || "?");
      if (!byCommit.has(k)) byCommit.set(k, []);
      byCommit.get(k).push(r);
    }
    return { commits, byCommit };
  }

  function renderCommits() {
    // group commits by repo → branch, preserving the (newest-first) order
    const host = $("#commits"); host.innerHTML = "";
    const seenRepo = new Set(), seenBranch = new Set();
    for (const c of MODEL.commits) {
      if (!seenRepo.has(c.repo)) { seenRepo.add(c.repo); const d = document.createElement("div"); d.className = "repo"; d.textContent = c.repo; host.appendChild(d); }
      const bk = c.repo + "/" + (c.branch || "?");
      if (!seenBranch.has(bk)) { seenBranch.add(bk); const d = document.createElement("div"); d.className = "branch"; d.textContent = "⎇ " + (c.branch || "(unknown branch)"); host.appendChild(d); }
      const el = document.createElement("div");
      el.className = "commit"; el.dataset.key = c.key;
      el.innerHTML = `<span class="sha">${esc(c.commit)}</span>${c.dirty ? ' <span class="dirty" title="a run on this commit saw uncommitted changes">⚠ dirty</span>' : ""}` +
        `<span class="subj">${esc(c.subject || "(no subject)")}</span>` +
        `<span class="meta">${esc(relTime(c.ts))} · ${c.n} run${c.n === 1 ? "" : "s"}</span>`;
      el.onclick = () => selectCommit(c);
      host.appendChild(el);
    }
  }

  function selectCommit(c) {
    SEL = c;
    for (const el of document.querySelectorAll(".commit")) el.classList.toggle("sel", el.dataset.key === c.key);
    renderTop(); renderMatrix();
  }

  function dirtyDetailsHtml() {
    const recs = (MODEL.byCommit.get(SEL.key) || []).filter((r) => r.dirty);
    if (!recs.length) return `<div class="muted">No dirty runs recorded on this commit.</div>`;
    const m = new Map();
    for (const r of recs) {
      const k = (r.repo || "?") + "|" + (r.branch || "?") + "|" + (r.diff_hash || "?");
      let e = m.get(k);
      if (!e) { e = { repo: r.repo || "?", branch: r.branch || "(unknown branch)", diff: r.diff_hash || "?", ids: new Set(), ts: "" }; m.set(k, e); }
      e.ids.add(r.id); if ((r.ts || "") > e.ts) e.ts = r.ts;
    }
    let h = `<div class="poptitle">Uncommitted changes recorded during runs on <code>${esc(SEL.commit)}</code>:</div><ul class="dirtylist">`;
    for (const e of m.values())
      h += `<li><b>${esc(e.repo)}</b> @ <span class="br">${esc(e.branch)}</span> · diff <code>${esc(e.diff)}</code> — ${e.ids.size} test(s): ${esc([...e.ids].join(", "))} <span class="muted">(${esc(relTime(e.ts))})</span></li>`;
    h += `</ul>`;
    return h;
  }

  function renderTop() {
    const c = SEL, top = $("#top"); top.innerHTML = "";
    const sha = document.createElement("span"); sha.className = "sha"; sha.textContent = `${c.repo} @ ${c.commit}`;
    const subj = document.createElement("span"); subj.className = "subj"; subj.textContent = c.subject || "";
    top.append(sha, subj);
    if (c.dirty) {
      const w = document.createElement("span"); w.className = "warn"; w.style.cursor = "help";
      w.textContent = "⚠ dirty state";
      attachPop(w, dirtyDetailsHtml);   // hover or click → which repo/branch/diff was dirty
      top.append(w);
    }
    const lg = document.createElement("span"); lg.className = "legend";
    lg.textContent = "🟢 pass · 🔴 fail · 🟠 slow · ⚪ N/A   (L=local · C=CI)";
    top.append(lg);
  }

  function statusClass(s) { return s === "pass" ? "pass" : s === "fail" ? "fail" : s === "slow" ? "slow" : "na"; }

  function renderMatrix() {
    const recs = MODEL.byCommit.get(SEL.key) || [];
    CELLS = [];
    // group → test(id) → records
    const groups = new Map();
    for (const r of recs) {
      const g = groupOf(r);
      if (!groups.has(g)) groups.set(g, new Map());
      const t = groups.get(g);
      if (!t.has(r.id)) t.set(r.id, []);
      t.get(r.id).push(r);
    }
    // setup columns = canonical + any extra method seen (legacy lan-setup-0, usb, …)
    const extra = [...new Set(recs.map((r) => r.method).filter((m) => m && m !== "-" && !SETUPS.includes(m)))];
    const setupCols = [...SETUPS, ...extra];

    const host = $("#matrix"); host.innerHTML = "";
    if (!recs.length) { host.innerHTML = '<p class="muted" style="padding:16px">No runs recorded on this commit.</p>'; return; }

    for (const [g, tests] of [...groups.entries()].sort()) {
      const gd = document.createElement("details"); gd.className = "group"; gd.open = true;
      const ids = [...tests.keys()];
      const gsum = document.createElement("summary");
      gsum.innerHTML = `<span class="caret">▶</span><span>${esc(g)}</span><span class="count">${ids.length} test${ids.length === 1 ? "" : "s"}</span>`;
      const gcmd = mkCmdBtn("run group"); attachCmd(gcmd, `./dash run ${ids.join(" ")}`); gsum.appendChild(gcmd);
      gd.appendChild(gsum);

      for (const [id, trecs] of [...tests.entries()].sort()) {
        const td = document.createElement("details"); td.className = "test";
        const tsum = document.createElement("summary");
        const roll = rollup(trecs);
        tsum.innerHTML = `<span class="caret">▶</span><span class="tname">${esc(id)}</span>`;
        const tcmd = mkCmdBtn("run test"); attachCmd(tcmd, `./dash run ${id}`); tsum.appendChild(tcmd);
        const r = document.createElement("span"); r.className = "roll"; r.innerHTML = roll; tsum.appendChild(r);
        td.appendChild(tsum);

        const wrap = document.createElement("div"); wrap.className = "mtx";
        wrap.appendChild(buildGrid(id, trecs, setupCols));
        td.appendChild(wrap);
        gd.appendChild(td);
      }
      host.appendChild(gd);
    }
  }

  function rollup(recs) {
    let p = 0, f = 0, s = 0;
    const seen = new Map(); // latest per net|setup|host
    for (const r of recs) {
      const k = netOf(r) + "|" + (r.method || "") + "|" + hostOf(r);
      const cur = seen.get(k);
      if (!cur || (r.ts || "") > (cur.ts || "")) seen.set(k, r);
    }
    for (const r of seen.values()) { if (r.status === "pass") p++; else if (r.status === "fail") f++; else if (r.status === "slow") s++; }
    return `<span title="pass">🟢${p}</span> <span title="fail">🔴${f}</span> <span title="slow">🟠${s}</span>`;
  }

  function buildGrid(id, recs, setupCols) {
    // bucket: net|setup|host → runs[] (newest first)
    const buckets = new Map();
    let anyNet = false;
    for (const r of recs) {
      const net = netOf(r); if (net) anyNet = true;
      const k = net + "|" + (r.method || "") + "|" + hostOf(r);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    for (const arr of buckets.values()) arr.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

    const rows = anyNet ? NETWORKS : [["", "(no network)"]];
    const tbl = document.createElement("table"); tbl.className = "grid";
    let head = '<thead><tr><th class="net"></th>';
    for (const s of setupCols) head += `<th>${esc(s)}</th>`;
    head += "</tr></thead>";
    let body = "<tbody>";
    for (const [nk, nlabel] of rows) {
      body += `<tr><th class="net">${esc(nlabel)}</th>`;
      for (const s of setupCols) {
        body += "<td><span class=\"cell\">";
        for (const [hk, hl] of HOSTS) {
          const runs = buckets.get(nk + "|" + s + "|" + hk) || [];
          if (!runs.length) { body += `<span class="dot na" title="${esc(hl)}: N/A"></span>`; continue; }
          const idx = CELLS.push({ id, net: nk, setup: s, host: hk, runs }) - 1;
          const st = statusClass(runs[0].status);
          const n = runs.length > 1 ? `<span class="n">${runs.length}</span>` : "";
          body += `<span class="dot ${st}" data-cell="${idx}" title="${esc(hl)}: ${esc(runs[0].status)} · ${esc(relTime(runs[0].ts))} · click for history">${n}</span>`;
        }
        body += "</span></td>";
      }
      body += "</tr>";
    }
    body += "</tbody>";
    tbl.innerHTML = head + body;
    tbl.addEventListener("click", (e) => {
      const d = e.target.closest(".dot[data-cell]"); if (d) openCell(+d.dataset.cell);
    });
    return tbl;
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
