import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SequentialIdGenerator } from '../src/assistant/ids.ts';
import { AuditStore } from '../src/assistant/storage/audit-store.ts';
import { JobStore } from '../src/assistant/storage/job-store.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.ts';
import type { AssistantConfig } from '../src/config/types.ts';
import { z } from '../src/lib/zod.ts';
import { VaultAttachments, vaultAttachmentsDir } from '../src/vault/attachments.ts';
import { VaultCaptureIntake } from '../src/vault/capture-intake.ts';
import { VaultCaptureRetention } from '../src/vault/capture-retention.ts';
import { VaultMaintenance } from '../src/vault/maintenance.ts';
import { VaultDailyRollup } from '../src/vault/note-writer/daily-rollup.ts';
import { VaultValidationQueue } from '../src/vault/validation-queue.ts';
import { DISTINCT_HASH, SCREENSHOTS_ENABLED, StubImageCapability, vaultCaptureDto } from './helpers/vault-capture-fixture.ts';
import { TEST_META, entityInput, withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

process.env.TZ = 'UTC';

const OWNER = LOCAL_OWNER_ID;
const PRIORITIES = DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities;

function setup(context: VaultTestContext) {
  const ids = new SequentialIdGenerator();
  const audit = new AuditStore(context.database, context.clock, ids);
  const attachments = new VaultAttachments(context.database, context.clock, ids, context.runtimeRoot);
  const jobs = new JobStore(context.database, context.clock, ids);
  const maintenance = new VaultMaintenance({
    database: context.database, clock: context.clock, jobs, queue: new VaultValidationQueue(context.database),
    retention: new VaultCaptureRetention({ database: context.database, attachments, audit, clock: context.clock }),
    rollup: new VaultDailyRollup({ database: context.database, store: context.store }),
  });
  const intake = new VaultCaptureIntake({ database: context.database, store: context.store, attachments, audit, clock: context.clock, capability: new StubImageCapability(true) });
  const count = (sql: string) => z.object({ count: z.number() }).parse(context.database.prepare(sql).get()).count;
  const queuedReviews = () => jobs.listByStatus(OWNER, 'queued').map((job) => jobs.readRequest(job))
    .filter((request) => request.jobType === 'vault_write' && request.payload.source === 'review');
  return { jobs, maintenance, intake, attachments, count, queuedReviews };
}

test('maintenance rebuilds every pending rollup day, then enqueues one review batch only when no write is queued', () => {
  withVault((context) => {
    const { jobs, maintenance, count, queuedReviews } = setup(context);
    context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub'), TEST_META);
    context.database.prepare("INSERT INTO vault_rollup_days (day) VALUES ('2026-10-23'), ('2026-10-24')").run();
    jobs.enqueue(OWNER, { jobType: 'vault_write', payload: { source: 'capture', attachmentId: 'a1' } }, PRIORITIES);

    maintenance.run(OWNER, DEFAULT_ASSISTANT_CONFIG);
    assert.equal(count('SELECT COUNT(*) AS count FROM vault_rollup_days'), 0);
    assert.deepEqual(queuedReviews(), [], 'a waiting capture blocks the review');

    context.database.prepare("UPDATE assistant_jobs SET status = 'completed'").run();
    maintenance.run(OWNER, DEFAULT_ASSISTANT_CONFIG);
    maintenance.run(OWNER, DEFAULT_ASSISTANT_CONFIG);
    const reviews = queuedReviews();
    assert.equal(reviews.length, 1, 'one live review at a time');
    assert.deepEqual(reviews[0]?.payload, { source: 'review', noteIds: [context.store.resolveId('Git')] });
  });
});

test('maintenance with an empty validation queue enqueues no review', () => {
  withVault((context) => {
    const { maintenance, queuedReviews } = setup(context);
    maintenance.run(OWNER, DEFAULT_ASSISTANT_CONFIG);
    assert.deepEqual(queuedReviews(), []);
  });
});

test('maintenance runs retention with the configured limits', () => {
  withVault((context) => {
    const { maintenance, intake, attachments } = setup(context);
    const captures = ['2026-10-22T09:00:00.000Z', '2026-10-24T08:00:00.000Z'].map((capturedAtUtc, index) => {
      const outcome = intake.submit(OWNER, vaultCaptureDto({
        capturedAtUtc, pixelSha256: String(index + 1).padStart(64, '0'), perceptualHash: DISTINCT_HASH, foregroundContextKey: `ctx${index}`,
      }), SCREENSHOTS_ENABLED);
      if (outcome.kind !== 'accepted') throw new Error('fixture capture was not accepted');
      return outcome.attachmentId;
    });
    const config: AssistantConfig = { ...DEFAULT_ASSISTANT_CONFIG, Vault: { CaptureImageMaxAgeDays: 1 } };
    maintenance.run(OWNER, config);
    const exists = (id: string) => fs.existsSync(path.join(vaultAttachmentsDir(context.runtimeRoot), attachments.require(id).relativePath));
    assert.deepEqual(captures.map(exists), [false, true], 'the capture older than a day is expired');
  });
});
