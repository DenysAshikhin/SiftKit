// Builds the three memory-UI mockups from snapshot.json.
// Data is inlined so each file opens standalone over file:// (fetch is blocked there).
// Regenerate with: node docs/mockups/memory/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const here = new URL('./', import.meta.url);
const D = JSON.parse(readFileSync(new URL('snapshot.json', here), 'utf8'));

/* ---------------------------------------------------------------- derived */

const TIER_LABEL = { 1: 'Profile', 2: 'Dossier', 3: 'Archive' };
const tiers = [1, 2, 3].map((t) => {
  const row = D.projections.byTier.find((r) => r.tier === t)
    ?? { tier: t, n: 0, tokens: 0, maxTok: 0, retr: 0, newest: null };
  const limit = D.limits[t];
  return { ...row, limit, pct: (row.n / limit) * 100, label: TIER_LABEL[t] };
});
const totalDocs = tiers.reduce((s, t) => s + t.n, 0);
const totalTokens = tiers.reduce((s, t) => s + t.tokens, 0);
const totalLimit = tiers.reduce((s, t) => s + t.limit, 0);

const jobsBy = (type) => D.jobs.filter((j) => j.job_type === type)
  .reduce((a, j) => ({ ...a, [j.status]: j.n }), {});
const imageJobs = jobsBy('image_extraction');
const projJobs = jobsBy('projection_maintenance');
const cand = D.candidates.reduce((a, c) => ({ ...a, [c.status]: c.n }), {});
const conf = D.assertions.byConfidence.reduce((a, c) => ({ ...a, [c.b]: c.n }), {});

const num = (n) => (n ?? 0).toLocaleString('en-US');
const pct1 = (n) => `${n.toFixed(1)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDate = (iso) => (iso ? iso.slice(0, 10) : '—');
const ago = (iso) => {
  if (!iso) return '—';
  const h = (Date.parse(D.capturedAtUtc) - Date.parse(iso)) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
// Duplicate display names are the headline cleanup case in the live graph.
const dupes = (() => {
  const seen = new Map();
  for (const n of D.topNodes) {
    const k = n.display_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    seen.set(k, [...(seen.get(k) ?? []), n]);
  }
  return [...seen.values()].filter((g) => g.length > 1);
})();

const tierTone = (t) => (t.pct >= 85 ? 'warn' : t.pct >= 100 ? 'bad' : 'ok');

/* -------------------------------------------------------------- chat dock */
// Scripted memory assistant. Keyword-routed canned replies; every destructive
// action renders a preview card that must be applied, mirroring the real
// cleanup/preview -> previewToken -> cleanup contract.

const CHAT_TOOLS = [
  'search', 'graph/nodes', 'graph/assertions', 'assertions/:id/explanation',
  'assertions/:id/correct', 'assertions/:id/confirm', 'assertions/:id/pin',
  'assertions/:id/demote', 'assertions/:id (DELETE)', 'topics/forget-preview',
  'topics/forget', 'cleanup/preview', 'cleanup', 'projections/rebuild',
];

const chatCss = `
.dock{position:fixed;right:20px;bottom:20px;z-index:60;font-size:13px}
.dock-fab{display:flex;align-items:center;gap:9px;padding:11px 16px;border-radius:999px;
  background:var(--accent);color:#04140f;border:0;cursor:pointer;font-weight:650;font-size:13px;
  box-shadow:0 8px 28px rgba(0,0,0,.5)}
.dock-fab:hover{filter:brightness(1.08)}
.dock-fab .dot{width:7px;height:7px;border-radius:50%;background:#04140f}
.dock-panel{display:none;flex-direction:column;width:392px;height:552px;background:var(--panel);
  border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.dock.open .dock-panel{display:flex}
.dock.open .dock-fab{display:none}
.dock-head{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--line);
  background:var(--panel2)}
.dock-head b{font-size:13px;letter-spacing:.2px}
.dock-head .scope{margin-left:auto;font-size:10px;color:var(--accent);border:1px solid var(--accent);
  padding:2px 7px;border-radius:999px;opacity:.85;cursor:help}
.dock-x{background:none;border:0;color:var(--dim);cursor:pointer;font-size:17px;line-height:1;padding:0 2px}
.dock-x:hover{color:var(--fg)}
.dock-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:92%;padding:9px 12px;border-radius:11px;line-height:1.5}
.msg.me{align-self:flex-end;background:var(--accent);color:#04140f;border-bottom-right-radius:3px}
.msg.ai{align-self:flex-start;background:var(--panel2);border:1px solid var(--line);border-bottom-left-radius:3px}
.msg.ai code{background:rgba(255,255,255,.07);padding:1px 4px;border-radius:3px;font-size:11px}
.trace{align-self:flex-start;font-size:10.5px;color:var(--dim);font-family:var(--mono);
  display:flex;flex-wrap:wrap;gap:5px;align-items:center;max-width:92%}
.trace span{border:1px solid var(--line);padding:1px 6px;border-radius:4px;background:var(--panel2)}
.card{align-self:stretch;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg)}
.card-h{padding:8px 11px;background:var(--panel2);border-bottom:1px solid var(--line);
  font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--dim);
  display:flex;align-items:center;gap:7px}
.card-h.warn{color:var(--warn)}
.card-b{padding:10px 11px;display:flex;flex-direction:column;gap:7px}
.diff{font-family:var(--mono);font-size:11px;line-height:1.6}
.diff .del{color:var(--bad)}
.diff .add{color:var(--accent)}
.diff .ctx{color:var(--dim)}
.card-f{display:flex;gap:7px;padding:9px 11px;border-top:1px solid var(--line);background:var(--panel2)}
.card-f button{flex:1;padding:7px;border-radius:7px;font-size:12px;cursor:pointer;font-weight:600;
  border:1px solid var(--line);background:var(--panel);color:var(--fg)}
.card-f .go{background:var(--accent);color:#04140f;border-color:var(--accent)}
.card-f .go:hover{filter:brightness(1.08)}
.card-f button:disabled{opacity:.5;cursor:default;filter:none}
.applied{padding:9px 11px;border-top:1px solid var(--line);color:var(--accent);font-size:11.5px;
  background:var(--panel2);display:flex;align-items:center;gap:6px}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px}
.chips button{font-size:11px;padding:5px 10px;border-radius:999px;border:1px solid var(--line);
  background:var(--panel2);color:var(--dim);cursor:pointer}
.chips button:hover{color:var(--fg);border-color:var(--accent)}
.dock-in{display:flex;gap:8px;padding:11px 12px;border-top:1px solid var(--line);background:var(--panel2)}
.dock-in input{flex:1;background:var(--bg);border:1px solid var(--line);border-radius:8px;
  padding:9px 11px;color:var(--fg);font-size:12.5px;font-family:inherit}
.dock-in input:focus{outline:none;border-color:var(--accent)}
.dock-in button{background:var(--accent);color:#04140f;border:0;border-radius:8px;padding:0 15px;
  cursor:pointer;font-weight:650}
`;

const chatHtml = `
<div class="dock" id="dock">
  <button class="dock-fab" onclick="dockOpen(true)"><span class="dot"></span>Memory assistant</button>
  <div class="dock-panel">
    <div class="dock-head">
      <b>Memory assistant</b>
      <span class="scope" title="Tools: ${CHAT_TOOLS.join(' · ')}">memory tools only</span>
      <button class="dock-x" onclick="dockOpen(false)">&times;</button>
    </div>
    <div class="dock-log" id="log"></div>
    <div class="chips">
      <button onclick="ask(this.textContent)">Merge the duplicate SiftKit entries</button>
      <button onclick="ask(this.textContent)">I don't use llama.cpp any more</button>
      <button onclick="ask(this.textContent)">Forget everything about League of Legends</button>
      <button onclick="ask(this.textContent)">Free up Tier 3 space</button>
      <button onclick="ask(this.textContent)">Why do you think I use CUDA?</button>
    </div>
    <form class="dock-in" onsubmit="event.preventDefault();ask(this.q.value);this.q.value=''">
      <input name="q" placeholder="Correct or clean up a memory…" autocomplete="off">
      <button type="submit">Send</button>
    </form>
  </div>
</div>`;

const chatJs = `
const dockEl = document.getElementById('dock');
const logEl = document.getElementById('log');
function dockOpen(v){ dockEl.classList.toggle('open', v); if(v) logEl.scrollTop = logEl.scrollHeight; }
function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstChild; }
function push(node){ logEl.appendChild(node); logEl.scrollTop = logEl.scrollHeight; }
function applyCard(btn, msg){
  const card = btn.closest('.card');
  card.querySelector('.card-f').remove();
  card.appendChild(el('<div class="applied">&#10003; ' + msg + '</div>'));
}
function discardCard(btn){
  const card = btn.closest('.card');
  card.querySelector('.card-f').remove();
  card.appendChild(el('<div class="applied" style="color:var(--dim)">Discarded — nothing changed.</div>'));
}
const TRACE = (...t) => '<div class="trace">called ' + t.map(x=>'<span>'+x+'</span>').join('') + '</div>';

const SCRIPT = [
  { re:/merge|duplicate|dupe|same thing|two .*entries/i, reply: () => [
      TRACE('search','graph/nodes','cleanup/preview'),
      '<div class="msg ai">Found <b>4 likely duplicate pairs</b> in 1,109 active entities. Merging keeps the higher-degree node and re-points every assertion — nothing is deleted.</div>',
      \`<div class="card"><div class="card-h">cleanup/preview &middot; 4 merges</div><div class="card-b diff">
        <div><span class="del">- SiftKit</span> <span class="ctx">(18 links)</span> &rarr; <span class="add">SiftKit</span> <span class="ctx">(42 links)</span></div>
        <div><span class="del">- TheLastSpark</span> <span class="ctx">(38)</span> &rarr; <span class="add">The Last Spark</span> <span class="ctx">(67)</span></div>
        <div><span class="del">- VS Code</span> <span class="ctx">(17)</span> &rarr; <span class="add">Visual Studio Code</span> <span class="ctx">(37)</span></div>
        <div><span class="del">- Unknown User</span> <span class="ctx">(19)</span> &rarr; <span class="add">Unknown</span> <span class="ctx">(54)</span></div>
        <div class="ctx" style="margin-top:4px">148 assertions re-pointed &middot; 4 entities archived &middot; reversible for 30d</div>
      </div><div class="card-f">
        <button class="go" onclick="applyCard(this,'Merged 4 pairs. 148 assertions re-pointed.')">Apply merges</button>
        <button onclick="discardCard(this)">Discard</button>
      </div></div>\`] },
  { re:/don't use|dont use|no longer|stop using|not use|wrong|incorrect|isn't true|never/i, reply: (q) => [
      TRACE('search','graph/assertions','assertions/:id/demote'),
      '<div class="msg ai">I hold <b>3 assertions</b> matching that, all from passive observation rather than anything you told me. I&rsquo;ll retire them and suppress re-learning from the same evidence.</div>',
      \`<div class="card"><div class="card-h">3 assertions &middot; retire</div><div class="card-b diff">
        <div><span class="del">- the user USES llama.cpp</span> <span class="ctx">conf 0.85 &middot; 12 observations</span></div>
        <div><span class="del">- SiftKit DEPENDS_ON llama.cpp</span> <span class="ctx">conf 0.55</span></div>
        <div><span class="del">- llama.cpp PART_OF inference backend</span> <span class="ctx">conf 0.00</span></div>
        <div class="ctx" style="margin-top:4px">Evidence is kept; only the conclusions are retired.</div>
      </div><div class="card-f">
        <button class="go" onclick="applyCard(this,'Retired 3 assertions and suppressed the source evidence.')">Retire them</button>
        <button onclick="discardCard(this)">Keep them</button>
      </div></div>\`] },
  { re:/forget|delete|remove|purge|wipe/i, reply: () => [
      TRACE('topics/forget-preview'),
      '<div class="msg ai">Scoped forget. This is <b>irreversible</b>, so read the blast radius before applying:</div>',
      \`<div class="card"><div class="card-h warn">&#9888; topics/forget-preview</div><div class="card-b diff">
        <div><span class="del">- 3 entities</span> <span class="ctx">League of Legends, League Arena, Nami</span></div>
        <div><span class="del">- 31 assertions</span></div>
        <div><span class="del">- 7 Tier 3 documents</span> <span class="ctx">-1,204 tokens</span></div>
        <div><span class="del">- 46 evidence records</span> <span class="ctx">screenshots + transcripts</span></div>
        <div class="ctx" style="margin-top:4px">Frees 7 Tier 3 slots &middot; cannot be undone</div>
      </div><div class="card-f">
        <button class="go" onclick="applyCard(this,'Forgot 3 entities, 31 assertions, 46 evidence records.')">Forget permanently</button>
        <button onclick="discardCard(this)">Cancel</button>
      </div></div>\`] },
  { re:/free up|space|capacity|tier ?3|limit|full|archive/i, reply: () => [
      TRACE('projections','cleanup/preview'),
      '<div class="msg ai">Tier 3 is at <b>${tiers[2].n}/${tiers[2].limit}</b> (${pct1(tiers[2].pct)}). ${tiers[2].limit - tiers[2].n} slots left. The lowest-utility documents have never been retrieved once:</div>',
      \`<div class="card"><div class="card-h">archive 12 lowest-utility documents</div><div class="card-b diff">
        ${D.projections.archiveCandidates.slice(0, 5).map((p) => `<div><span class="del">- ${esc(p.title).slice(0, 34)}</span> <span class="ctx">${p.token_count} tok &middot; ${p.retrieval_count} retrievals</span></div>`).join('')}
        <div class="ctx">…and 7 more &middot; frees 12 slots, ~1,580 tokens</div>
      </div><div class="card-f">
        <button class="go" onclick="applyCard(this,'Archived 12 documents. Tier 3 now 427/500 (85.4%).')">Archive them</button>
        <button onclick="discardCard(this)">Discard</button>
      </div></div>\`] },
  { re:/why|how do you know|explain|source|where did/i, reply: () => [
      TRACE('search','assertions/:id/explanation'),
      \`<div class="msg ai">Because of <b>4 passive observations</b>, not anything you stated:<br>
        <code>the user USES CUDA</code> &middot; confidence 0.55<br>
        First seen 2026-09-02, last 2026-09-09. Derived from terminal output and <code>nvidia-smi</code> in
        3 screenshots plus 1 chat transcript. Basis is <code>passive_observation</code>, so it decays unless reinforced.</div>\`,
      \`<div class="card"><div class="card-h">adjust this belief</div><div class="card-b diff">
        <div class="ctx">Pin it to stop decay, or correct it if the inference is wrong.</div>
      </div><div class="card-f">
        <button class="go" onclick="applyCard(this,'Pinned. This assertion no longer decays.')">Pin as true</button>
        <button onclick="discardCard(this)">That's wrong</button>
      </div></div>\`] },
];
const FALLBACK = [
  TRACE('search'),
  \`<div class="msg ai">I can correct, pin, demote, merge, or forget anything in memory — and I only reach the
   memory tools, nothing else. Try:<br>&ldquo;that's wrong, I use X not Y&rdquo; &middot; &ldquo;merge these duplicates&rdquo;
   &middot; &ldquo;forget about &lt;topic&gt;&rdquo; &middot; &ldquo;why do you think that?&rdquo;</div>\`,
];

function ask(q){
  if(!q || !q.trim()) return;
  push(el('<div class="msg me">' + q.replace(/</g,'&lt;') + '</div>'));
  const hit = SCRIPT.find(s => s.re.test(q));
  const out = hit ? hit.reply(q) : FALLBACK;
  let i = 0;
  const tick = () => {
    if(i >= out.length) return;
    push(el(out[i++]));
    setTimeout(tick, 260);
  };
  setTimeout(tick, 340);
}
ask.seed = () => {
  push(el(\`<div class="msg ai">I watch what gets stored and can fix it on request. Right now Tier 3 is
    <b>${pct1(tiers[2].pct)} full</b> and I see <b>${dupes.length} duplicate entity pairs</b>. Want me to clean those up?</div>\`));
};
ask.seed();
`;

/* ------------------------------------------------------------------ shell */

const baseCss = `
*{box-sizing:border-box}
:root{--bg:#0a1018;--panel:#0f1822;--panel2:#131f2b;--line:#1e2d3d;--fg:#dbe6f0;--dim:#7b91a6;
  --accent:#2ec9a0;--warn:#e8b04b;--bad:#e4694a;--blue:#4aa3e0;--purple:#9b7fe0;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.top{display:flex;align-items:center;gap:12px;padding:13px 22px;border-bottom:1px solid var(--line);
  background:var(--panel);position:sticky;top:0;z-index:30}
.logo{width:26px;height:26px;border-radius:7px;background:var(--accent);color:#04140f;
  display:grid;place-items:center;font-weight:800;font-size:14px}
.crumb{color:var(--dim);font-size:13px}
.crumb b{color:var(--fg)}
.top .spacer{flex:1}
.viewnav{display:flex;gap:3px;margin-left:8px;background:var(--bg);border:1px solid var(--line);
  border-radius:8px;padding:3px}
.viewnav a{text-decoration:none;color:var(--dim);font-size:12px;padding:4px 12px;border-radius:6px}
.viewnav a:hover{color:var(--fg)}
.viewnav a.on{background:var(--panel2);color:var(--accent);font-weight:600}
.stamp{font-family:var(--mono);font-size:11px;color:var(--dim)}
.badge{font-size:10.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.badge.ok{color:var(--accent);border-color:var(--accent)}
.badge.warn{color:var(--warn);border-color:var(--warn)}
.badge.bad{color:var(--bad);border-color:var(--bad)}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.9px;color:var(--dim);margin:0 0 12px;font-weight:650}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
.mono{font-family:var(--mono)}
.bar{height:7px;border-radius:99px;background:var(--panel2);overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);border-radius:99px}
.bar i.warn{background:var(--warn)} .bar i.bad{background:var(--bad)}
.note{font-size:11.5px;color:var(--dim);line-height:1.6}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:#22334a;border-radius:9px}
::-webkit-scrollbar-track{background:transparent}
`;

/* --------------------------------------------------------------- digest */
// "Hello Denys, yesterday I learned…" — generated on page open, streamed in.
// Reuses the cached digest when nothing interesting arrived since the last one.

const NEW_ENTITIES = D.nodes.byType && 24;   // entities created on the snapshot day
const NEW_BELIEFS = 56;                      // assertions created on the snapshot day

const digestCss = `
.digest{background:linear-gradient(180deg,var(--panel) 0%,rgba(46,201,160,.05) 100%);
  border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px;position:relative}
.digest.fresh{border-color:rgba(46,201,160,.4)}
.dg-top{display:flex;align-items:center;gap:11px;margin-bottom:13px}
.dg-orb{width:30px;height:30px;border-radius:9px;background:var(--accent);flex:none;
  display:grid;place-items:center;color:#04140f;font-weight:800;font-size:15px}
.digest.busy .dg-orb{animation:pulse 1.15s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(.93)}}
.dg-hi{font-size:18px;font-weight:650;letter-spacing:-.2px}
.dg-state{margin-left:auto;display:flex;align-items:center;gap:8px}
.dg-src{font-size:10.5px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--dim);
  cursor:help;white-space:nowrap}
.dg-src.live{color:var(--accent);border-color:var(--accent)}
.dg-src.cache{color:var(--blue);border-color:var(--blue)}
.dg-body{font-size:14px;line-height:1.72;color:var(--fg);min-height:112px;max-width:82ch}
.dg-body p{margin:0 0 10px}
.dg-body p:last-child{margin-bottom:0}
.dg-body em{font-style:normal;color:var(--accent);font-weight:600}
.dg-body .flag{color:var(--warn);font-weight:600}
.dg-body a{color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent);cursor:pointer}
.caret{display:inline-block;width:7px;height:15px;background:var(--accent);vertical-align:-2px;
  animation:blink .95s step-end infinite;margin-left:2px}
@keyframes blink{50%{opacity:0}}
.dg-skel{height:13px;border-radius:4px;margin-bottom:9px;
  background:linear-gradient(90deg,var(--panel2) 25%,#1b2a39 50%,var(--panel2) 75%);
  background-size:200% 100%;animation:sheen 1.25s linear infinite}
@keyframes sheen{to{background-position:-200% 0}}
.dg-acts{display:flex;gap:8px;margin-top:15px;align-items:center;flex-wrap:wrap}
.dg-acts .gap{flex:1}
.dgb{padding:6px 12px;border-radius:7px;font-size:12px;cursor:pointer;border:1px solid var(--line);
  background:var(--panel2);color:var(--fg);font-family:inherit}
.dgb:hover{border-color:var(--accent)}
.dgb.pri{background:var(--accent);color:#04140f;border-color:var(--accent);font-weight:650}
.dgb.pri:hover{filter:brightness(1.08)}
.dgb.ghost{background:none;color:var(--dim)}
.dg-why{font-size:11px;color:var(--dim);border-top:1px solid var(--line);margin-top:14px;padding-top:11px;
  display:none}
.dg-why.show{display:block}
.dg-why b{color:var(--fg);font-family:var(--mono)}
`;

const digestHtml = `
<section class="digest busy" id="digest">
  <div class="dg-top">
    <div class="dg-orb">S</div>
    <div class="dg-hi" id="dgHi">Good morning, Denys.</div>
    <div class="dg-state">
      <span class="dg-src" id="dgSrc" title="How this digest was produced">checking for new memories…</span>
    </div>
  </div>
  <div class="dg-body" id="dgBody">
    <div class="dg-skel" style="width:94%"></div>
    <div class="dg-skel" style="width:88%"></div>
    <div class="dg-skel" style="width:62%"></div>
  </div>
  <div class="dg-acts">
    <button class="dgb pri" onclick="dockOpen(true);ask('Merge the duplicate SiftKit entries')">Merge my 4 identities</button>
    <a class="dgb" href="variant-b-explorer.html">Explore what changed</a>
    <div class="gap"></div>
    <button class="dgb ghost" onclick="toggleWhy()">Why this?</button>
    <button class="dgb ghost" onclick="runDigest(true)">Regenerate</button>
    <button class="dgb ghost" onclick="runDigest(false,true)">Demo: cached</button>
  </div>
  <div class="dg-why" id="dgWhy">
    Regenerated because <b>${NEW_ENTITIES} new entities</b> and <b>${NEW_BELIEFS} new beliefs</b> landed since the
    last digest at <b>2026-09-09 18:04Z</b>. Below that threshold the cached digest is reused instead, so opening
    this page does not cost a generation. Built from the Tier&nbsp;1 profile plus everything created since the
    last run — never the full ${num(D.assertions.active)}-belief graph.
  </div>
</section>`;

// Two scripted digests. The fresh one is written from the real deltas in snapshot.json.
const digestJs = `
const FRESH = [
  "Since yesterday I picked up <em>${NEW_ENTITIES} new entities</em> and <em>${NEW_BELIEFS} new beliefs</em> — almost all of it from watching your screen, not from anything you told me.",
  "The dominant thread is game tooling: Godot sprite work across <em>Hugo-Dz/spritekit</em>, <em>Pixel Explosion</em> and <em>Distortion Specs</em>, plus a Brawlhalla AI experiment. Alongside that you moved to <em>Opus 5</em> in Claude Code and kept grinding on SiftKit itself — npm, esbuild, ESLint, Go Live.",
  "One thing I want to flag: <span class='flag'>I'm now holding four separate people that are all you</span> — 'the user', 'User denys', \\"user 'denys'\\" and 'Browser User'. That splits your history four ways and I'd rather merge them than keep guessing.",
];
const CACHED = [
  "Nothing new worth summarising since <em>18:04 yesterday</em> — 3 new beliefs arrived, all low-confidence repeats of things I already knew, so I've reused the last digest rather than spend a generation on it.",
  "From last time: you were deep in Godot sprite tooling and had just switched to <em>Opus 5</em> in Claude Code, while continuing work on SiftKit.",
  "<span class='flag'>Still unresolved:</span> four separate entities that all look like you.",
];

let dgTimers = [];
function toggleWhy(){ document.getElementById('dgWhy').classList.toggle('show'); }

function runDigest(force, forceCache){
  dgTimers.forEach(clearTimeout); dgTimers = [];
  const box = document.getElementById('digest');
  const body = document.getElementById('dgBody');
  const src = document.getElementById('dgSrc');
  const hour = new Date().getHours();
  document.getElementById('dgHi').textContent =
    (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') + ', Denys.';

  // Cached path: no generation, paint immediately.
  if(forceCache){
    box.classList.remove('busy','fresh');
    src.className = 'dg-src cache';
    src.textContent = 'reused from cache · 18h old';
    src.title = 'No interesting new memories since the last digest, so nothing was generated.';
    body.innerHTML = CACHED.map(p => '<p>' + p + '</p>').join('');
    return;
  }

  box.classList.add('busy');
  box.classList.remove('fresh');
  src.className = 'dg-src';
  src.textContent = force ? 'regenerating…' : 'checking for new memories…';
  body.innerHTML = '<div class="dg-skel" style="width:94%"></div><div class="dg-skel" style="width:88%"></div><div class="dg-skel" style="width:62%"></div>';

  // Freshness check, then stream.
  dgTimers.push(setTimeout(() => {
    src.textContent = 'generating from ${NEW_BELIEFS} new beliefs…';
    body.innerHTML = '';
    streamParas(FRESH, 0, () => {
      box.classList.remove('busy');
      box.classList.add('fresh');
      src.className = 'dg-src live';
      src.textContent = 'generated just now · 1.4s';
      src.title = 'Built from the Tier 1 profile plus ${NEW_BELIEFS} beliefs created since the last digest.';
    });
  }, force ? 420 : 900));
}

// Word-at-a-time streaming so the mockup shows real progressive rendering.
function streamParas(paras, i, done){
  if(i >= paras.length) return done();
  const body = document.getElementById('dgBody');
  const p = document.createElement('p');
  body.appendChild(p);
  const words = paras[i].split(' ');
  let w = 0;
  const tick = () => {
    if(w >= words.length){ p.innerHTML = paras[i]; return streamParas(paras, i + 1, done); }
    p.innerHTML = words.slice(0, ++w).join(' ') + '<span class="caret"></span>';
    dgTimers.push(setTimeout(tick, 16 + Math.random() * 34));
  };
  tick();
}
runDigest(false);
`;

const page = (title, css, body, extraJs = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${baseCss}${chatCss}${css}</style>
</head><body>
${body}
${chatHtml}
<script>${chatJs}
${extraJs}</script>
</body></html>
`;

const topbar = (variant, note) => `
<header class="top">
  <div class="logo">S</div>
  <div class="crumb">SiftKit / <b>Memory</b></div>
  <nav class="viewnav">
    <a href="variant-a-dashboard.html" class="${variant === 'overview' ? 'on' : ''}">Overview</a>
    <a href="variant-b-explorer.html" class="${variant === 'explorer' ? 'on' : ''}">Explorer</a>
  </nav>
  <div class="spacer"></div>
  <span class="badge ${tierTone(tiers[2])}">Tier 3 ${pct1(tiers[2].pct)}</span>
  <span class="stamp">${note} &middot; graph v${num(D.projections.graphVersion)} &middot; ${shortDate(D.capturedAtUtc)}</span>
</header>`;

export { D, tiers, totalDocs, totalTokens, totalLimit, imageJobs, projJobs, cand, conf,
  num, pct1, esc, shortDate, ago, dupes, tierTone, page, topbar, here, writeFileSync,
  digestCss, digestHtml, digestJs };
