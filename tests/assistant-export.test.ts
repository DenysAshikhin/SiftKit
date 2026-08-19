import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from '../src/lib/zod.js';
import { readZip } from '../src/lib/zip.js';
import { ExportService } from '../src/assistant/control/export-service.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import type {
  ProjectionSummaryService,
  SummarizeProjectionResult,
} from '../src/assistant/projections/projection-summarizer.js';
import { CURRENT_SCHEMA_VERSION } from '../src/state/runtime-db.js';
import {
  withAssistantContextAsync, type AssistantTestContext,
} from './helpers/assistant-fixture.js';
import { archiveBytes } from './helpers/archive-bytes.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';

class PassthroughSummarizer implements ProjectionSummaryService {
  async summarize(): Promise<SummarizeProjectionResult> {
    return { kind: 'unchanged', reason: 'passthrough' };
  }
}

const REQUIRED_ENTRIES = [
  'manifest.json',
  'graph/nodes.jsonl',
  'graph/assertions.jsonl',
  'graph/aliases.jsonl',
  'graph/evidence-links.jsonl',
  'evidence/metadata.jsonl',
  'policies.json',
  'questions.jsonl',
  'audit.jsonl',
] as const;

async function seededExport(context: AssistantTestContext): Promise<ExportService> {
  seedOwnerAssertion(context, { objectName: 'Omicron Tool' });
  await new ProjectionCompiler(
    context.graph, new EstimateTokenCounter(4), new PassthroughSummarizer(),
    { 1: 10_000, 2: 50_000, 3: 10_000 },
  ).compileAll(context.ownerId, new AbortController().signal);
  return new ExportService(context.graph, context.database, context.ownerId);
}


test('export renders the §16.3 tree without blobs by default', async () => {
  await withAssistantContextAsync(async (context) => {
    const service = await seededExport(context);
    const archive = readZip(await archiveBytes(service.export({ includeDecryptedBlobs: false })));
    const names = [...archive.keys()];

    for (const required of REQUIRED_ENTRIES) assert.ok(names.includes(required), required);
    assert.ok(names.some((name) => name.startsWith('projections/tier')));
    assert.equal(names.some((name) => name.startsWith('evidence/blobs/')), false);

    const manifest = z.object({
      schemaVersion: z.number().int(),
      exportedAtUtc: z.string(),
      includesDecryptedBlobs: z.boolean(),
    }).parse(JSON.parse(archive.get('manifest.json')?.toString('utf8') ?? ''));
    assert.equal(manifest.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(manifest.includesDecryptedBlobs, false);

    const nodeLines = (archive.get('graph/nodes.jsonl')?.toString('utf8') ?? '')
      .split('\n').filter(Boolean);
    assert.ok(nodeLines.length >= 2); // owner + object node
    assert.equal(
      z.object({ owner_id: z.string() }).parse(JSON.parse(nodeLines[0] ?? '')).owner_id,
      context.ownerId,
    );
    assert.equal(
      (archive.get('graph/evidence-links.jsonl')?.toString('utf8') ?? '')
        .split('\n').filter(Boolean).length,
      1,
    );
  });
});

test('includeDecryptedBlobs adds plaintext blobs and an audit row', async () => {
  await withAssistantContextAsync(async (context) => {
    const service = await seededExport(context);
    const archive = readZip(await archiveBytes(service.export({ includeDecryptedBlobs: true })));

    const blobEntries = [...archive.keys()].filter((name) => name.startsWith('evidence/blobs/'));
    assert.equal(blobEntries.length, 1);
    assert.match(
      archive.get(blobEntries[0] ?? '')?.toString('utf8') ?? '',
      /Omicron Tool/u,
    );
    assert.equal(
      context.graph.audit.listAuditEvents(context.ownerId, 50)
        .some((event) => event.event_type === 'decrypted_export'),
      true,
    );
  });
});

test('a default export records no decrypted-export audit event', async () => {
  await withAssistantContextAsync(async (context) => {
    const service = await seededExport(context);
    await archiveBytes(service.export({ includeDecryptedBlobs: false }));

    assert.equal(
      context.graph.audit.listAuditEvents(context.ownerId, 50)
        .some((event) => event.event_type === 'decrypted_export'),
      false,
    );
  });
});

test('an empty assistant exports a well-formed but empty tree', async () => {
  await withAssistantContextAsync(async (context) => {
    const service = new ExportService(context.graph, context.database, context.ownerId);
    const archive = readZip(await archiveBytes(service.export({ includeDecryptedBlobs: true })));

    for (const required of REQUIRED_ENTRIES) assert.ok(archive.has(required), required);
    assert.equal(archive.get('graph/assertions.jsonl')?.byteLength, 0);
    assert.equal(archive.get('policies.json')?.toString('utf8'), '[]');
    assert.equal([...archive.keys()].some((name) => name.startsWith('evidence/blobs/')), false);
  });
});
