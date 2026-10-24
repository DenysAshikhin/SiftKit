// Prototype of the deterministic graph→vault migration; writes mockup data from the live runtime DB.
// Run: node docs/mockups/vault/build-data.mjs .siftkit/runtime.sqlite docs/mockups/vault/vault-data.js
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const [dbPath, outPath] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const q = (s, ...a) => db.prepare(s).all(...a);

const OWNER_TITLE = 'Denys Ashikhin';
const CUTOVER = '2026-10-24T00:00:00.000Z';
const FOLDER = { person: 'People', software: 'Software', device: 'Devices', project: 'Projects',
  configuration_profile: 'Setups', home_asset: 'Home', topic: 'Topics', question_topic: 'Topics',
  organization: 'Organizations', event: 'Events', model: 'Models', vehicle: 'Vehicles', goal: 'Goals',
  place: 'Places', document: 'Documents', media_work: 'Media', preference_context: 'Contexts' };
const TYPE_LABEL = { software: 'tool', configuration_profile: 'setup', home_asset: 'thing at home',
  media_work: 'title', preference_context: 'context', question_topic: 'topic', food_recipe: 'recipe' };
// [first person, third person] verb phrases per predicate.
const VERB = { USES: ['use', 'uses'], WORKS_ON: ['work on', 'works on'], INTERESTED_IN: ['are into', 'is into'],
  WATCHED: ['watched', 'watched'], PLAYED: ['played', 'played'], PREFERS: ['prefer', 'prefers'],
  AVOIDS: ['avoid', 'avoids'], DISLIKES: ['dislike', 'dislikes'], LIVES_IN: ['live in', 'lives in'],
  LOCATED_IN: ['are in', 'is in'], OWNS: ['own', 'owns'], DRIVES: ['drive', 'drives'],
  CREATED: ['created', 'created'], READ: ['read', 'read'], CONTRIBUTED_TO: ['contributed to', 'contributed to'],
  DEPENDS_ON: ['depend on', 'depends on'], PART_OF: ['are part of', 'is part of'],
  HAS_COMPONENT: ['have', 'includes'], RUNS_ON: ['run on', 'runs on'], TESTED_WITH: ['tested with', 'was tested with'],
  COMPARED_WITH: ['compared with', 'gets compared with'], RELATED_TO: ['relate to', 'relates to'],
  MENTIONED_IN: ['show up in', 'shows up in'], HAS_ROLE: ['work as', 'works as'], HAS_SETTING: ['set', 'is set to'],
  CONFIGURED_WITH: ['configured', 'is configured with'], ASKED_ABOUT: ['asked about', 'asked about'],
  RESULTED_IN: ['led to', 'led to'], HAS_CONSTRAINT: ['are limited by', 'is limited by'] };
const ROW_LABEL = { USES: 'Uses', WORKS_ON: 'Works on', INTERESTED_IN: 'Into', WATCHED: 'Watched', PLAYED: 'Played',
  PREFERS: 'Prefers', AVOIDS: 'Avoids', DISLIKES: 'Dislikes', LIVES_IN: 'Lives in', LOCATED_IN: 'In', OWNS: 'Owns',
  DRIVES: 'Drives', CREATED: 'Created', READ: 'Read', CONTRIBUTED_TO: 'Contributed to', DEPENDS_ON: 'Depends on',
  PART_OF: 'Part of', HAS_COMPONENT: 'Includes', RUNS_ON: 'Runs on', TESTED_WITH: 'Tested with',
  COMPARED_WITH: 'Compared with', RELATED_TO: 'Related', MENTIONED_IN: 'Shows up in', HAS_ROLE: 'Role',
  HAS_SETTING: 'Settings', CONFIGURED_WITH: 'Configured with', ASKED_ABOUT: 'Asked about', RESULTED_IN: 'Led to',
  HAS_CONSTRAINT: 'Constraints' };
const TASKY = { HAS_PLAN: 'Plans', HAS_GOAL: 'Goals' };
const GENERIC = new Set(['person', 'people', 'user', 'users', 'unknown', 'unknownuser', 'unknownperson', 'unidentifieduser',
  'unidentifiedperson', 'person1', 'someone', 'the', 'it', 'null', 'na', 'none', 'project', 'software', 'computer',
  'device', 'app', 'application', 'thing', 'other', 'browser', 'website']);
const APP_NAMES = { code: 'Visual Studio Code', chrome: 'Google Chrome', discord: 'Discord', explorer: 'File Explorer',
  windowsterminal: 'Windows Terminal', msedge: 'Microsoft Edge', firefox: 'Firefox' };
const ROW_LIMIT = 8;
const MORE_LIMIT = 300;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const safeTitle = (s) => s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Untitled';
const day = (iso) => iso.slice(0, 10);
const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
const article = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
// The live graph splits the owner across OCR misreads of "denys"; fold them back into one note.
function isOwnerName(name) {
  const t = name.trim();
  if (/'s|[/\.]/.test(t)) return false;
  if (/^(the[ _]?user|user|current user|local user|me|myself|self|main[ _]person|browser user|reddit user|you)$/i.test(t)) return true;
  if (/(user)|denys|denvs|ashikh|ashkh/i.test(t)) return true;
  const n = norm(t.replace(/^user[\s:_-]+/i, ''));
  return n.startsWith('d') && n.length >= 4 && n.length <= 7 && levenshtein(n, 'denys') <= (n.includes('y') ? 3 : 2);
}
const isJunk = (title) => (title.match(/[a-z]/gi) ?? []).length < 2 || GENERIC.has(norm(title))
  || /^(unidentified|unknown|anonymous|account (holder|[a-z])$|person d)/i.test(title.trim());

/* ---- nodes → notes */
const nodes = q(`select id, type, display_name, canonical_key, created_at_utc from graph_nodes where status='active'`);
const aliasesByNode = new Map();
for (const a of q(`select node_id, alias from graph_node_aliases`)) {
  aliasesByNode.set(a.node_id, [...(aliasesByNode.get(a.node_id) ?? []), a.alias]);
}
const notes = new Map();
const noteByNode = new Map();
const noteByName = new Map();
function ensureNote(key, title, type, created) {
  let n = notes.get(key);
  if (!n) {
    n = { key, title, types: new Map(), aliases: new Set(), created, updated: created, facts: [], inbound: [] };
    notes.set(key, n);
  }
  n.types.set(type, (n.types.get(type) ?? 0) + 1);
  if (created < n.created) n.created = created;
  return n;
}
for (const node of nodes) {
  const owner = node.canonical_key === 'person:owner' || (['person', 'account'].includes(node.type) && isOwnerName(node.display_name));
  if (!owner && isJunk(node.display_name)) continue;
  const key = owner ? 'owner' : (norm(node.display_name) || node.id);
  const note = ensureNote(key, owner ? OWNER_TITLE : safeTitle(node.display_name), node.type, node.created_at_utc);
  if (node.display_name !== note.title) note.aliases.add(node.display_name);
  for (const a of aliasesByNode.get(node.id) ?? []) if (a !== note.title && !isJunk(a)) note.aliases.add(a);
  noteByNode.set(node.id, note);
  if (!noteByName.has(norm(node.display_name))) noteByName.set(norm(node.display_name), note);
}
const owner = notes.get('owner') ?? ensureNote('owner', OWNER_TITLE, 'person', CUTOVER);

/* ---- facts */
const literal = (v) => { try { const x = JSON.parse(v); return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(v); } };
function addFact(subject, predicate, obj, at, evId, unverified) {
  const dupKey = `${predicate}|${obj.note ? obj.note.key : obj.text.toLowerCase()}`;
  if (subject.facts.some((f) => f.dupKey === dupKey)) return false;
  subject.facts.push({ predicate, obj, at, evId, dupKey, unverified, r: 0 });
  if (at > subject.updated) subject.updated = at;
  return true;
}
const assertions = q(`select a.subject_node_id s, a.predicate p, a.object_kind k, a.object_node_id o, a.object_value_json v,
  a.created_at_utc t, (select ae.evidence_id from assertion_evidence ae where ae.assertion_id=a.id and ae.stance='supports'
  order by ae.created_at_utc limit 1) ev from graph_assertions a where a.status='active'`);
for (const a of assertions) {
  const subject = noteByNode.get(a.s);
  if (!subject) continue;
  const objNote = a.k === 'node' ? noteByNode.get(a.o) : null;
  if (a.k === 'node' && !objNote) continue;
  if (objNote === subject) continue;
  addFact(subject, a.p, objNote ? { note: objNote } : { text: literal(a.v) }, a.t, a.ev, false);
}
const candidates = q(`select subject_ref_json s, predicate p, object_ref_json o, created_at_utc t
  from candidate_assertions where status in ('pending','needs_confirmation')`);
function resolveRef(ref, typeHint) {
  if (ref.kind === 'literal') return { text: literal(JSON.stringify(ref.value ?? ref.text ?? '')) };
  const name = ref.displayName ?? '';
  if (!name) return null;
  if ((ref.nodeType ?? typeHint) === 'person' && isOwnerName(name)) return { note: owner };
  if (isJunk(name)) return null;
  const note = noteByName.get(norm(name)) ?? ensureNote(norm(name), safeTitle(name), ref.nodeType ?? 'topic', CUTOVER);
  noteByName.set(norm(name), note);
  return { note };
}
let unverified = 0;
for (const c of candidates) {
  const s = resolveRef(JSON.parse(c.s), 'person');
  const o = resolveRef(JSON.parse(c.o), null);
  if (!s?.note || !o || o.note === s.note) continue;
  if (addFact(s.note, c.p, o, c.t, null, true)) unverified += 1;
}

/* ---- plans and goals whose object is only a sentence become checklist text, not notes */
for (const n of notes.values()) for (const f of n.facts) if (f.obj.note) f.obj.note.inbound.push({ from: n, f });
const linkable = (note) => note === owner || note.facts.length > 0 || note.inbound.some((i) => !TASKY[i.f.predicate]);
for (const n of notes.values()) {
  for (const f of n.facts) if (f.obj.note && !linkable(f.obj.note)) f.obj = { text: f.obj.note.title };
}
const emitted = [...notes.values()].filter((n) => n === owner || n.facts.length > 0 || n.inbound.some((i) => i.f.obj.note === n));
const importance = (n) => n.inbound.length * 2 + n.facts.length;
const mainType = (n) => [...n.types.entries()].sort((a, b) => b[1] - a[1])[0][0];

/* ---- revisions: post-cutover facts become note-writer revisions grouped by evidence */
const evidence = new Map(q(`select id, source_type from evidence_records
  where source_type in ('screenshot','conversation_message')`).map((e) => [e.id, e]));
for (const n of emitted) {
  n.revs = [{ at: CUTOVER, actor: 'migration', summary: 'Imported from the knowledge graph' }];
  const byKey = new Map();
  for (const f of n.facts.sort((a, b) => a.at.localeCompare(b.at))) {
    if (f.at <= CUTOVER || f.unverified) continue;
    const k = f.evId ?? `t:${f.at.slice(0, 13)}`;
    if (!byKey.has(k)) {
      const chat = f.evId && evidence.get(f.evId)?.source_type === 'conversation_message';
      n.revs.push({ at: f.at, actor: chat ? 'note-writer · chat' : 'note-writer · screenshot', evId: f.evId ?? null, added: 0 });
      byKey.set(k, n.revs.length - 1);
    }
    f.r = byKey.get(k);
    n.revs[f.r].added += 1;
  }
  for (const rev of n.revs.slice(1)) rev.summary = `Learned ${plural(rev.added, 'new fact')}`;
}

/* ---- markdown */
const link = (note) => `[[${note.title}]]`;
const objMd = (o) => (o.note ? link(o.note) : o.text);
const listProse = (items, total) => {
  const shown = items.map((f) => objMd(f.obj));
  const rest = total - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${plural(rest, 'other')}`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
};
const rank = (a, b) => (b.obj.note ? importance(b.obj.note) : 0) - (a.obj.note ? importance(a.obj.note) : 0) || b.at.localeCompare(a.at);

function entityMarkdown(n, k) {
  const facts = n.facts.filter((f) => f.r <= k);
  const verified = facts.filter((f) => !f.unverified);
  const groups = new Map();
  for (const f of verified) {
    if (!groups.has(f.predicate)) groups.set(f.predicate, []);
    groups.get(f.predicate).push(f);
  }
  for (const g of groups.values()) g.sort(rank);
  const regular = [...groups.entries()].filter(([p]) => !TASKY[p]).sort((a, b) => b[1].length - a[1].length);
  const isOwner = n === owner;
  const out = [];

  // Lead: a couple of plain sentences built from the strongest facts.
  const lead = [];
  const ownerVerbs = n.inbound.filter((i) => i.from === owner && !i.f.unverified).map((i) => VERB[i.f.predicate]?.[0]).filter(Boolean);
  if (isOwner) lead.push('This is you.');
  else lead.push(`${n.title} is ${article(TYPE_LABEL[mainType(n)] ?? mainType(n).replace(/_/g, ' '))}${ownerVerbs.length ? ` you ${[...new Set(ownerVerbs)].slice(0, 2).join(' and ')}` : ''}.`);
  const used = new Map();
  for (const [p, fs] of regular.slice(0, isOwner ? 3 : 2)) {
    if (!VERB[p]) continue;
    const take = fs.slice(0, 3);
    used.set(p, take.length);
    lead.push(`${isOwner ? 'You' : 'It'} ${VERB[p][isOwner ? 0 : 1]} ${listProse(take, fs.length)}.`);
  }
  out.push(lead.join(' '), '');

  // Rows: the rest of each predicate as compact link lists; the long tail folds away.
  const more = [];
  for (const [p, fs] of regular) {
    const rest = fs.slice(used.get(p) ?? 0);
    if (rest.length === 0) continue;
    out.push(`**${ROW_LABEL[p] ?? p}** ${rest.slice(0, ROW_LIMIT).map((f) => objMd(f.obj)).join(' · ')}`);
    if (rest.length > ROW_LIMIT) more.push([p, rest.slice(ROW_LIMIT)]);
  }
  if (out.at(-1) !== '') out.push('');
  for (const [p, rest] of [...groups.entries()].filter(([pp]) => TASKY[pp])) {
    out.push(`## ${TASKY[p]}`, ...rest.slice(0, 12).map((f) => `- [ ] ${objMd(f.obj)}`), '');
    if (rest.length > 12) more.push([p, rest.slice(12)]);
  }
  for (const [p, rest] of more) {
    out.push(`> [!more]- ${rest.length.toLocaleString('en-US')} more · ${(ROW_LABEL[p] ?? TASKY[p] ?? p).toLowerCase()}`);
    out.push(`> ${rest.slice(0, MORE_LIMIT).map((f) => objMd(f.obj)).join(' · ')}${rest.length > MORE_LIMIT ? ` · …and ${rest.length - MORE_LIMIT} more` : ''}`, '');
  }
  const pending = facts.filter((f) => f.unverified);
  if (pending.length) {
    out.push(`> [!unverified]- ${plural(pending.length, 'unverified fact')}`);
    out.push(...pending.slice(0, 200).map((f) => `> - **${ROW_LABEL[f.predicate] ?? TASKY[f.predicate] ?? f.predicate}** ${objMd(f.obj)} #unverified`), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---- captures, chats, dailies */
const factsByEvidence = new Map();
for (const n of emitted) for (const f of n.facts) if (f.evId) factsByEvidence.set(f.evId, [...(factsByEvidence.get(f.evId) ?? []), { n, f }]);
const learnedLine = ({ n, f }) => `- ${n === owner ? 'You' : link(n)} ${VERB[f.predicate]?.[n === owner ? 0 : 1] ?? (TASKY[f.predicate] ? 'plan to' : f.predicate.toLowerCase())} ${objMd(f.obj)}`;
const queueState = new Map(q(`select evidence_id, state from assistant_capture_queue`).map((r) => [r.evidence_id, r.state]));
const captures = q(`select id, captured_at_utc, metadata_json from evidence_records
  where source_type='screenshot' and status='active' order by captured_at_utc`).map((s) => {
  const meta = JSON.parse(s.metadata_json);
  const ctx = String(meta.foregroundContextKey ?? '');
  const proc = (ctx.match(/^app:([^|]+)/)?.[1] ?? 'unknown').replace(/\.exe$/i, '');
  const app = APP_NAMES[proc.toLowerCase()] ?? proc;
  const appNote = noteByName.get(norm(app));
  const windowTitle = ctx.split('|').slice(1).join('|');
  const state = queueState.get(s.id) ?? 'processed';
  const learned = factsByEvidence.get(s.id) ?? [];
  const title = `${day(s.captured_at_utc)} ${s.captured_at_utc.slice(11, 16).replace(':', '.')} ${safeTitle(app)}`;
  const lines = [
    `![[captures/${s.id}.png]]`, '',
    `${appNote ? link(appNote) : app}${windowTitle ? ` · \`${windowTitle.slice(0, 80)}\`` : ''} · ${String(meta.reason ?? '').replace('_', ' ')}`, '',
    ...(state !== 'processed' ? [`> [!pending] Waiting for the note-writer.`]
      : learned.length ? ['## Learned', ...learned.map(learnedLine)] : []),
  ];
  return { title, at: s.captured_at_utc, state, app, appNote, windowTitle, evId: s.id, learned, md: lines.join('\n').trim() };
});
const chats = q(`select source_ref sid, min(captured_at_utc) t, count(*) n from evidence_records
  where source_type='conversation_message' group by source_ref order by t`).map((c) => {
  const learned = q(`select id from evidence_records where source_ref=? and source_type='conversation_message'`, c.sid)
    .flatMap((r) => factsByEvidence.get(r.id) ?? []);
  return { title: `${day(c.t)} Chat ${c.sid.slice(0, 8)}`, at: c.t, learned, md: [
    `A chat of ${plural(c.n, 'message')}. The transcript is decrypted from evidence during migration.`,
    ...(learned.length ? ['', '## Learned', ...learned.map(learnedLine)] : []),
  ].join('\n') };
});

const out = [];
const usedTitles = new Set();
const uniqueTitle = (t) => { let x = t; while (usedTitles.has(x.toLowerCase())) x += ' (2)'; usedTitles.add(x.toLowerCase()); return x; };
for (const n of emitted) {
  n.title = n === owner ? n.title : uniqueTitle(n.title);
}
usedTitles.add(owner.title.toLowerCase());
for (const n of emitted) {
  const revs = n.revs.map((r, k) => ({ ...r, snapshot: entityMarkdown(n, k) }));
  const type = mainType(n);
  out.push({ title: n.title, folder: n === owner ? '' : (FOLDER[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1).replace(/_/g, ' ').replace(/y$/, 'ie')}s`),
    types: [...n.types.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t), aliases: [...n.aliases].slice(0, 40), tags: n === owner ? ['me'] : [],
    created: n.created, updated: n.updated, revs, unverified: n.facts.filter((f) => f.unverified).length,
    stub: n.facts.length === 0 });
}
for (const c of captures) {
  out.push({ title: uniqueTitle(c.title), folder: `Captures/${day(c.at)}`, types: ['capture'], aliases: [],
    tags: c.state === 'processed' ? ['capture'] : ['capture', 'pending'], created: c.at, updated: c.at,
    revs: [{ at: c.at, actor: c.state === 'processed' ? 'migration' : 'capture-intake', summary: c.state === 'processed' ? 'Imported screenshot' : 'Screenshot stored; waiting for the note-writer', snapshot: c.md }],
    capture: { app: c.app, window: c.windowTitle, state: c.state, evId: c.evId } });
}
for (const c of chats) {
  out.push({ title: uniqueTitle(c.title), folder: 'Chats', types: ['chat'], aliases: [], tags: ['chat'], created: c.at, updated: c.at,
    revs: [{ at: c.at, actor: 'migration', summary: 'Imported chat', snapshot: c.md }] });
}
for (const d of [...new Set([...captures, ...chats].map((c) => day(c.at)))].sort()) {
  const caps = captures.filter((c) => day(c.at) === d);
  const dayChats = chats.filter((c) => day(c.at) === d);
  const byApp = new Map();
  for (const c of caps) byApp.set(c.app, [...(byApp.get(c.app) ?? []), c]);
  const apps = [...byApp.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3)
    .map(([app, cs]) => `${cs[0].appNote ? link(cs[0].appNote) : app} (${cs.length})`);
  const learned = [...caps, ...dayChats].flatMap((c) => c.learned ?? []);
  const lead = [
    caps.length ? `Mostly in ${apps.length > 1 ? `${apps.slice(0, -1).join(', ')} and ${apps.at(-1)}` : apps[0]}.` : '',
    learned.length ? `Learned ${plural(learned.length, 'new thing')}.` : '',
    dayChats.length ? `${plural(dayChats.length, 'chat')}.` : '',
  ].filter(Boolean).join(' ');
  const md = [lead, '',
    ...caps.slice(-24).reverse().map((c) => `![[captures/${c.evId}.png]]`),
    ...(caps.length > 24 ? [`_…and ${caps.length - 24} earlier captures in [[${caps[0].title}|Captures/${d}]]._`] : []), '',
    ...(learned.length ? ['## Learned', ...learned.slice(0, 40).map(learnedLine), ''] : []),
    ...(dayChats.length ? ['## Chats', ...dayChats.map((c) => `- [[${c.title}]]`)] : []),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  out.push({ title: uniqueTitle(d), folder: 'Daily', types: ['daily'], aliases: [], tags: ['daily'],
    created: `${d}T00:00:00.000Z`, updated: caps.at(-1)?.at ?? `${d}T00:00:00.000Z`,
    revs: [{ at: `${d}T23:59:00.000Z`, actor: 'note-writer · daily', summary: 'Daily rollup', snapshot: md }] });
}

const stats = {
  generatedAtUtc: new Date().toISOString(),
  source: { nodes: nodes.length, assertions: assertions.length, candidates: candidates.length, screenshots: captures.length, chats: chats.length },
  vault: { notes: out.length, entityNotes: emitted.length, stubs: emitted.filter((n) => n.facts.length === 0).length,
    captures: captures.length, unverified, ownerAliases: owner.aliases.size },
  pendingQueue: q(`select state, count(*) n from assistant_capture_queue where state in ('queued','awaiting_image_capability') group by 1`),
};
writeFileSync(outPath, `// Generated from .siftkit/runtime.sqlite by docs/mockups/vault/build-data.mjs.\nwindow.VAULT = ${JSON.stringify({ stats, notes: out })};\n`);
console.log(JSON.stringify(stats));
