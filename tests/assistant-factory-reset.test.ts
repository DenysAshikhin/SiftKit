import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { z } from '../src/lib/zod.js';
import { DeletionPreviewService } from '../src/assistant/control/deletion-preview.js';
import { FactoryResetService } from '../src/assistant/control/factory-reset-service.js';
import { KeyCustodyService } from '../src/assistant/crypto/key-custody.js';
import { ImportedKeyProvider } from '../src/assistant/crypto/imported-key-provider.js';
import { FileKeyProvider } from '../src/assistant/crypto/key-provider.js';
import { AssistantConflictError } from '../src/assistant/errors.js';
import { assistantEvidenceDir, assistantKeyFile } from '../src/assistant/layout.js';
import {
  ASSISTANT_FTS_TABLE_NAMES, ASSISTANT_TABLE_NAMES,
} from '../src/assistant/storage/schema.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';

/** A custody port over a plain field: the reset only ever needs to read and write the mode. */
class MemoryCustodyConfigPort {
  private custody: 'file' | 'desktop' = 'file';

  readCustody(): 'file' | 'desktop' {
    return this.custody;
  }

  writeCustody(custody: 'file' | 'desktop'): void {
    this.custody = custody;
  }
}

function factoryResetServiceFor(
  context: AssistantTestContext,
  config: MemoryCustodyConfigPort = new MemoryCustodyConfigPort(),
): FactoryResetService {
  return new FactoryResetService({
    graph: context.graph,
    database: context.database,
    clock: context.clock,
    runtimeRoot: context.runtimeRoot,
    previews: new DeletionPreviewService(context.graph, context.database),
    keyCustody: new KeyCustodyService({
      config,
      fileKeys: new FileKeyProvider(assistantKeyFile(context.runtimeRoot)),
      imported: new ImportedKeyProvider(),
      evidence: context.graph.evidence,
      ownerId: context.ownerId,
    }),
  });
}

function countRows(context: AssistantTestContext, table: string): number {
  return z.object({ count: z.number() }).parse(
    context.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
  ).count;
}

test('the table inventory covers every assistant table in the migrated schema', () => {
  withAssistantContext((context) => {
    const declared = new Set<string>([
      ...ASSISTANT_TABLE_NAMES,
      ...ASSISTANT_FTS_TABLE_NAMES,
      // Registries: TypeScript constants projected into rows, re-seeded rather than deleted.
      'graph_node_types',
      'graph_relation_types',
    ]);
    const live = z.array(z.object({ name: z.string() })).parse(
      context.database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND (
            name LIKE 'assistant\\_%' ESCAPE '\\'
            OR name LIKE 'graph\\_%' ESCAPE '\\'
            OR name LIKE 'memory\\_%' ESCAPE '\\'
            OR name LIKE 'evidence\\_%' ESCAPE '\\'
            OR name LIKE 'candidate\\_%' ESCAPE '\\'
            OR name IN ('observations', 'retrieval_usage', 'assertion_evidence')
          )
      `).all(),
    ).map((row) => row.name)
      // fts5 creates internal shadow tables (`<name>_data`, `_idx`, ...) per virtual table.
      .filter((name) => !ASSISTANT_FTS_TABLE_NAMES.some(
        (fts) => name.startsWith(`${fts}_`),
      ));

    assert.deepEqual([...live].sort(), [...declared].sort());
  });
});

test('factory reset empties every assistant table, the blob tree, and the key, leaving the rest intact', () => {
  withAssistantContext((context) => {
    seedOwnerAssertion(context, { objectName: 'Kappa' });
    context.database.prepare(
      "INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES ('unrelated.key', 'keep', ?)",
    ).run(context.clock.nowUtc());
    assert.ok(fs.existsSync(assistantEvidenceDir(context.runtimeRoot)));

    const custody = new MemoryCustodyConfigPort();
    const service = factoryResetServiceFor(context, custody);
    const preview = service.preview(context.ownerId);
    assert.equal(preview.tableCounts['graph_assertions'], 1);
    assert.equal(preview.blobCount, 1);
    assert.ok(preview.blobBytes > 0);

    service.confirm(context.ownerId, preview.previewToken);

    // Everything is gone except the identity rows the reset immediately re-seeds.
    for (const table of ASSISTANT_TABLE_NAMES) {
      const expected = table === 'assistant_owners' || table === 'assistant_devices' ? 1 : 0;
      assert.equal(countRows(context, table), expected, table);
    }
    assert.equal(fs.existsSync(assistantEvidenceDir(context.runtimeRoot)), false);
    assert.equal(fs.existsSync(assistantKeyFile(context.runtimeRoot)), false);
    assert.equal(custody.readCustody(), 'file');
    assert.deepEqual(
      context.database.prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'unrelated.key'",
      ).get(),
      { value: 'keep' },
    );
  });
});

test('factory reset re-seeds the registries, owner, and device so the assistant is usable again', () => {
  withAssistantContext((context) => {
    seedOwnerAssertion(context, { objectName: 'Lambda' });
    const deviceId = context.graph.identity.getLocalDeviceId();
    const service = factoryResetServiceFor(context);

    service.confirm(context.ownerId, service.preview(context.ownerId).previewToken);

    assert.equal(context.graph.identity.getOwner().id, context.ownerId);
    assert.ok(context.graph.identity.getDevice(deviceId) !== null);
    assert.ok(countRows(context, 'graph_node_types') > 0);
    assert.ok(countRows(context, 'graph_relation_types') > 0);
    assert.equal(context.graph.graphVersion, 0);
    // The graph accepts writes again on a clean slate.
    const reseeded = seedOwnerAssertion(context, { objectName: 'Mu' });
    assert.equal(context.graph.assertions.requireAssertion(reseeded.assertion.id).status, 'active');
  });
});

test('re-running factory reset on an empty assistant is a no-op, not an error', () => {
  withAssistantContext((context) => {
    const service = factoryResetServiceFor(context);
    service.confirm(context.ownerId, service.preview(context.ownerId).previewToken);
    const second = service.preview(context.ownerId);
    assert.equal(second.blobCount, 0);
    service.confirm(context.ownerId, second.previewToken);
    assert.equal(countRows(context, 'graph_assertions'), 0);
  });
});

test('a factory-reset token is rejected once the graph moves, and cannot be another operation', () => {
  withAssistantContext((context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Nu' });
    const service = factoryResetServiceFor(context);
    const previews = new DeletionPreviewService(context.graph, context.database);
    const preview = service.preview(context.ownerId);

    // A token minted for a different operation must not authorize the reset.
    const assertionToken = previews
      .previewForgetAssertion(context.ownerId, seeded.assertion.id).previewToken;
    assert.throws(
      () => service.confirm(context.ownerId, assertionToken),
      AssistantConflictError,
    );

    seedOwnerAssertion(context, { objectName: 'Xi' }); // the graph version moves

    assert.throws(() => service.confirm(context.ownerId, preview.previewToken), AssistantConflictError);
    assert.equal(countRows(context, 'graph_assertions'), 2);
  });
});
