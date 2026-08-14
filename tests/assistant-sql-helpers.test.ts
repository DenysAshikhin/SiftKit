import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dropFtsRow, fetchRowsByIds, recordFtsRowid,
} from '../src/assistant/storage/sql-helpers.js';
import { NodeRowSchema } from '../src/assistant/storage/rows.js';
import { z } from '../src/lib/zod.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

const FtsStateSchema = z.object({ fts_rowid: z.number().int().nullable() });
const CountSchema = z.object({ count: z.number() });

test('fetchRowsByIds dedupes ids, chunks past 400 parameters, and omits missing ids', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const ids = Array.from({ length: 401 }, (_, index) => graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: `Chunk Tool ${index}`,
      description: null, sensitivity: 'personal', properties: {},
    }).id);

    const requested = [...ids, ...ids.slice(0, 5), 'node_missing'];
    const found = fetchRowsByIds(database, 'graph_nodes', NodeRowSchema, requested);

    assert.equal(found.size, ids.length, 'every real id appears exactly once');
    assert.equal(found.has('node_missing'), false, 'missing ids are absent, not errors');
    const first = found.get(ids[0] ?? '');
    assert.ok(first !== undefined && first.display_name === 'Chunk Tool 0');
    assert.equal(fetchRowsByIds(database, 'graph_nodes', NodeRowSchema, []).size, 0);
  });
});

test('dropFtsRow deletes the FTS row by rowid and clears the tracking column', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const node = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Droppable Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const before = FtsStateSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.notEqual(before.fts_rowid, null, 'fixture: creation must have indexed the node');

    dropFtsRow(database, 'graph_nodes', node.id, before.fts_rowid);

    const remaining = CountSchema.parse(database.prepare(
      'SELECT COUNT(*) AS count FROM graph_nodes_fts WHERE node_id = ?',
    ).get(node.id));
    assert.equal(remaining.count, 0, 'the FTS row must be gone');
    const after = FtsStateSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.equal(after.fts_rowid, null, 'the tracking column must be cleared');

    dropFtsRow(database, 'graph_nodes', node.id, null);
    assert.equal(
      CountSchema.parse(database.prepare(
        'SELECT COUNT(*) AS count FROM graph_nodes_fts WHERE node_id = ?',
      ).get(node.id)).count,
      0,
      'a null rowid is a no-op',
    );
  });
});

test('recordFtsRowid stores the rowid on the canonical row', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const node = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Recordable Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    recordFtsRowid(database, 'graph_nodes', node.id, 12345);
    const stored = FtsStateSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.equal(stored.fts_rowid, 12345);
  });
});
