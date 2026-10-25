import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { VaultNoteSchema, VaultWriteMetaSchema } from '@siftkit/contracts';
import { z } from '../src/lib/zod.ts';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const NameRowsSchema = z.array(z.object({ name: z.string() }));

test('runtime bootstrap creates every vault table', () => {
  const database = getRuntimeDatabase(path.join(createManagedTempDir('siftkit-vault-schema-'), 'runtime.sqlite'));
  try {
    const names = NameRowsSchema.parse(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vault_%' ORDER BY name",
    ).all()).map((row) => row.name);
    for (const table of ['vault_aliases', 'vault_attachments', 'vault_captures', 'vault_chat_notes', 'vault_links', 'vault_note_revisions', 'vault_notes', 'vault_notes_fts', 'vault_tags']) {
      assert.ok(names.includes(table), `missing ${table}`);
    }
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('VaultNoteSchema rejects an unknown kind', () => {
  const note = {
    id: 'vnote_1', title: 'A', folder: '', kind: 'entity', types: [], aliases: [], tags: [], body: '',
    revision: 1, isStub: true, createdAtUtc: '2026-10-24T00:00:00.000Z', updatedAtUtc: '2026-10-24T00:00:00.000Z',
  };
  assert.equal(VaultNoteSchema.parse(note).kind, 'entity');
  assert.throws(() => VaultNoteSchema.parse({ ...note, kind: 'projection' }));
});

test('runtime bootstrap creates the link-resolution view', () => {
  const database = getRuntimeDatabase(path.join(createManagedTempDir('siftkit-vault-view-'), 'runtime.sqlite'));
  try {
    assert.deepEqual(NameRowsSchema.parse(database.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'vault_%'").all()), [{ name: 'vault_key_owners' }]);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('write metadata names one of the known actors', () => {
  assert.equal(VaultWriteMetaSchema.parse({ actor: 'note-writer · screenshot', summary: 's', sourceRef: 'att_1' }).actor, 'note-writer · screenshot');
  assert.throws(() => VaultWriteMetaSchema.parse({ actor: 'robot', summary: 's', sourceRef: null }));
});
