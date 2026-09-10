// Variant A — Dashboard. Overview-first: capacity, composition, pipeline health.
import {
  D, tiers, totalDocs, totalTokens, totalLimit, imageJobs, projJobs, cand, conf,
  num, pct1, esc, ago, dupes, tierTone, page, topbar, here, writeFileSync,
  digestCss, digestHtml, digestJs,
} from './build.mjs';

const css = `
.wrap{max-width:1280px;margin:0 auto;padding:22px}
.hero{display:grid;grid-template-columns:1.35fr 1fr;gap:16px;margin-bottom:16px}
.gauges{display:flex;flex-direction:column;gap:15px}
.gauge{display:grid;grid-template-columns:74px 1fr auto;gap:13px;align-items:center}
.gauge .tname{font-weight:650;font-size:13px}
.gauge .tname small{display:block;color:var(--dim);font-weight:400;font-size:10.5px;letter-spacing:.4px}
.gauge .track{height:11px;border-radius:99px;background:var(--panel2);overflow:hidden;position:relative}
.gauge .track i{display:block;height:100%;border-radius:99px;background:var(--accent)}
.gauge .track i.warn{background:var(--warn)}
.gauge .cnt{font-family:var(--mono);font-size:12.5px;min-width:104px;text-align:right}
.gauge .cnt b{font-size:15px}
.gauge .cnt span{color:var(--dim)}
.totals{display:flex;gap:22px;margin-top:16px;padding-top:15px;border-top:1px solid var(--line)}
.totals div{font-family:var(--mono);font-size:12px;color:var(--dim)}
.totals b{display:block;font-size:19px;color:var(--fg);margin-bottom:1px}
.alert{border:1px solid var(--warn);border-radius:10px;background:rgba(232,176,75,.07);padding:12px 14px;margin-top:15px}
.alert h4{margin:0 0 5px;font-size:12.5px;color:var(--warn);display:flex;align-items:center;gap:7px}
.alert p{margin:0 0 10px;font-size:12px;color:var(--dim);line-height:1.6}
.alert .acts{display:flex;gap:8px}
.btn{padding:6px 12px;border-radius:7px;font-size:12px;cursor:pointer;border:1px solid var(--line);
  background:var(--panel2);color:var(--fg);font-weight:550}
.btn:hover{border-color:var(--accent)}
.btn.go{background:var(--warn);color:#1b1203;border-color:var(--warn);font-weight:650}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:11px;align-content:start}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:13px 14px}
.stat b{display:block;font-size:23px;font-family:var(--mono);letter-spacing:-.5px}
.stat span{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.6px}
.stat em{display:block;font-style:normal;font-size:11px;color:var(--dim);margin-top:5px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px}
.rows{display:flex;flex-direction:column;gap:9px}
.row{display:grid;grid-template-columns:1fr 46px;gap:9px;align-items:center;font-size:12.5px}
.row .rb{grid-column:1/-1;height:5px;border-radius:99px;background:var(--panel2);overflow:hidden;margin-top:-4px}
.row .rb i{display:block;height:100%;border-radius:99px}
.row .n{font-family:var(--mono);color:var(--dim);text-align:right;font-size:11.5px}
.pipe{display:flex;flex-direction:column;gap:10px}
.lane{display:flex;align-items:center;gap:10px;font-size:12.5px}
.lane .lname{width:132px;color:var(--dim);font-size:11.5px}
.lane .segs{flex:1;display:flex;height:19px;border-radius:5px;overflow:hidden;background:var(--panel2)}
.lane .segs i{display:block}
.lane .tot{font-family:var(--mono);font-size:11px;color:var(--dim);width:52px;text-align:right}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;font-size:11px;color:var(--dim)}
.legend b{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--dim);
  padding:0 10px 9px;font-weight:600}
.tbl td{padding:8px 10px;border-top:1px solid var(--line)}
.tbl tr:hover td{background:var(--panel2)}
.tbl .r{text-align:right;font-family:var(--mono);font-size:11.5px}
.tbl .nm{max-width:330px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{font-size:10px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.zero{color:var(--bad)}
.search{display:flex;gap:9px;margin-bottom:16px}
.search input{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:11px 14px;color:var(--fg);font-size:13.5px;font-family:inherit}
.search input:focus{outline:none;border-color:var(--accent)}
.review h2{display:flex;align-items:center;gap:10px}
.rcount{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--warn);
  border:1px solid var(--warn);border-radius:999px;padding:1px 9px;text-transform:none;letter-spacing:0}
.idq{border:1px solid var(--warn);border-radius:10px;background:rgba(232,176,75,.07);padding:13px 15px}
.idq-head{display:flex;align-items:center;gap:10px;margin-bottom:7px}
.idq-badge{font-size:11px;color:var(--warn);font-weight:650}
.idq-q{margin:0 0 11px;font-size:13.5px;line-height:1.6}
.idq-acts{display:flex;gap:8px}
.idq-done{margin-top:10px;font-size:12px;color:var(--accent);display:none}
.idq-done.on{display:block}
.caps{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
.caps-head{font-size:11.5px;color:var(--dim);display:flex;gap:8px;margin-bottom:8px}
.caps-head b{color:var(--warn);font-family:var(--mono)}
.caps-strip{display:flex;gap:5px;flex-wrap:wrap}
.cap{width:36px;height:26px;border-radius:4px;border:1px solid var(--line);
  background:linear-gradient(135deg,#16222f 0%,#1d2c3c 100%)}
.cap.more{display:grid;place-items:center;font-size:10px;color:var(--dim);font-family:var(--mono);
  background:none}
`;

const bar = (v, max, color) => `<div class="rb"><i style="width:${(v / max) * 100}%;background:${color}"></i></div>`;

// Folded in from Settings → Assistant → "Pending validation".
const holds = D.review.byHold.reduce((a, h) => ({ ...a, [h.k]: h.n }), {});
const identityHolds = holds.possible_owner_alias ?? 0;
const aliasList = D.review.aliasNames.map((a) => `“${esc(a.name)}”`).join(', ');
const maxType = D.nodes.byType[0].n;
const maxPred = D.assertions.byPredicate[0].n;

const confRows = [
  ['high', conf.high ?? 0, 'var(--accent)', '≥ 0.8'],
  ['medium', conf.medium ?? 0, 'var(--blue)', '0.5 – 0.8'],
  ['low', conf.low ?? 0, 'var(--purple)', '< 0.5'],
  ['unscored', conf.unscored ?? 0, 'var(--bad)', 'confidence 0'],
];
const maxConf = Math.max(...confRows.map((r) => r[1]));

const lane = (name, map, tot) => {
  const seg = (k, c) => (map[k] ? `<i style="width:${(map[k] / tot) * 100}%;background:${c}" title="${k}: ${map[k]}"></i>` : '');
  return `<div class="lane"><div class="lname">${name}</div><div class="segs">
    ${seg('completed', 'var(--accent)')}${seg('running', 'var(--blue)')}${seg('queued', 'var(--warn)')}
    ${seg('cancelled', '#3b4d63')}${seg('dead_letter', 'var(--bad)')}
  </div><div class="tot">${num(tot)}</div></div>`;
};
const laneTotal = (m) => Object.values(m).reduce((a, b) => a + b, 0);
const captureJobs = D.jobs.filter((j) => j.job_type === 'capture_retention')
  .reduce((a, j) => ({ ...a, [j.status]: j.n }), {});

const body = `
${topbar('overview', 'overview-first')}
<div class="wrap">

  ${digestHtml}

  <div class="search"><input placeholder="Search everything SiftKit knows — entities, beliefs, documents…"></div>

  <div class="hero">
    <div class="panel">
      <h2>Document capacity</h2>
      <div class="gauges">
        ${tiers.map((t) => `
        <div class="gauge">
          <div class="tname">Tier ${t.tier}<small>${t.label.toUpperCase()}</small></div>
          <div>
            <div class="track"><i class="${tierTone(t) === 'warn' ? 'warn' : ''}" style="width:${Math.min(100, t.pct)}%"></i></div>
            <div class="note" style="margin-top:6px">${num(t.tokens)} tokens${t.n ? ` &middot; ${Math.round(t.tokens / t.n)} avg &middot; ${t.retr} retrievals` : ''}</div>
          </div>
          <div class="cnt"><b>${t.n}</b><span>/${t.limit}</span><br><span>${pct1(t.pct)}</span></div>
        </div>`).join('')}
      </div>
      <div class="totals">
        <div><b>${num(totalDocs)}</b>of ${num(totalLimit)} docs</div>
        <div><b>${num(totalTokens)}</b>tokens projected</div>
        <div><b>${D.budget.last_known_chars_per_token.toFixed(2)}</b>chars / token</div>
        <div><b>${ago(tiers[2].newest)}</b>last rebuild</div>
      </div>
      <div class="alert">
        <h4>&#9888; Tier 3 near limit — ${tiers[2].limit - tiers[2].n} slots left</h4>
        <p>At ${pct1(tiers[2].pct)} the compiler starts archiving lowest-utility documents automatically.
           ${D.projections.archiveCandidates.filter((p) => p.retrieval_count === 0).length} of the next 10 candidates
           have never been retrieved.</p>
        <div class="acts">
          <button class="btn go" onclick="dockOpen(true);ask('Free up Tier 3 space')">Review archive queue</button>
          <button class="btn">Raise limit</button>
          <button class="btn">Rebuild projections</button>
        </div>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><span>Entities</span><b>${num(D.nodes.active)}</b><em>${D.nodes.byType.length} types &middot; newest ${ago(D.nodes.newest)}</em></div>
      <div class="stat"><span>Beliefs</span><b>${num(D.assertions.active)}</b><em>${D.assertions.pinned} pinned &middot; ${num(D.assertions.total - D.assertions.active)} retired</em></div>
      <div class="stat"><span>Evidence</span><b>${num(D.evidence.n)}</b><em>since ${D.evidence.oldest.slice(0, 10)}</em></div>
      <div class="stat"><span>Observations</span><b>${num(D.observations)}</b><em>raw capture events</em></div>
      <div class="stat"><span>Awaiting review</span><b class="${cand.pending > 1000 ? 'zero' : ''}">${num(cand.pending)}</b><em>candidate beliefs pending</em></div>
      <div class="stat"><span>Duplicates</span><b>${dupes.length}</b><em>likely entity pairs
        <a href="#" onclick="dockOpen(true);ask('Merge the duplicate SiftKit entries');return false" style="color:var(--accent)">resolve</a></em></div>
    </div>
  </div>

  <div class="panel review" style="margin-bottom:16px">
    <h2>Needs your review
      <span class="rcount">${num(D.review.total)} waiting</span></h2>

    <div class="idq">
      <div class="idq-head">
        <span class="idq-badge">${identityHolds} identity questions</span>
        <span class="note">Nothing is written until you answer.</span>
      </div>
      <p class="idq-q">Are these you? They look like misreadings of your name: ${aliasList}.</p>
      <div class="idq-acts">
        <button class="btn go" onclick="idAnswer(this,'yes')">Yes, all me</button>
        <button class="btn" onclick="idAnswer(this,'each')">Decide one by one</button>
        <button class="btn" onclick="idAnswer(this,'no')">None of them</button>
      </div>
      <div class="idq-done" id="idqDone"></div>
    </div>

    <table class="tbl" style="margin-top:14px">
      <tr><th>Proposed belief</th><th>Why</th><th class="r">Conf</th><th class="r">Held</th></tr>
      ${D.review.items.slice(0, 6).map((c) => {
        const hold = c.hold_json ? JSON.parse(c.hold_json) : null;
        return `<tr><td class="nm"><span class="mono" style="color:var(--blue);font-size:11px">${esc(c.predicate)}</span>
            ${hold?.kind === 'possible_owner_alias' ? `is “${esc(hold.name)}” you?` : esc(c.rationale).slice(0, 46) + '…'}</td>
          <td class="nm note">${esc(c.rationale).slice(0, 60)}…</td>
          <td class="r">${c.confidence.toFixed(2)}</td>
          <td class="r">${hold ? `<span class="pill" style="color:var(--warn);border-color:var(--warn)">${esc(hold.kind.replace(/_/g, ' '))}</span>` : '<span class="pill">queued</span>'}</td></tr>`;
      }).join('')}
    </table>
    <div class="note" style="margin-top:11px">
      ${num(holds.none ?? 0)} queued · ${identityHolds} identity holds · ${holds.topic ?? 0} topic holds.
      <a href="variant-b-explorer.html" style="color:var(--accent)">Open the full review queue in Explorer →</a>
    </div>
  </div>

  <div class="grid3">
    <div class="panel">
      <h2>What it knows about — by type</h2>
      <div class="rows">
        ${D.nodes.byType.slice(0, 9).map((t) => `
          <div class="row"><span>${esc(t.type.replace(/_/g, ' '))}</span><span class="n">${num(t.n)}</span>
            ${bar(t.n, maxType, 'var(--accent)')}</div>`).join('')}
      </div>
      <div class="note" style="margin-top:10px">+ ${D.nodes.byType.length - 9} smaller types</div>
    </div>

    <div class="panel">
      <h2>How they relate — top predicates</h2>
      <div class="rows">
        ${D.assertions.byPredicate.slice(0, 9).map((p) => `
          <div class="row"><span class="mono" style="font-size:11.5px">${esc(p.predicate)}</span><span class="n">${num(p.n)}</span>
            ${bar(p.n, maxPred, 'var(--blue)')}</div>`).join('')}
      </div>
      <div class="note" style="margin-top:10px">+ ${D.assertions.byPredicate.length - 9} more predicates</div>
    </div>

    <div class="panel">
      <h2>How sure it is</h2>
      <div class="rows">
        ${confRows.map(([k, v, c, r]) => `
          <div class="row"><span>${k} <span class="note">${r}</span></span><span class="n">${num(v)}</span>
            ${bar(v, maxConf, c)}</div>`).join('')}
      </div>
      <div class="note" style="margin-top:12px">
        <b style="color:var(--bad)">${pct1((conf.unscored / D.assertions.active) * 100)} carry no confidence score.</b>
        Basis is ${num(D.assertions.byBasis.find((b) => b.basis === 'passive_observation')?.n ?? 0)} passively observed
        vs ${D.assertions.byBasis.find((b) => b.basis === 'explicit_user_statement')?.n ?? 0} stated by you.
      </div>
    </div>
  </div>

  <div class="grid3" style="grid-template-columns:1fr 1.6fr">
    <div class="panel">
      <h2>Pipeline health</h2>
      <div class="pipe">
        ${lane('image extraction', imageJobs, laneTotal(imageJobs))}
        ${lane('projection maint.', projJobs, laneTotal(projJobs))}
        ${lane('capture retention', captureJobs, laneTotal(captureJobs))}
      </div>
      <div class="legend">
        <span><b style="background:var(--accent)"></b>completed</span>
        <span><b style="background:var(--warn)"></b>queued</span>
        <span><b style="background:#3b4d63"></b>cancelled</span>
        <span><b style="background:var(--bad)"></b>dead letter</span>
      </div>
      <div class="caps">
        <div class="caps-head">Awaiting image analysis <b>${D.captures.queued}</b></div>
        <div class="caps-strip">
          ${Array.from({ length: 8 }, (_, i) => `<div class="cap" title="capture ${i + 1} — queued"></div>`).join('')}
          <div class="cap more">+${D.captures.queued - 8}</div>
        </div>
      </div>
      <div class="note" style="margin-top:12px;border-top:1px solid var(--line);padding-top:11px">
        <span class="badge bad">${imageJobs.dead_letter} dead</span>
        image extractions failed permanently on 2026-09-03 and are not retried.
      </div>
    </div>

    <div class="panel">
      <h2>Most-used documents</h2>
      <table class="tbl">
        <tr><th>Document</th><th>Tier</th><th class="r">Tokens</th><th class="r">Used</th><th class="r">Last</th></tr>
        ${D.projections.topRetrieved.map((p) => `
        <tr><td class="nm">${esc(p.title)}</td>
          <td><span class="pill">T${p.tier}</span></td>
          <td class="r">${num(p.token_count)}</td>
          <td class="r">${p.retrieval_count}</td>
          <td class="r">${ago(p.last_retrieved_at_utc)}</td></tr>`).join('')}
      </table>
      <div class="note" style="margin-top:11px">
        Only ${D.projections.topRetrieved.length} of ${num(totalDocs)} documents have ever been retrieved.
        The remaining ${num(totalDocs - D.projections.topRetrieved.length)} occupy
        ${pct1(((totalDocs - D.projections.topRetrieved.length) / totalDocs) * 100)} of capacity unused.
      </div>
    </div>
  </div>
</div>`;

const extraJs = `${digestJs}
function idAnswer(btn, choice){
  const done = document.getElementById('idqDone');
  done.classList.add('on');
  done.textContent = choice === 'yes'
    ? '✓ Merged ${identityHolds} aliases into your identity. ${num(D.review.total - identityHolds)} beliefs still queued.'
    : choice === 'no'
      ? '✓ Rejected ${identityHolds} alias candidates. They will not be asked again.'
      : 'Stepping through ${identityHolds} questions one at a time…';
  btn.closest('.idq-acts').querySelectorAll('button').forEach((b) => { b.disabled = true; });
}
`;

writeFileSync(
  new URL('variant-a-dashboard.html', here),
  page('Memory · Dashboard mockup', css + digestCss, body, extraJs),
);
