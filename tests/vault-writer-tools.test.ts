import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.ts';
import { VaultValidationQueue } from '../src/vault/validation-queue.ts';
import { candidateCards, ownerCard, reviewCards } from '../src/vault/note-writer/agent/cards.ts';
import { SUBMIT_EDITS_TOOL, VAULT_WRITER_TOOLS, toInferenceTool } from '../src/vault/note-writer/agent/definitions.ts';
import { MAX_RESULT_CHARS, VaultWriterTools } from '../src/vault/note-writer/agent/tools.ts';
import { TEST_META, entityInput, withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

const accessed = (context: VaultTestContext, id: string) => z.object({ last_accessed_at_utc: z.string().nullable() })
  .parse(context.database.prepare('SELECT last_accessed_at_utc FROM vault_notes WHERE id = ?').get(id)).last_accessed_at_utc;

const pointAccess = (context: VaultTestContext, id: string) => z.array(z.object({ value: z.string(), last_accessed_at_utc: z.string().nullable() }))
  .parse(context.database.prepare('SELECT value, last_accessed_at_utc FROM vault_fact_points WHERE note_id = ? ORDER BY value_key').all(id));

function tools(context: VaultTestContext) {
  return new VaultWriterTools({ database: context.database, store: context.store, clock: context.clock, day: '2026-10-24' });
}

test('read_note resolves an alias, lists values with their ages, and stamps the note and shown values accessed', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Visual Studio Code', 'Editor.\n\n**Uses** [[TypeScript]] · GitLens', { aliases: ['vscode'] }), TEST_META);
    context.clock.advanceDays(12);
    const text = tools(context).execute('read_note', { title: 'VSCode', page: 1 });
    assert.match(text, /^# Visual Studio Code {2}\(Software · software\)$/m);
    assert.match(text, /^aliases: vscode$/m);
    assert.match(text, /^lead: Editor\.$/m);
    assert.match(text, /^- \*\*Uses\*\* \[\[TypeScript\]\] — added 12d · edited 12d · validated never$/m);
    assert.equal(accessed(context, note.id), context.clock.nowUtc());
    assert.deepEqual(pointAccess(context, note.id).map((row) => row.last_accessed_at_utc), [context.clock.nowUtc(), context.clock.nowUtc()]);
  });
});

test('read_note pages 40 values at a time and says how to get the next page', () => {
  withVault((context) => {
    const values = Array.from({ length: 45 }, (_, index) => `v${index}`);
    const rows = Array.from({ length: 6 }, (_, row) => `**Row ${row}** ${values.slice(row * 8, row * 8 + 8).join(' · ')}`).join('\n');
    const note = context.store.create(entityInput('Big', `Big note.\n\n${rows}`), TEST_META);
    const first = tools(context).execute('read_note', { title: 'Big', page: 1 });
    assert.match(first, /values 1–40 of 45 · next page 2/);
    assert.equal(pointAccess(context, note.id).filter((row) => row.last_accessed_at_utc !== null).length, 40, 'only the page shown is stamped');
    const second = tools(context).execute('read_note', { title: 'Big', page: 2 });
    assert.match(second, /\*\*Row 5\*\* v44/);
    assert.doesNotMatch(second, /next page/);
  });
});

test('read_note lists open tasks, flagged unverified items and labelled backlinks', () => {
  withVault((context) => {
    context.store.create(entityInput('Neovim', 'Editor.\n\n## Plans\n- [ ] Try LazyVim\n- [x] Install\n\n> [!unverified]- 1 unverified fact\n> - **Uses** Helix #unverified (replaces: Vim)'), TEST_META);
    context.store.create(entityInput('Denys', 'Owner.\n\n**Edits with** [[Neovim]]'), TEST_META);
    const text = tools(context).execute('read_note', { title: 'Neovim', page: 1 });
    assert.match(text, /open tasks:\n- Try LazyVim\n/);
    assert.doesNotMatch(text, /- Install/);
    assert.match(text, /unverified:\n- \*\*Uses\*\* Helix \(replaces: Vim\)/);
    assert.match(text, /backlinks:\n- Denys —Edits with→ Neovim/);
  });
});

test('a miss names the closest notes instead of failing', () => {
  withVault((context) => {
    context.store.create(entityInput('Neovim', 'Editor.'), TEST_META);
    assert.match(tools(context).execute('read_note', { title: 'neovim config', page: 1 }), /^no note "neovim config"; closest: Neovim$/);
    assert.match(tools(context).execute('read_note', { title: 'zzz', page: 1 }), /^no note "zzz"; closest: none$/);
  });
});

test('neighbors renders labelled relations both ways and stamps the listed notes', () => {
  withVault((context) => {
    const lua = context.store.create(entityInput('Lua', 'Language.\n\n**Runs on** [[LuaJIT]]'), TEST_META);
    context.store.create(entityInput('LuaJIT', 'Runtime.'), TEST_META);
    context.store.create(entityInput('Neovim', 'Editor.\n\n**Uses** [[Lua]]'), TEST_META);
    context.store.create(entityInput('Denys', 'Owner.\n\n**Edits with** [[Neovim]]'), TEST_META);
    const one = tools(context).execute('neighbors', { title: 'Neovim', depth: 1 });
    assert.match(one, /^- Neovim —Uses→ Lua$/m);
    assert.match(one, /^- Denys —Edits with→ Neovim$/m);
    assert.doesNotMatch(one, /LuaJIT/);
    assert.equal(accessed(context, lua.id), context.clock.nowUtc());
    assert.match(tools(context).execute('neighbors', { title: 'Neovim', depth: 2 }), /^- Lua —Runs on→ LuaJIT$/m);
  });
});

test('search_notes matches bodies and aliases; bad arguments and unknown tools come back as error results', () => {
  withVault((context) => {
    context.store.create(entityInput('Visual Studio Code', 'Editor with the GitLens extension.', { aliases: ['vscode'] }), TEST_META);
    const hits = tools(context).execute('search_notes', { query: 'gitlens', limit: 5 });
    assert.match(hits, /^- Visual Studio Code · Software · software$/m);
    assert.match(hits, /aliases: vscode/);
    assert.match(hits, /> Editor with the GitLens extension\./);
    assert.match(tools(context).execute('search_notes', { query: 'nothingmatches' }), /^no notes match "nothingmatches"$/);
    assert.match(tools(context).execute('search_notes', { query: '' }), /^Error: /);
    assert.match(tools(context).execute('rm_rf', {}), /^Error: unknown tool "rm_rf"/);
  });
});

test('day_context lists the day\'s processed captures and chat notes with what they taught', () => {
  withVault((context) => {
    const capture = context.store.create({
      title: '2026-10-24 09.00.00 · Code', folder: 'Captures/2026-10-24', kind: 'capture', types: [], aliases: [], tags: [],
      body: '## Learned\n- [[Neovim]]: **Uses** Lua',
    }, TEST_META);
    context.database.prepare(`
      INSERT INTO vault_attachments (id, note_id, relative_path, mime_type, byte_length, sha256, created_at_utc) VALUES ('att1', ?, 'captures/att1.png', 'image/png', 1, 'x', ?)
    `).run(capture.id, context.clock.nowUtc());
    context.database.prepare(`
      INSERT INTO vault_captures (attachment_id, note_id, state, foreground_context_key, pixel_sha256, perceptual_hash, app, window_title, captured_at_utc, processed_at_utc)
      VALUES ('att1', ?, 'processed', 'k', 'p', 'h', 'Code.exe', 'init.lua', ?, ?)
    `).run(capture.id, context.clock.nowUtc(), context.clock.nowUtc());
    const text = tools(context).execute('day_context', {});
    assert.match(text, /^Captures on 2026-10-24:\n- Code\.exe · init\.lua\n {2}- \[\[Neovim\]\]: \*\*Uses\*\* Lua$/m);
  });
});

test('results are capped near 1,500 tokens', () => {
  withVault((context) => {
    for (let index = 0; index < 10; index += 1) context.store.create(entityInput(`Tool ${index}`, `${'gitlens '.repeat(200)}`, { aliases: [`alias ${'x'.repeat(100)} ${index}`] }), TEST_META);
    const text = tools(context).execute('search_notes', { query: 'gitlens', limit: 10 });
    assert.ok(text.length <= MAX_RESULT_CHARS + 20);
  });
});

test('the owner card and candidate cards carry what the agent needs to avoid duplicates', () => {
  withVault((context) => {
    const owner = context.store.create(entityInput('Denys', 'Denys builds tools.\n\n**Uses** [[Neovim]]', { tags: ['me'], aliases: ['DenysA'] }), TEST_META);
    const neovim = context.store.create(entityInput('Neovim', 'Editor.\n\n**Uses** [[Lua]]', { aliases: ['nvim'] }), TEST_META);
    assert.equal(ownerCard(context.database, context.clock.nowUtc()), 'Owner: Denys (aliases: DenysA)\nDenys builds tools.\n**Uses** [[Neovim]]');
    assert.deepEqual(pointAccess(context, owner.id).map((row) => row.last_accessed_at_utc), [context.clock.nowUtc()]);
    const cards = candidateCards(context.database, 'nvim init.lua', context.clock.nowUtc());
    assert.match(cards, /### Neovim · Software · software · aliases: nvim\nEditor\.\nrows: Uses/);
    assert.doesNotMatch(cards, /### Denys/, 'the owner has its own card');
    assert.equal(accessed(context, neovim.id), context.clock.nowUtc());
  });
});

test('review cards list each note with its values stalest first and their ages', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub · GitLab'), TEST_META);
    context.clock.advanceDays(5);
    const text = reviewCards(context.database, new VaultValidationQueue(context.database), [note.id, 'vnote_gone'], context.clock.nowUtc());
    assert.match(text, /^### Git · Software · software\nVCS\.\nrows: Hosts\n- \*\*Hosts\*\* GitHub — added 5d · edited 5d · validated never\n- \*\*Hosts\*\* GitLab — added 5d/);
  });
});

test('the agent is offered the four read tools and submit_edits, with flat schemas', () => {
  assert.deepEqual(VAULT_WRITER_TOOLS.map((tool) => [tool.function.name, tool.kind]), [
    ['search_notes', 'tool'], ['read_note', 'tool'], ['neighbors', 'tool'], ['day_context', 'tool'], ['submit_edits', 'finish'],
  ]);
  assert.doesNotMatch(JSON.stringify(VAULT_WRITER_TOOLS.map((tool) => tool.function.parameters)), /\$ref|\$schema/);
  assert.deepEqual(toInferenceTool(SUBMIT_EDITS_TOOL), { type: 'function', function: SUBMIT_EDITS_TOOL.function });
});
