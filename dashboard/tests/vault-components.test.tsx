import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileTree } from '../src/components/vault/FileTree.tsx';
import { NoteMarkdown } from '../src/components/vault/NoteMarkdown.tsx';
import { NoteView } from '../src/components/vault/NoteView.tsx';
import { SearchPanel } from '../src/components/vault/SearchPanel.tsx';
import { QuickSwitcher, StatusBar } from '../src/components/vault/VaultChrome.tsx';
import { DiffView, HistoryPanel, LinksPanel, OutlinePanel, ReviewView } from '../src/components/vault/VaultPanels.tsx';
import { FIXTURE_NOW, NOOP_ACTIONS, noteDetail, summaryOf, vaultNote } from './vault-fixture.ts';

const BODY = [
  'VS Code is your editor on [[Windows]].',
  '**Uses** [[Git]] · [[Ghost]] · Dark Mode',
  '## Plans',
  '- [x] Install #extensions',
  '- [ ] Try [[Cursor]]',
  '> [!unverified]- 1 unverified fact',
  '> - **Uses** [[GitHub]] #unverified',
  '![[attachments/captures/a.png]]',
  '![[attachments/captures/b.png]]',
].join('\n');

const markdown = (overrides: { readonly body?: string; readonly noteId?: string | null; readonly limit?: number } = {}) => renderToStaticMarkup(
  <NoteMarkdown
    body={overrides.body ?? BODY} unresolved={new Set(['ghost'])} colors={new Map([['git', '#123456']])}
    limit={overrides.limit ?? 400} full={false} noteId={overrides.noteId === undefined ? 'vnote_vsc' : overrides.noteId} actions={NOOP_ACTIONS}
  />,
);

test('NoteMarkdown renders the lead, fact pills, callout triage, tasks, tags and thumbnails', () => {
  const html = markdown();
  assert.match(html, /<p class="v-lead">VS Code is your editor on <a class="v-wl" data-link="Windows">Windows<\/a>\.<\/p>/);
  assert.match(html, /<div class="v-facts"><div class="v-frow"><span class="v-flabel">Uses<\/span>/);
  assert.match(html, /<a class="v-pill" data-link="Git"><i style="background:#123456"><\/i>Git<\/a>/);
  assert.match(html, /<a class="v-pill v-unresolved" data-link="Ghost"><i style="background:#3a4c61"><\/i>Ghost<\/a>/);
  assert.match(html, /<span class="v-pill v-txt">Dark Mode<\/span>/);
  assert.match(html, /<h2 id="v-h-2">Plans<\/h2>/);
  assert.match(html, /<li class="v-task v-done"><input type="checkbox" checked=""\/>/);
  assert.match(html, /<span class="v-tag v-t-extensions">#extensions<\/span>/);
  assert.match(html, /<details class="v-callout v-co-unverified"><summary class="v-co-head"><span class="v-co-kind">unverified<\/span>/);
  assert.match(html, /<li class="v-unverified"><span class="v-mini-label">Uses<\/span>.*✓ keep.*✕ drop/);
  assert.match(html, /<div class="v-thumbs"><div class="v-thumb" title="attachments\/captures\/a.png">🖼 a.png<\/div>/);
});

test('NoteMarkdown previews are read-only and cut without a show-all link', () => {
  const preview = markdown({ noteId: null, limit: 7 });
  assert.match(preview, /v-co-unverified/);
  assert.doesNotMatch(preview, /✓ keep/);
  assert.match(preview, /<input type="checkbox" disabled="" checked=""\/>/);
  assert.doesNotMatch(preview, /more lines/);
  assert.match(markdown({ limit: 3 }), /<div class="v-long-note">6 more lines\. <a class="v-wl">Show everything<\/a><\/div>/);
});

test('NoteView shows crumbs, title, mode switch, aliases, the context card and properties', () => {
  const note = vaultNote({ aliases: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'], tags: ['tool'] });
  const linker = summaryOf(vaultNote({ id: 'vnote_me', title: 'Denys' }));
  const html = renderToStaticMarkup(
    <NoteView detail={noteDetail(note, { backlinks: [{ note: linker, labels: ['Uses'] }] })} mode="read" full={false} colors={new Map()} entries={[]} nowMs={FIXTURE_NOW} actions={NOOP_ACTIONS} />,
  );
  assert.match(html, /<div class="v-crumbs"><span>Software<span class="v-sep"> \/<\/span><\/span><span>Visual Studio Code<\/span><\/div>/);
  assert.match(html, /<h1 title="Click to rename">Visual Studio Code<\/h1>/);
  assert.match(html, /<button type="button" class="v-on">Read<\/button><button type="button">Edit<\/button>/);
  assert.match(html, /also known as <span><b>a1<\/b><\/span>.*<b>a5<\/b><\/span> and 2 more/);
  assert.match(html, /<h4>Where it shows up<\/h4>.*Uses ←.*data-link="Denys"/);
  assert.match(html, /<summary>Properties · software · 3 revisions · updated 1h ago<\/summary>/);
});

test('NoteView in edit mode renders the editor with the body, and owner notes skip the context card', () => {
  const owner = vaultNote({ tags: ['me'], body: 'Me' });
  const linker = summaryOf(vaultNote({ id: 'vnote_x', title: 'X' }));
  const detail = noteDetail(owner, { backlinks: [{ note: linker, labels: [] }] });
  const edit = renderToStaticMarkup(<NoteView detail={detail} mode="edit" full={false} colors={new Map()} entries={[]} nowMs={FIXTURE_NOW} actions={NOOP_ACTIONS} />);
  assert.match(edit, /<textarea class="v-editor" spellCheck="false" autofocus="">Me<\/textarea>/);
  assert.match(edit, /Save · creates a revision/);
  const read = renderToStaticMarkup(<NoteView detail={detail} mode="read" full={false} colors={new Map()} entries={[]} nowMs={FIXTURE_NOW} actions={NOOP_ACTIONS} />);
  assert.doesNotMatch(read, /Where it shows up/);
});

test('FileTree lists starred notes, folders with icons and counts, open folder notes and the stub toggle', () => {
  const note = vaultNote();
  const html = renderToStaticMarkup(
    <FileTree
      folders={[{ path: 'Software', name: 'Software', depth: 0, count: 3 }, { path: 'Software/Editors', name: 'Editors', depth: 1, count: 1 }, { path: 'People', name: 'People', depth: 0, count: 9 }]}
      folderNotes={new Map([['Software', [summaryOf(note)]]])} expanded={new Set(['Software'])}
      starred={[{ note: summaryOf(vaultNote({ id: 'vnote_me', title: 'Denys', folder: 'People' })), owner: true }]}
      showStubs={false} stubCount={1234} activeNoteId={note.id} actions={NOOP_ACTIONS}
    />,
  );
  assert.match(html, /<span class="v-ico">★<\/span><span class="v-name">Denys \(you\)<\/span>/);
  assert.ok(html.indexOf('>People<') < html.indexOf('>Software<'), 'folders sort by count');
  assert.match(html, /<span class="v-chev">▾<\/span><span class="v-ico">⌨<\/span><span class="v-name">Software<\/span><span class="v-count">3<\/span>/);
  assert.match(html, /<span class="v-name">Editors<\/span>/);
  assert.match(html, /<div class="v-row v-active" style="padding-left:20px"><span class="v-name">Visual Studio Code<\/span><\/div>/);
  assert.match(html, /\+ 1 more — search or use Ctrl\+O/);
  assert.match(html, /\+ 1,234 link-only notes hidden/);
});

test('SearchPanel shows help for an empty query and highlighted hits otherwise', () => {
  assert.match(renderToStaticMarkup(<SearchPanel query="" result={null} actions={NOOP_ACTIONS} />), /Filters: <code>tag:#unverified<\/code>/);
  const note = summaryOf(vaultNote());
  const html = renderToStaticMarkup(
    <SearchPanel query="tag:#x studio" result={{ total: 3, hits: [{ note, score: 40, snippet: 'Uses Studio daily' }] }} actions={NOOP_ACTIONS} />,
  );
  assert.match(html, /3 notes · showing 1/);
  assert.match(html, /Visual <mark>Studio<\/mark> Code/);
  assert.match(html, /Uses <mark>Studio<\/mark> daily/);
});

test('LinksPanel lists linked mentions with labels, outgoing chips and unlinked mentions', () => {
  const note = vaultNote();
  const other = summaryOf(vaultNote({ id: 'vnote_git', title: 'Git' }));
  const html = renderToStaticMarkup(
    <LinksPanel
      detail={noteDetail(note, { backlinks: [{ note: other, labels: ['Uses'] }], outgoing: { resolved: [other], unresolved: [] } })}
      unlinked={[summaryOf(vaultNote({ id: 'vnote_blog', title: 'Blog' }))]} colors={new Map()} actions={NOOP_ACTIONS}
    />,
  );
  assert.match(html, /Linked mentions <span>1<\/span>/);
  assert.match(html, /<div class="v-bl-ctx"><span class="v-mini-label">Uses<\/span><\/div>/);
  assert.match(html, /Outgoing links <span>1<\/span>.*<span class="v-chip">Git<\/span>/);
  assert.match(html, /Blog<small><a class="v-wl">link it<\/a><\/small>/);
});

test('OutlinePanel lists headings with bullet counts', () => {
  const html = renderToStaticMarkup(<OutlinePanel body={'## Plans\n- a\n- b\n### Sub'} actions={NOOP_ACTIONS} />);
  assert.match(html, /<div style="padding-left:16px">Plans<small>2<\/small><\/div><div style="padding-left:26px">Sub<small><\/small><\/div>/);
});

test('HistoryPanel lists revisions newest first with actor colours and the selected diff', () => {
  const html = renderToStaticMarkup(
    <HistoryPanel
      noteId="vnote_vsc" selected={2} nowMs={FIXTURE_NOW} actions={NOOP_ACTIONS}
      revisions={[
        { revision: 1, actor: 'migration', summary: 'Migrated', sourceRef: null, createdAtUtc: '2026-10-20T09:00:00.000Z' },
        { revision: 2, actor: 'note-writer · tidy', summary: 'Tidy', sourceRef: null, createdAtUtc: '2026-10-23T09:00:00.000Z' },
        { revision: 3, actor: 'you', summary: 'Edited', sourceRef: null, createdAtUtc: '2026-10-24T11:30:00.000Z' },
      ]}
    />,
  );
  assert.ok(html.indexOf('r3 · you') < html.indexOf('r2 · note-writer · tidy'));
  assert.match(html, /<div class="v-rev v-actor-tidy v-sel">/);
  assert.match(html, /<div class="v-rev v-actor-migration">/);
  assert.match(html, /2026-10-24 11:30 · 30m ago/);
});

test('DiffView counts changes, collapses context and offers restore only for older revisions', () => {
  const before = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n');
  const revision = {
    revision: 2, actor: 'you' as const, summary: 'Edited', sourceRef: null, createdAtUtc: '2026-10-24T11:00:00.000Z',
    title: 'T', folder: '', body: before.replace('line 6', 'line six'), types: [], aliases: [], tags: [],
  };
  const older = renderToStaticMarkup(<DiffView noteId="n" title="T" revision={revision} before={before} isCurrent={false} actions={NOOP_ACTIONS} />);
  assert.match(older, /<span class="v-plus">\+1<\/span> <span class="v-minus">−1<\/span>/);
  assert.match(older, /<div class="v-gap">⋯<\/div><div class="v-ctx">line 3<\/div>/);
  assert.match(older, /<div class="v-del">line 6<\/div><div class="v-add">line six<\/div>/);
  assert.match(older, /Restore this version/);
  const current = renderToStaticMarkup(<DiffView noteId="n" title="T" revision={revision} before={before} isCurrent actions={NOOP_ACTIONS} />);
  assert.doesNotMatch(current, /Restore this version/);
  assert.match(current, /<span class="v-chip">current<\/span>/);
});

test('ReviewView shows totals and one triage row per unverified fact, with what a flag replaces or doubts', () => {
  const note = summaryOf(vaultNote());
  const html = renderToStaticMarkup(
    <ReviewView
      review={{ total: 3, items: [
        { note, line: 6, label: 'Uses', value: '[[GitHub]]', flag: null },
        { note, line: 7, label: 'Editor', value: 'Helix', flag: { kind: 'replaces', value: 'Neovim' } },
        { note, line: 8, label: 'Hobby', value: 'juggling', flag: { kind: 'doubt', reason: 'implausible' } },
      ] }}
      stats={{ notes: 1, links: 0, tags: 0, stubs: 0, notesWithUnverified: 1, byKind: { entity: 1, capture: 0, daily: 0, chat: 0, note: 0 } }}
      actions={NOOP_ACTIONS}
    />,
  );
  assert.match(html, /<b>3<\/b><small>unverified facts<\/small>/);
  assert.match(html, /Helix<small class="v-flag"> replaces Neovim<\/small>/);
  assert.match(html, /juggling<small class="v-flag"> doubt: implausible<\/small>/);
  assert.match(html, /<a class="v-wl">Visual Studio Code<\/a> · <span class="v-mini-label">Uses<\/span><a class="v-wl" data-link="GitHub">GitHub<\/a>/);
  assert.match(html, /<span class="v-actions v-always"><button type="button">✓<\/button><button type="button">✕<\/button><\/span>/);
});

test('StatusBar shows vault counts, the active note size and the export button', () => {
  const html = renderToStaticMarkup(
    <StatusBar
      stats={{ notes: 1200, links: 30, tags: 4, stubs: 5, notesWithUnverified: 7, byKind: { entity: 1, capture: 0, daily: 0, chat: 0, note: 0 } }}
      activeBody={'a\nb'} activeDegree={9} actions={NOOP_ACTIONS}
    />,
  );
  assert.match(html, /<b>1,200<\/b> notes · <b>7<\/b> with unverified facts/);
  assert.match(html, /2 lines · 9 links/);
  assert.match(html, /Export as \.md/);
});

test('QuickSwitcher lists the best-linked notes before any query', () => {
  const html = renderToStaticMarkup(
    <QuickSwitcher
      entries={[
        { id: 'a', title: 'Alpha', folder: '', topFolder: '', kind: 'note', degree: 1 },
        { id: 'b', title: 'Beta', folder: 'Topics', topFolder: 'Topics', kind: 'entity', degree: 5 },
      ]}
      actions={NOOP_ACTIONS}
    />,
  );
  assert.match(html, /<div class="v-item v-sel"><span>Beta<\/span><small>Topics<\/small><\/div><div class="v-item"><span>Alpha<\/span><small>\/<\/small><\/div>/);
  assert.doesNotMatch(html, /Create/);
});
