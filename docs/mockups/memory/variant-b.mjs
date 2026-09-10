// Variant B — Explorer. Master–detail entity browser: facets, list, inspector.
import {
  D, tiers, totalDocs, totalTokens, cand,
  num, pct1, esc, ago, dupes, tierTone, page, topbar, here, writeFileSync,
} from './build.mjs';

// Folded in from Settings → Assistant ("Pending validation" and "Memory history").
const identityHolds = D.review.byHold.find((h) => h.k === 'possible_owner_alias')?.n ?? 0;

const css = `
.shell{display:grid;grid-template-columns:216px 1fr 400px;height:calc(100vh - 53px)}
.rail,.mid,.insp{overflow-y:auto}
.rail{border-right:1px solid var(--line);padding:16px 14px;background:var(--panel)}
.rail h2{margin-bottom:9px}
.rail h2:not(:first-child){margin-top:22px}
.facet{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12.5px}
.facet:hover{background:var(--panel2)}
.facet.on{background:var(--panel2);color:var(--accent)}
.facet .fn{flex:1;text-transform:capitalize}
.facet .fc{font-family:var(--mono);font-size:11px;color:var(--dim)}
.capsule{border:1px solid var(--line);border-radius:9px;padding:11px;margin-top:8px}
.capsule .cl{display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:6px}
.capsule .cl b{font-family:var(--mono)}
.capsule .cl .warn{color:var(--warn)}
.mid{padding:16px 18px}
.mfind{display:flex;gap:8px;margin-bottom:14px}
.mfind input{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:9px;
  padding:10px 13px;color:var(--fg);font-size:13px;font-family:inherit}
.mfind input:focus{outline:none;border-color:var(--accent)}
.mhead{display:flex;align-items:baseline;gap:10px;margin-bottom:12px}
.mhead h1{font-size:16px;margin:0;font-weight:650}
.mhead span{font-size:12px;color:var(--dim)}
.ent{display:grid;grid-template-columns:1fr auto;gap:3px 12px;padding:11px 13px;border:1px solid var(--line);
  border-radius:10px;margin-bottom:8px;cursor:pointer;background:var(--panel)}
.ent:hover{border-color:#2c4257}
.ent.on{border-color:var(--accent);background:var(--panel2)}
.ent .en{font-weight:600;font-size:13.5px}
.ent .em{grid-column:1;color:var(--dim);font-size:11.5px;display:flex;gap:9px;align-items:center}
.ent .deg{grid-row:1/3;align-self:center;text-align:right;font-family:var(--mono)}
.ent .deg b{font-size:17px} .ent .deg small{display:block;color:var(--dim);font-size:10px}
.dupflag{font-size:10px;color:var(--warn);border:1px solid var(--warn);border-radius:99px;padding:0 6px}
.tag{font-size:10px;padding:1px 7px;border-radius:99px;background:var(--panel2);border:1px solid var(--line);color:var(--dim)}
.insp{border-left:1px solid var(--line);background:var(--panel);padding:18px 16px}
.ih{margin-bottom:14px}
.ih h3{margin:0 0 5px;font-size:17px}
.ih .sub{color:var(--dim);font-size:12px}
.iacts{display:flex;gap:7px;margin:13px 0 18px;flex-wrap:wrap}
.btn{padding:6px 11px;border-radius:7px;font-size:11.5px;cursor:pointer;border:1px solid var(--line);
  background:var(--panel2);color:var(--fg)}
.btn:hover{border-color:var(--accent)}
.btn.warn:hover{border-color:var(--bad);color:var(--bad)}
.asrt{padding:10px 0;border-top:1px solid var(--line)}
.asrt .line{font-size:12.5px;line-height:1.5;margin-bottom:5px}
.asrt .pred{font-family:var(--mono);font-size:11px;color:var(--blue);background:rgba(74,163,224,.1);
  padding:1px 6px;border-radius:4px;margin:0 3px}
.asrt .meta{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--dim)}
.cbar{width:44px;height:4px;border-radius:99px;background:var(--panel2);overflow:hidden}
.cbar i{display:block;height:100%;border-radius:99px}
.asrt .row2{display:flex;justify-content:space-between;align-items:center}
.mini{display:none;gap:5px}
.asrt:hover .mini{display:flex}
.asrt:hover .meta .hidehov{display:none}
.mini button{font-size:10px;padding:2px 7px;border-radius:5px;border:1px solid var(--line);
  background:var(--panel2);color:var(--dim);cursor:pointer}
.mini button:hover{color:var(--fg);border-color:var(--accent)}
.prov{margin-top:16px;padding:11px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}
.prov h4{margin:0 0 7px;font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--dim)}
.prov .pl{display:flex;justify-content:space-between;font-size:11.5px;padding:3px 0}
.prov .pl span{color:var(--dim)}
.modes{display:flex;gap:3px;background:var(--bg);border:1px solid var(--line);border-radius:8px;
  padding:3px;margin-bottom:14px;width:fit-content}
.modes button{background:none;border:0;color:var(--dim);font-size:12px;padding:5px 14px;
  border-radius:6px;cursor:pointer;font-family:inherit}
.modes button:hover{color:var(--fg)}
.modes button.on{background:var(--panel2);color:var(--accent);font-weight:600}
.modes .badge2{font-family:var(--mono);font-size:10px;margin-left:6px;color:var(--warn)}
.pane{display:none}
.pane.on{display:block}
.card2{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:12px 14px;
  margin-bottom:9px}
.card2 .c2h{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.card2 .c2h h4{margin:0;font-size:13.5px;font-weight:600;flex:1}
.card2 p{margin:0 0 8px;font-size:12.5px;color:var(--dim);line-height:1.55}
.card2 .c2acts{display:flex;gap:7px;margin-top:9px}
.hold{border-color:var(--warn)}
.hold .idbox{background:rgba(232,176,75,.08);border:1px solid var(--warn);border-radius:8px;
  padding:10px 12px;margin:8px 0 0}
.hold .idbox p{color:var(--fg);margin-bottom:9px}
.notes{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:7px;color:var(--fg);
  font-family:inherit;font-size:12px;padding:7px 9px;resize:vertical}
.hist{display:grid;grid-template-columns:112px 1fr;gap:0 14px;padding:9px 0;
  border-top:1px solid var(--line);font-size:12.5px}
.hist .when{font-family:var(--mono);font-size:11px;color:var(--dim)}
.hist .what b{font-weight:600}
.hist .proof{font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-top:3px}
.op{font-family:var(--mono);font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid var(--line);
  color:var(--dim);margin-right:6px}
.op.create_node,.op.create_assertion{color:var(--accent);border-color:rgba(46,201,160,.5)}
.op.merge_node{color:var(--purple);border-color:rgba(155,127,224,.5)}
.op.supersede_assertion{color:var(--warn);border-color:rgba(232,176,75,.5)}
.actor{font-size:10px;color:var(--dim)}
`;

const nodes = D.topNodes;
const dupNames = new Set(dupes.flat().map((n) => n.display_name));
const first = nodes[0];

const confColor = (c) => (c >= 0.8 ? 'var(--accent)' : c >= 0.5 ? 'var(--blue)' : c > 0 ? 'var(--purple)' : 'var(--bad)');

const assertionRow = (a) => `
  <div class="asrt">
    <div class="line"><b>${esc(a.subj ?? '—')}</b><span class="pred">${esc(a.predicate)}</span>${esc(a.obj) || '<i style="color:var(--dim)">—</i>'}</div>
    <div class="row2">
      <div class="meta">
        <div class="cbar"><i style="width:${Math.max(4, a.confidence * 100)}%;background:${confColor(a.confidence)}"></i></div>
        ${a.confidence > 0 ? a.confidence.toFixed(2) : '<span style="color:var(--bad)">unscored</span>'}
        <span class="hidehov">&middot; ${a.basis === 'passive_observation' ? 'observed' : 'you stated'} &middot; ${ago(a.last_observed_at_utc)}</span>
      </div>
      <div class="mini">
        <button onclick="dockOpen(true);ask('Why do you think that?')">why?</button>
        <button>pin</button><button>correct</button><button>drop</button>
      </div>
    </div>
  </div>`;

const inspector = (node) => {
  const list = D.nodeDetails[node.id] ?? [];
  return `
  <div class="ih">
    <h3>${esc(node.display_name)}</h3>
    <div class="sub"><span class="tag">${esc(node.type.replace(/_/g, ' '))}</span>
      &nbsp;${node.deg} beliefs &middot; first seen ${node.created_at_utc.slice(0, 10)}</div>
  </div>
  ${dupNames.has(node.display_name) ? `
  <div class="capsule" style="border-color:var(--warn);margin-bottom:14px">
    <div class="cl"><span class="warn">&#9888; Possible duplicate</span></div>
    <div class="note">Another entity shares this name. Merging keeps the higher-degree node.</div>
    <button class="btn" style="margin-top:9px;width:100%" onclick="dockOpen(true);ask('Merge the duplicate SiftKit entries')">Review merge</button>
  </div>` : ''}
  <div class="iacts">
    <button class="btn" onclick="dockOpen(true);ask('Why do you think that?')">Explain</button>
    <button class="btn">Pin all</button>
    <button class="btn">Rename</button>
    <button class="btn warn" onclick="dockOpen(true);ask('Forget everything about this')">Forget</button>
  </div>
  <h2>Beliefs (${list.length} of ${node.deg})</h2>
  ${list.map(assertionRow).join('') || '<div class="note">No active beliefs.</div>'}
  <div class="prov">
    <h4>Provenance</h4>
    <div class="pl"><span>Basis</span><b>${list.every((a) => a.basis === 'passive_observation') ? 'all passively observed' : 'mixed'}</b></div>
    <div class="pl"><span>First observed</span><b>${list[0]?.first_observed_at_utc?.slice(0, 10) ?? '—'}</b></div>
    <div class="pl"><span>Last observed</span><b>${ago(list[0]?.last_observed_at_utc)}</b></div>
    <div class="pl"><span>Sensitivity</span><b>${esc(list[0]?.sensitivity ?? 'personal')}</b></div>
  </div>`;
};

const body = `
${topbar('explorer', 'master–detail')}
<div class="shell">

  <aside class="rail">
    <h2>Capacity</h2>
    ${tiers.map((t) => `
      <div class="capsule">
        <div class="cl"><span>Tier ${t.tier} · ${t.label}</span>
          <b class="${tierTone(t) === 'warn' ? 'warn' : ''}">${t.n}/${t.limit}</b></div>
        <div class="bar"><i class="${tierTone(t) === 'warn' ? 'warn' : ''}" style="width:${Math.min(100, t.pct)}%"></i></div>
        <div class="note" style="margin-top:6px">${num(t.tokens)} tok · ${pct1(t.pct)}</div>
      </div>`).join('')}
    <div class="note" style="margin-top:11px">${num(totalDocs)} docs · ${num(totalTokens)} tokens</div>

    <h2>Entity type</h2>
    <div class="facet on"><span class="fn">all</span><span class="fc">${num(D.nodes.active)}</span></div>
    ${D.nodes.byType.slice(0, 10).map((t) => `
      <div class="facet"><span class="fn">${esc(t.type.replace(/_/g, ' '))}</span><span class="fc">${t.n}</span></div>`).join('')}

    <h2>Confidence</h2>
    <div class="facet"><span class="fn">high ≥0.8</span><span class="fc">${D.assertions.byConfidence.find((c) => c.b === 'high')?.n ?? 0}</span></div>
    <div class="facet"><span class="fn">medium</span><span class="fc">${D.assertions.byConfidence.find((c) => c.b === 'medium')?.n ?? 0}</span></div>
    <div class="facet"><span class="fn">unscored</span><span class="fc">${D.assertions.byConfidence.find((c) => c.b === 'unscored')?.n ?? 0}</span></div>

    <h2>Needs attention</h2>
    <div class="facet" onclick="mode('review')"><span class="fn">identity questions</span>
      <span class="fc" style="color:var(--warn)">${identityHolds}</span></div>
    <div class="facet"><span class="fn">duplicates</span><span class="fc">${dupes.length}</span></div>
    <div class="facet" onclick="mode('review')"><span class="fn">pending review</span>
      <span class="fc">${num(D.review.total)}</span></div>
    <div class="facet"><span class="fn">never retrieved</span><span class="fc">${num(totalDocs - D.projections.topRetrieved.length)}</span></div>
  </aside>

  <main class="mid">
    <div class="modes">
      <button class="on" data-mode="entities" onclick="mode('entities')">Entities</button>
      <button data-mode="review" onclick="mode('review')">Review<span class="badge2">${num(D.review.total)}</span></button>
      <button data-mode="history" onclick="mode('history')">History</button>
    </div>

    <div class="pane on" id="pane-entities">
      <div class="mfind"><input placeholder="Search entities, beliefs and documents…" oninput="filterEnts(this.value)"></div>
      <div class="mhead"><h1>Entities</h1><span id="cnt">${nodes.length} shown · sorted by connectedness</span></div>
      <div id="ents">
        ${nodes.map((n, i) => `
        <div class="ent ${i === 0 ? 'on' : ''}" data-i="${i}" data-name="${esc(n.display_name.toLowerCase())}" onclick="pick(${i})">
          <div class="en">${esc(n.display_name)}
            ${dupNames.has(n.display_name) ? '<span class="dupflag">duplicate?</span>' : ''}</div>
          <div class="em"><span class="tag">${esc(n.type.replace(/_/g, ' '))}</span> first seen ${n.created_at_utc.slice(0, 10)}</div>
          <div class="deg"><b>${n.deg}</b><small>beliefs</small></div>
        </div>`).join('')}
      </div>
    </div>

    <div class="pane" id="pane-review">
      <div class="mhead"><h1>Awaiting your review</h1>
        <span>${num(D.review.total)} candidate beliefs · ${identityHolds} held on an identity question</span></div>
      ${D.review.items.map((c) => {
        const hold = c.hold_json ? JSON.parse(c.hold_json) : null;
        return `
        <div class="card2 ${hold ? 'hold' : ''}">
          <div class="c2h">
            <h4><span class="mono" style="color:var(--blue);font-size:11px">${esc(c.predicate)}</span>
              ${hold?.kind === 'possible_owner_alias'
                ? `Is “${esc(hold.name)}” another name for you?`
                : esc(c.rationale).slice(0, 58) + '…'}</h4>
            <span class="tag">${Math.round(c.confidence * 100)}%</span>
            <span class="tag">${esc(c.sensitivity)}</span>
          </div>
          <p>${esc(c.rationale)}</p>
          ${hold?.kind === 'possible_owner_alias' ? `
          <div class="idbox">
            <p>“${esc(hold.name)}” is close to one of your own names. Nothing is written until you answer.</p>
            <div class="c2acts">
              <button class="btn" onclick="resolveCard(this,'Recorded as you.')">Yes, that is me</button>
              <button class="btn" onclick="resolveCard(this,'Recorded as someone else.')">No, someone else</button>
            </div>
          </div>` : `
          <textarea class="notes" rows="2" placeholder="Your notes…"></textarea>
          <div class="c2acts">
            <button class="btn" onclick="resolveCard(this,'Notes saved.')">Save notes</button>
            <button class="btn warn" onclick="resolveCard(this,'Removed from the queue.')">Remove</button>
          </div>`}
        </div>`;
      }).join('')}
      <div class="note">Showing ${D.review.items.length} of ${num(D.review.total)}.</div>
    </div>

    <div class="pane" id="pane-history">
      <div class="mhead"><h1>Memory history</h1>
        <span>${num(D.history.byOperation.reduce((s, o) => s + o.n, 0))} recorded changes</span></div>
      <div class="note" style="margin-bottom:12px">
        ${D.history.byActor.map((a) => `${esc(a.actor_type.replace(/_/g, ' '))} ${num(a.n)}`).join(' · ')}
        — only ${D.history.byActor.find((a) => a.actor_type === 'user')?.n ?? 0} changes were made by you.
      </div>
      ${D.history.items.map((h) => `
      <div class="hist">
        <div class="when">${h.created_at_utc.slice(5, 16).replace('T', ' ')}</div>
        <div class="what">
          <span class="op ${esc(h.operation)}">${esc(h.operation.replace(/_/g, ' '))}</span>
          <b>${esc(h.name ?? h.pred ?? h.target_id.slice(0, 22))}</b>
          <span class="actor">· ${esc(h.actor_type.replace(/_/g, ' '))}</span>
          ${h.reason ? `<div class="note">${esc(h.reason)}</div>` : ''}
          <div class="proof">${esc(h.target_type)} · ${esc(h.target_id)}</div>
        </div>
      </div>`).join('')}
    </div>
  </main>

  <aside class="insp" id="insp">${inspector(first)}</aside>
</div>

<script>
const NODES = ${JSON.stringify(nodes.map((n) => n.id))};
const PANES = ${JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, inspector(n)])))};
function pick(i){
  document.querySelectorAll('.ent').forEach(e => e.classList.toggle('on', +e.dataset.i === i));
  document.getElementById('insp').innerHTML = PANES[NODES[i]];
  document.getElementById('insp').scrollTop = 0;
}
function filterEnts(q){
  const s = q.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('.ent').forEach(e => {
    const hit = !s || e.dataset.name.includes(s);
    e.style.display = hit ? '' : 'none';
    if(hit) shown++;
  });
  document.getElementById('cnt').textContent = shown + ' shown · sorted by connectedness';
}
function mode(name){
  document.querySelectorAll('.modes button').forEach(b =>
    b.classList.toggle('on', b.dataset.mode === name));
  document.querySelectorAll('.pane').forEach(p =>
    p.classList.toggle('on', p.id === 'pane-' + name));
}
function resolveCard(btn, message){
  const card = btn.closest('.card2');
  card.querySelectorAll('button, textarea').forEach(el => { el.disabled = true; });
  const done = document.createElement('div');
  done.className = 'note';
  done.style.color = 'var(--accent)';
  done.style.marginTop = '8px';
  done.textContent = '✓ ' + message;
  card.appendChild(done);
}
</script>`;

writeFileSync(new URL('variant-b-explorer.html', here), page('Memory · Explorer mockup', css, body));
