import test from 'node:test';
import assert from 'node:assert/strict';

import { SequentialIdGenerator } from '../src/assistant/ids.ts';
import { AuditStore } from '../src/assistant/storage/audit-store.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { VaultAttachments } from '../src/vault/attachments.ts';
import { VaultCaptureIntake } from '../src/vault/capture-intake.ts';
import { requeueStrandedCaptures, requireCapture, setCaptureState } from '../src/vault/captures.ts';
import { SCREENSHOTS_ENABLED, StubImageCapability, vaultCaptureDto } from './helpers/vault-capture-fixture.ts';
import { withVault } from './helpers/vault-fixture.ts';

test('only processing captures without a live job go back to the queue', () => {
  withVault((context) => {
    const ids = new SequentialIdGenerator();
    const intake = new VaultCaptureIntake({
      database: context.database, store: context.store, audit: new AuditStore(context.database, context.clock, ids),
      attachments: new VaultAttachments(context.database, context.clock, ids, context.runtimeRoot), clock: context.clock,
      capability: new StubImageCapability(true),
    });
    const submit = (pixelSeed: string, foregroundContextKey: string) => {
      const outcome = intake.submit(LOCAL_OWNER_ID, vaultCaptureDto({ pixelSha256: pixelSeed.repeat(64), foregroundContextKey }), SCREENSHOTS_ENABLED);
      if (outcome.kind !== 'accepted') throw new Error('fixture capture was not accepted');
      return outcome.attachmentId;
    };
    const stranded = submit('a', 'app:a');
    const running = submit('b', 'app:b');
    const done = submit('c', 'app:c');
    setCaptureState(context.database, stranded, 'processing');
    setCaptureState(context.database, running, 'processing');
    setCaptureState(context.database, done, 'processed');

    assert.equal(requeueStrandedCaptures(context.database, [running]), 1);
    assert.deepEqual([stranded, running, done].map((id) => requireCapture(context.database, id).state), ['queued', 'processing', 'processed']);
  });
});
