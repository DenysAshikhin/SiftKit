// Variant C — Workbench. Dense single-screen console: everything visible at once.
import {
  D, tiers, totalDocs, totalTokens, totalLimit, imageJobs, projJobs, cand, conf,
  num, pct1, esc, ago, dupes, tierTone, page, topbar, here, writeFileSync,
} from './build.mjs';

const css = `
body{font-size:13px}
.grid{display:grid;gap:1px;background:var(--line);height:calc(100vh - 53px);
  grid-template-columns:290px 1fr 1fr 300px;grid-template-rows:auto 1fr auto}
.cell{background:var(--bg);padding:13px 15px;overflow:auto;min-height:0}
.cell.k{background:var(--panel)}
.span2{grid-column:span 2}
.cmd{grid-column:1/-1;display:flex;align-items:center;gap:11px;background:var(--panel);padding:9px 15px}
.cmd input{flex:1;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:8px 12px;
  color:var(--fg);font-family:var(--mono);font-size:12.5px}
.cmd input:focus{outline:none;border-color:var(--accent)}
.cmd .kbd{font-family:var(--mono);font-size:10px;color:var(--dim);border:1px solid var(--line);
  padding:2px 6px;border-radius:4px}
.mt{display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:center;margin-bottom:9px;
  font-family:var(--mono);font-size:11.5px}
.mt .lbl{width:56px;color:var(--dim)}
.mt .tr{height:14px;background:var(--panel2);border-radius:3px;overflow:hidden;position:relative}
.mt .tr i{display:block;height:100%;background:var(--accent)}
.mt .tr i.warn{background:var(--warn)}
.mt .tr b{position:absolute;right:5px;top:0;line-height:14px;font-size:9.5px;color:var(--fg);
  text-shadow:0 0 4px var(--bg)}
.mt .vv{width:74px;text-align:right}
.treemap{display:flex;flex-wrap:wrap;gap:2px;margin-top:10px;align-content:flex-start}
.tm{border-radius:2px;background:var(--accent);opacity:.28;position:relative}
.tm.hot{opacity:.95}
.tm.mid{opacity:.55}
.tm:hover{outline:1px solid var(--fg);opacity:1}
.kv{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid var(--line)}
.kv:last-child{border:0}
.kv span{color:var(--dim)}
.kv b{font-family:var(--mono)}
.kv b.bad{color:var(--bad)} .kv b.warn{color:var(--warn)} .kv b.ok{color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:12px;font-family:var(--mono)}
th{text-align:left;color:var(--dim);font-weight:500;font-size:10px;text-transform:uppercase;
  letter-spacing:.6px;padding-bottom:6px;position:sticky;top:-13px;background:var(--bg)}
.cell.k th{background:var(--panel)}
td{padding:4px 0;border-top:1px solid rgba(30,45,61,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
td.r{text-align:right;color:var(--dim)}
tr:hover td{color:var(--fg);background:var(--panel2)}
.nm{max-width:1px;width:99%}
.spark{display:flex;align-items:flex-end;gap:2px;height:34px;margin:9px 0}
.spark i{flex:1;background:var(--blue);border-radius:1px;min-height:2px;opacity:.8}
.spark i.dead{background:var(--bad)}
.hd{font-size:10px;text-transform:uppercase;letter-spacing:.9px;color:var(--dim);margin-bottom:10px;
  display:flex;align-items:center;gap:8px}
.hd .n{margin-left:auto;font-family:var(--mono);color:var(--fg);font-size:11px}
.hd .warn{color:var(--warn)}
.chip{font-size:9.5px;padding:1px 6px;border-radius:99px;border:1px solid var(--line);color:var(--dim);
  font-family:var(--mono)}
.chip.bad{color:var(--bad);border-color:var(--bad)}
.chip.warn{color:var(--warn);border-color:var(--warn)}
.chip.ok{color:var(--accent);border-color:var(--accent)}
.foot{grid-column:1/-1;background:var(--panel);display:flex;gap:20px;align-items:center;
  padding:7px 15px;font-family:var(--mono);font-size:11px;color:var(--dim)}
.foot b{color:var(--fg)}
.foot .sp{flex:1}
.act{font-size:10.5px;padding:3px 9px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);
  color:var(--dim);cursor:pointer;font-family:inherit}
.act:hover{color:var(--fg);border-color:var(--accent)}
.act.warn{color:var(--warn);border-color:var(--warn)}
`;

// Token-allocation treemap: one tile per Tier 3 doc, area ∝ tokens.
const t3 = D.projections.archiveCandidates;
const tiles = [
  ...D.projections.largest.map((p) => ({ ...p, hot: p.retrieval_count > 0 })),
  ...Array.from({ length: 46 }, (_, i) => ({
    title: `tier3 doc ${i + 9}`, token_count: 90 + ((i * 37) % 240), retrieval_count: 0, hot: false,
  })),
];
const maxTok = Math.max(...tiles.map((t) => t.token_count));

const dayCounts = [428, 324, 0, 0, 0, 49, 5, 10];
const maxDay = Math.max(...dayCounts);

const body = `
${topbar('workbench', 'dense console')}
<div class="grid">

  <div class="cmd">
    <span class="chip ok">memory</span>
    <input placeholder="&gt; search, correct, merge, forget…   try: forget league of legends"
      onkeydown="if(event.key==='Enter'){dockOpen(true);ask(this.value);this.value=''}">
    <span class="kbd">⌘K</span>
    <span class="chip ${tierTone(tiers[2])}">T3 ${pct1(tiers[2].pct)}</span>
    <span class="chip bad">${imageJobs.dead_letter} dead</span>
    <span class="chip warn">${num(cand.pending)} pending</span>
  </div>

  <div class="cell k">
    <div class="hd">Capacity <span class="n">${totalDocs}/${totalLimit}</span></div>
    ${tiers.map((t) => `
      <div class="mt">
        <span class="lbl">T${t.tier} ${t.label.slice(0, 4).toLowerCase()}</span>
        <div class="tr"><i class="${tierTone(t) === 'warn' ? 'warn' : ''}" style="width:${Math.min(100, t.pct)}%"></i>
          <b>${pct1(t.pct)}</b></div>
        <span class="vv">${t.n}/${t.limit}</span>
      </div>`).join('')}

    <div class="hd" style="margin-top:18px">Token budget <span class="n">${num(totalTokens)}</span></div>
    ${tiers.map((t) => `
      <div class="mt">
        <span class="lbl">T${t.tier}</span>
        <div class="tr"><i style="width:${(t.tokens / totalTokens) * 100}%"></i></div>
        <span class="vv">${num(t.tokens)}</span>
      </div>`).join('')}

    <div class="hd" style="margin-top:18px">Graph <span class="n">v${num(D.projections.graphVersion)}</span></div>
    <div class="kv"><span>entities</span><b>${num(D.nodes.active)}</b></div>
    <div class="kv"><span>beliefs</span><b>${num(D.assertions.active)}</b></div>
    <div class="kv"><span>pinned</span><b class="${D.assertions.pinned ? '' : 'bad'}">${D.assertions.pinned}</b></div>
    <div class="kv"><span>evidence</span><b>${num(D.evidence.n)}</b></div>
    <div class="kv"><span>observations</span><b>${num(D.observations)}</b></div>
    <div class="kv"><span>duplicates</span><b class="warn">${dupes.length}</b></div>
    <div class="kv"><span>chars/token</span><b>${D.budget.last_known_chars_per_token.toFixed(3)}</b></div>
    <div class="kv"><span>last rebuild</span><b>${ago(tiers[2].newest)}</b></div>
  </div>

  <div class="cell">
    <div class="hd">Token allocation · Tier 3 <span class="n">${num(tiers[2].tokens)} tok / ${tiers[2].n} docs</span></div>
    <div class="note">Area &prop; tokens. Bright = retrieved at least once.
      <b style="color:var(--bad)">${pct1(((tiers[2].n - 3) / tiers[2].n) * 100)} has never been read.</b></div>
    <div class="treemap">
      ${tiles.map((t) => {
        const side = 16 + Math.round((t.token_count / maxTok) * 40);
        return `<div class="tm ${t.hot ? 'hot' : t.token_count > 200 ? 'mid' : ''}"
          style="width:${side}px;height:${side}px"
          title="${esc(t.title)} — ${t.token_count} tok, ${t.retrieval_count} retrievals"></div>`;
      }).join('')}
    </div>
  </div>

  <div class="cell">
    <div class="hd">Archive queue <span class="n warn">${tiers[2].limit - tiers[2].n} slots left</span></div>
    <div class="note" style="margin-bottom:9px">Evicted first when Tier 3 fills.</div>
    <table>
      <tr><th class="nm">Document</th><th class="r">Tok</th><th class="r">Used</th><th class="r">Built</th></tr>
      ${t3.slice(0, 10).map((p) => `
      <tr><td class="nm">${esc(p.title)}</td><td class="r">${p.token_count}</td>
        <td class="r" style="color:${p.retrieval_count ? 'var(--accent)' : 'var(--bad)'}">${p.retrieval_count}</td>
        <td class="r">${p.generated_at_utc.slice(5, 10)}</td></tr>`).join('')}
    </table>
    <button class="act warn" style="margin-top:11px" onclick="dockOpen(true);ask('Free up Tier 3 space')">Archive lowest 12</button>
    <button class="act" style="margin-top:11px">Raise limit</button>
  </div>

  <div class="cell k">
    <div class="hd">Pipeline</div>
    <div class="kv"><span>image extract</span><b class="ok">${num(imageJobs.completed)} done</b></div>
    <div class="kv"><span>&nbsp;&nbsp;queued</span><b class="warn">${imageJobs.queued}</b></div>
    <div class="kv"><span>&nbsp;&nbsp;dead letter</span><b class="bad">${imageJobs.dead_letter}</b></div>
    <div class="spark">
      ${dayCounts.map((v, i) => `<i class="${i === 2 ? 'dead' : ''}" style="height:${Math.max(4, (v / maxDay) * 100)}%"
        title="${v} extractions"></i>`).join('')}
    </div>
    <div class="note">8-day throughput. Red = the 2026-09-03 failure window.</div>

    <div class="hd" style="margin-top:16px">Projection maint.</div>
    <div class="kv"><span>completed</span><b>${projJobs.completed}</b></div>
    <div class="kv"><span>cancelled</span><b class="warn">${projJobs.cancelled}</b></div>
    <div class="kv"><span>queued</span><b>${projJobs.queued ?? 0}</b></div>

    <div class="hd" style="margin-top:16px">Review backlog</div>
    <div class="kv"><span>accepted</span><b class="ok">${num(cand.accepted)}</b></div>
    <div class="kv"><span>pending</span><b class="warn">${num(cand.pending)}</b></div>
    <div class="kv"><span>needs confirm</span><b>${cand.needs_confirmation}</b></div>
    <div class="kv"><span>rejected</span><b>${cand.rejected}</b></div>
    <button class="act" style="margin-top:11px" onclick="dockOpen(true);ask('Review pending beliefs')">Review queue</button>
  </div>

  <div class="cell span2">
    <div class="hd">Entities by connectedness <span class="n">${num(D.nodes.active)} active</span></div>
    <table>
      <tr><th class="nm">Entity</th><th>Type</th><th class="r">Beliefs</th><th class="r">First seen</th><th class="r"></th></tr>
      ${D.topNodes.map((n) => `
      <tr><td class="nm">${esc(n.display_name)}</td>
        <td style="color:var(--dim)">${esc(n.type.replace(/_/g, ' '))}</td>
        <td class="r" style="color:var(--fg)">${n.deg}</td>
        <td class="r">${n.created_at_utc.slice(0, 10)}</td>
        <td class="r">${dupes.flat().some((d) => d.id === n.id) ? '<span class="chip warn">dup</span>' : ''}</td></tr>`).join('')}
    </table>
  </div>

  <div class="cell">
    <div class="hd">Newest beliefs</div>
    <table>
      ${D.recentAssertions.slice(0, 11).map((a) => `
      <tr><td class="nm">${esc(a.subj ?? '—')} <span style="color:var(--blue)">${esc(a.predicate)}</span> ${esc(a.obj)}</td>
        <td class="r" style="color:${a.confidence >= 0.5 ? 'var(--accent)' : 'var(--bad)'}">${a.confidence.toFixed(2)}</td></tr>`).join('')}
    </table>
    <div class="note" style="margin-top:9px">
      Promoted today, but observed <b style="color:var(--warn)">~1.5 d ago</b> — decay is measured from
      observation, so these arrive pre-decayed.
    </div>
  </div>

  <div class="cell">
    <div class="hd">Composition</div>
    ${D.nodes.byType.slice(0, 6).map((t) => `
      <div class="mt"><span class="lbl" style="width:78px">${esc(t.type.slice(0, 9))}</span>
        <div class="tr" style="height:9px"><i style="width:${(t.n / D.nodes.byType[0].n) * 100}%"></i></div>
        <span class="vv" style="width:40px">${t.n}</span></div>`).join('')}
    <div class="hd" style="margin-top:14px">Confidence</div>
    ${[['high', conf.high, 'var(--accent)'], ['medium', conf.medium, 'var(--blue)'],
      ['unscored', conf.unscored, 'var(--bad)']].map(([k, v, c]) => `
      <div class="mt"><span class="lbl" style="width:78px">${k}</span>
        <div class="tr" style="height:9px"><i style="width:${(v / D.assertions.active) * 100}%;background:${c}"></i></div>
        <span class="vv" style="width:40px">${num(v)}</span></div>`).join('')}
    <div class="note" style="margin-top:9px">
      ${pct1((conf.unscored / D.assertions.active) * 100)} unscored ·
      ${D.assertions.byBasis.find((b) => b.basis === 'explicit_user_statement')?.n ?? 0} stated by you
    </div>
  </div>

  <div class="foot">
    <span>owner <b>own_local</b></span>
    <span>graph <b>v${num(D.projections.graphVersion)}</b></span>
    <span>docs <b>${totalDocs}/${totalLimit}</b></span>
    <span>tokens <b>${num(totalTokens)}</b></span>
    <span>evidence <b>${num(D.evidence.n)}</b></span>
    <div class="sp"></div>
    <button class="act" onclick="dockOpen(true)">Memory assistant</button>
    <span>snapshot <b>${D.capturedAtUtc.slice(0, 16).replace('T', ' ')}Z</b></span>
  </div>
</div>`;

writeFileSync(new URL('variant-c-workbench.html', here), page('Memory · Workbench mockup', css, body));
