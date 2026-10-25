import test from 'node:test';
import assert from 'node:assert/strict';

import { SecretScanner } from '../src/assistant/domain/secrets.ts';
import type { AssistantInferenceClient, AssistantInferenceRequest } from '../src/assistant/inference/client.ts';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.ts';
import { AssistantJobRunner, type InteractivityGate, type ModelResidencyGate } from '../src/assistant/jobs/job-runner.ts';
import type { AssistantJobRequest, AssistantJobType } from '../src/assistant/jobs/job-types.ts';
import {
  AssistantResourcePolicy,
  UnavailablePowerStateProvider,
  type ResourceDecision,
  type ResourcePolicy,
} from '../src/assistant/jobs/resource-policy.ts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.ts';
import type { AssistantConfig } from '../src/config/types.ts';
import { VaultAttachments } from '../src/vault/attachments.ts';
import { VaultCaptureIntake } from '../src/vault/capture-intake.ts';
import { VaultCaptureRetention } from '../src/vault/capture-retention.ts';
import { requireCapture } from '../src/vault/captures.ts';
import { VaultNoteStore } from '../src/vault/note-store.ts';
import { VaultCaptureWriter } from '../src/vault/note-writer/capture-writer.ts';
import { VaultChatWriter, type VaultChatTurn } from '../src/vault/note-writer/chat-writer.ts';
import { VaultDailyRollup } from '../src/vault/note-writer/daily-rollup.ts';
import { VaultEditApplier } from '../src/vault/note-writer/edit-applier.ts';
import { VaultTidyPass } from '../src/vault/note-writer/tidy-pass.ts';
import { findOwnerNote } from '../src/vault/owner-identity.ts';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.ts';
import { withAssistantContextAsync, type AssistantTestContext } from './helpers/assistant-fixture.ts';
import { SCREENSHOTS_ENABLED, StubImageCapability, vaultCaptureDto } from './helpers/vault-capture-fixture.ts';

process.env.TZ = 'UTC';

class StaticIdleGate implements InteractivityGate {
  private idle: boolean;

  constructor(idle: boolean) {
    this.idle = idle;
  }

  evaluate() {
    return this.idle
      ? { kind: 'allowed' as const }
      : { kind: 'blocked' as const, reason: 'server_busy' as const, details: {} };
  }

  setIdle(idle: boolean): void {
    this.idle = idle;
  }
}

class StaticResidencyGate implements ModelResidencyGate {
  private resident: boolean;

  constructor(resident: boolean) {
    this.resident = resident;
  }

  isModelResident(): boolean {
    return this.resident;
  }

  setResident(resident: boolean): void {
    this.resident = resident;
  }
}

class NoLimitResourcePolicy implements ResourcePolicy {
  canStartBackgroundWork(): ResourceDecision {
    return { kind: 'allowed' };
  }

  canStartModelWork(): ResourceDecision {
    return { kind: 'allowed' };
  }

  recordGpuUse(): void {}
}

interface RunnerOverrides {
  readonly inference?: AssistantInferenceClient;
  readonly idleGate?: InteractivityGate;
  readonly residencyGate?: ModelResidencyGate;
  readonly resourcePolicy?: ResourcePolicy;
  readonly config?: AssistantConfig;
}

/** The runner over real vault writers sharing the fixture database. */
function setup(context: AssistantTestContext, overrides: RunnerOverrides = {}) {
  const { database, clock, ids, runtimeRoot, graph } = context;
  const store = new VaultNoteStore(database, clock, ids);
  const attachments = new VaultAttachments(database, clock, ids, runtimeRoot);
  const scanner = new SecretScanner();
  const runner = new StructuredOutputRunner(overrides.inference ?? new FakeAssistantInference([]));
  const capability = new StubImageCapability(true);
  const applier = new VaultEditApplier({ store, database, audit: graph.audit, scanner, ownerDisplayName: 'Denys' });
  const jobRunner = new AssistantJobRunner({
    jobs: graph.jobs,
    decisions: graph.backgroundDecisions,
    captureWriter: new VaultCaptureWriter({ database, store, attachments, applier, audit: graph.audit, scanner, clock, runner, capability }),
    chatWriter: new VaultChatWriter({ database, store, applier, audit: graph.audit, scanner, runner }),
    dailyRollup: new VaultDailyRollup({ database, store }),
    tidyPass: new VaultTidyPass({ database, store, audit: graph.audit, scanner, runner }),
    retention: new VaultCaptureRetention({ database, attachments, audit: graph.audit, clock }),
    idleGate: overrides.idleGate ?? new StaticIdleGate(true),
    residencyGate: overrides.residencyGate ?? new StaticResidencyGate(true),
    resourcePolicy: overrides.resourcePolicy ?? new NoLimitResourcePolicy(),
    config: overrides.config ?? DEFAULT_ASSISTANT_CONFIG,
    leaseOwner: 'runner_test',
    leaseSeconds: 120,
  });
  const intake = new VaultCaptureIntake({ database, store, attachments, audit: graph.audit, clock, capability });
  const enqueue = (request: AssistantJobRequest) => graph.jobs.enqueue(context.ownerId, request, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities);
  const submitCapture = () => {
    const outcome = intake.submit(context.ownerId, vaultCaptureDto({ capturedAtUtc: '2026-08-05T08:59:30.000Z' }), SCREENSHOTS_ENABLED);
    if (outcome.kind !== 'accepted') throw new Error('fixture capture was not accepted');
    enqueue({ jobType: 'capture_note', payload: { attachmentId: outcome.attachmentId } });
    return outcome;
  };
  return { jobRunner, store, enqueue, submitCapture };
}

const TURN: VaultChatTurn = {
  sessionId: 'chat_1', sessionTitle: 'Editor', userMessageId: 'msg_1', capturedAtUtc: '2026-08-05T08:30:00.000Z',
  userText: 'I switched to Neovim.', assistantText: 'Nice.',
};
const USES_NEOVIM = JSON.stringify({ operations: [
  { op: 'create_note', title: 'Neovim', type: 'software', lead: 'Neovim is a terminal text editor.' },
  { op: 'add_facts', note: 'the user', label: 'Uses', values: ['Neovim'] },
] });
const NO_OPERATIONS = JSON.stringify({ operations: [] });
const TIDY_OFF: AssistantConfig = { ...DEFAULT_ASSISTANT_CONFIG, Vault: { ...DEFAULT_ASSISTANT_CONFIG.Vault, TidyPassEnabled: false } };
const GPU_CAPPED = (context: AssistantTestContext) => new AssistantResourcePolicy({
  database: context.database, clock: context.clock,
  background: { ...DEFAULT_ASSISTANT_CONFIG.Background, MaxGpuMinutesPerDay: 0 },
  power: new UnavailablePowerStateProvider(),
});

const enqueueChat = (enqueue: ReturnType<typeof setup>['enqueue'], turn: VaultChatTurn = TURN) => enqueue({ jobType: 'chat_note', payload: turn });
const queuedOf = (context: AssistantTestContext, jobType: AssistantJobType) => context.graph.jobs.listByStatus(context.ownerId, 'queued')
  .filter((job) => job.job_type === jobType);
const lastDecision = (context: AssistantTestContext) => context.graph.backgroundDecisions.list(context.ownerId)[0]?.reason;

/** Requests preemption from inside the model call, as an interactive request arriving mid-job would. */
class PreemptingInference extends FakeAssistantInference {
  private runner: AssistantJobRunner | null = null;
  private readonly idleGate: StaticIdleGate;
  private readonly honourAbort: boolean;

  constructor(idleGate: StaticIdleGate, responses: readonly string[], honourAbort: boolean) {
    super(responses);
    this.idleGate = idleGate;
    this.honourAbort = honourAbort;
  }

  attachRunner(runner: AssistantJobRunner): void {
    this.runner = runner;
  }

  async complete(request: AssistantInferenceRequest) {
    this.idleGate.setIdle(false);
    this.runner?.requestPreemption();
    if (this.honourAbort && request.abortSignal?.aborted === true) throw new Error('Assistant inference aborted by interactive work.');
    return super.complete(request);
  }
}

test('a chat note job writes the chat note and queues the day\'s rollup and a tidy of each touched note', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, store, enqueue } = setup(context, { inference: new FakeAssistantInference([USES_NEOVIM]) });
    enqueueChat(enqueue);

    assert.deepEqual(await jobRunner.drain(context.ownerId, 1), { claimed: 1, completed: 1, failed: 0, preempted: 0, recovered: 0 });
    assert.equal(store.resolve('Chat 2026-08-05 · Editor')?.kind, 'chat');
    assert.deepEqual(queuedOf(context, 'daily_rollup').map((job) => job.payload_json), [JSON.stringify({ day: '2026-08-05' })]);
    const tidied = queuedOf(context, 'note_tidy').map((job) => job.payload_json).sort();
    assert.deepEqual(tidied, [store.resolve('Neovim')?.id, findOwnerNote(context.database)?.id].map((noteId) => JSON.stringify({ noteId })).sort());
  });
});

test('follow-ups stay live-idempotent: two turns on one day queue one rollup and one tidy per note', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { inference: new FakeAssistantInference([USES_NEOVIM, USES_NEOVIM]) });
    enqueueChat(enqueue);
    enqueueChat(enqueue, { ...TURN, userMessageId: 'msg_2', capturedAtUtc: '2026-08-05T08:40:00.000Z' });
    await jobRunner.drain(context.ownerId, 2);
    assert.equal(queuedOf(context, 'daily_rollup').length, 1);
    assert.equal(queuedOf(context, 'note_tidy').length, 2);
  });
});

test('with the tidy pass off a chat turn drains into its chat note and the daily note', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, store, enqueue } = setup(context, { inference: new FakeAssistantInference([USES_NEOVIM]), config: TIDY_OFF });
    enqueueChat(enqueue);
    assert.deepEqual(await jobRunner.drain(context.ownerId, -1), { claimed: 2, completed: 2, failed: 0, preempted: 0, recovered: 0 });
    assert.match(store.resolve('2026-08-05')?.body ?? '', /## Chats\n- \[\[Chat 2026-08-05 · Editor\]\]/);
    assert.equal(queuedOf(context, 'note_tidy').length, 0);
  });
});

test('refreshConfig switches the tidy pass for later jobs', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { inference: new FakeAssistantInference([USES_NEOVIM]), config: TIDY_OFF });
    jobRunner.refreshConfig(DEFAULT_ASSISTANT_CONFIG);
    enqueueChat(enqueue);
    await jobRunner.drain(context.ownerId, 1);
    assert.equal(queuedOf(context, 'note_tidy').length, 2);
  });
});

test('a suppressed chat turn writes nothing and queues no follow-up', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context);
    enqueueChat(enqueue, { ...TURN, userText: 'Do not remember this.' });
    assert.equal((await jobRunner.drain(context.ownerId, -1)).completed, 1);
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'queued'), 0);
  });
});

test('a capture note job processes the capture and queues the rollup for its local day', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, store, submitCapture } = setup(context, { inference: new FakeAssistantInference([NO_OPERATIONS]), config: TIDY_OFF });
    const capture = submitCapture();
    assert.equal((await jobRunner.drain(context.ownerId, -1)).completed, 2);
    assert.equal(requireCapture(context.database, capture.attachmentId).state, 'processed');
    assert.match(store.resolve('2026-08-05')?.body ?? '', /^1 screenshot · 0 chats/);
  });
});

test('a capture note job for an already processed capture queues nothing', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue, submitCapture } = setup(context, { inference: new FakeAssistantInference([NO_OPERATIONS]), config: TIDY_OFF });
    const capture = submitCapture();
    await jobRunner.drain(context.ownerId, -1);
    enqueue({ jobType: 'capture_note', payload: { attachmentId: capture.attachmentId } });
    assert.equal((await jobRunner.drain(context.ownerId, -1)).completed, 1);
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'queued'), 0);
  });
});

test('a capture retention job applies the configured age limit', async () => {
  await withAssistantContextAsync(async (context) => {
    const config: AssistantConfig = { ...TIDY_OFF, Vault: { ...TIDY_OFF.Vault, CaptureImageMaxAgeDays: 1 } };
    const { jobRunner, enqueue, submitCapture } = setup(context, { inference: new FakeAssistantInference([NO_OPERATIONS]), config });
    const capture = submitCapture();
    await jobRunner.drain(context.ownerId, -1);
    context.clock.advanceDays(2);
    enqueue({ jobType: 'capture_retention', payload: {} });
    assert.equal((await jobRunner.drain(context.ownerId, -1)).completed, 1);
    assert.equal(requireCapture(context.database, capture.attachmentId).state, 'image_removed');
  });
});

test('a busy host claims nothing', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { idleGate: new StaticIdleGate(false) });
    enqueueChat(enqueue);
    assert.equal((await jobRunner.drain(context.ownerId, 10)).claimed, 0);
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'queued'), 1);
    assert.equal(lastDecision(context), 'server_busy');
  });
});

test('preemption mid-call returns the job to the queue without spending an attempt or writing', async () => {
  await withAssistantContextAsync(async (context) => {
    const idleGate = new StaticIdleGate(true);
    const inference = new PreemptingInference(idleGate, [USES_NEOVIM], true);
    const { jobRunner, store, enqueue } = setup(context, { inference, idleGate });
    inference.attachRunner(jobRunner);
    enqueueChat(enqueue);

    const summary = await jobRunner.drain(context.ownerId, -1);
    assert.deepEqual([summary.claimed, summary.preempted], [1, 1]);
    assert.equal(queuedOf(context, 'chat_note')[0]?.attempts, 0, 'preemption is not failure');
    assert.equal(store.resolve('Chat 2026-08-05 · Editor'), null);
    assert.equal(lastDecision(context), 'preemption_requested');
  });
});

test('preemption after the writer committed completes the job instead of replaying it', async () => {
  await withAssistantContextAsync(async (context) => {
    const idleGate = new StaticIdleGate(true);
    const inference = new PreemptingInference(idleGate, [USES_NEOVIM], false);
    const { jobRunner, enqueue } = setup(context, { inference, idleGate, config: TIDY_OFF });
    inference.attachRunner(jobRunner);
    enqueueChat(enqueue);

    assert.deepEqual(await jobRunner.drain(context.ownerId, -1), { claimed: 1, completed: 1, failed: 0, preempted: 0, recovered: 0 });
    assert.equal(queuedOf(context, 'chat_note').length, 0, 'a replayed chat job would duplicate the transcript');
    assert.equal(queuedOf(context, 'daily_rollup').length, 1);
    assert.equal(lastDecision(context), 'preemption_requested');
  });
});

test('a failing job requeues with one attempt spent and then leaves nothing claimable', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context);
    enqueue({ jobType: 'note_tidy', payload: { noteId: 'note_missing' } });
    const summary = await jobRunner.drain(context.ownerId, -1);
    assert.deepEqual([summary.claimed, summary.failed], [1, 1]);
    assert.equal(queuedOf(context, 'note_tidy')[0]?.attempts, 1);
    assert.equal(lastDecision(context), 'no_claimable_job');
  });
});

test('recovery re-queues a lease abandoned by a crashed runner', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context);
    enqueue({ jobType: 'daily_rollup', payload: { day: '2026-08-05' } });
    context.graph.jobs.claimNext({ ownerId: context.ownerId, leaseOwner: 'crashed', leaseSeconds: 30, modelWorkAllowed: true });
    context.clock.advanceSeconds(31);
    const summary = await jobRunner.drain(context.ownerId, 5);
    assert.equal(summary.recovered, 1);
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'completed'), 1);
  });
});

test('the daily GPU cap skips model-backed jobs but still drains deterministic work', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { resourcePolicy: GPU_CAPPED(context) });
    enqueueChat(enqueue);
    enqueue({ jobType: 'daily_rollup', payload: { day: '2026-08-05' } });
    assert.deepEqual(await jobRunner.drain(context.ownerId, -1), { claimed: 1, completed: 1, failed: 0, preempted: 0, recovered: 0 });
    assert.equal(queuedOf(context, 'chat_note').length, 1);
    assert.equal(lastDecision(context), 'daily_gpu_limit');
  });
});

test('an unlimited drain claims every claimable job and stops when none remain', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context);
    for (const day of ['2026-08-03', '2026-08-04', '2026-08-05']) enqueue({ jobType: 'daily_rollup', payload: { day } });
    assert.deepEqual(await jobRunner.drain(context.ownerId, -1), { claimed: 3, completed: 3, failed: 0, preempted: 0, recovered: 0 });
    assert.deepEqual(context.graph.backgroundDecisions.list(context.ownerId), []);
  });
});

test('a zero drain budget claims nothing', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context);
    enqueue({ jobType: 'daily_rollup', payload: { day: '2026-08-05' } });
    assert.deepEqual(await jobRunner.drain(context.ownerId, 0), { claimed: 0, completed: 0, failed: 0, preempted: 0, recovered: 0 });
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'queued'), 1);
    assert.deepEqual(context.graph.backgroundDecisions.list(context.ownerId), []);
  });
});

test('an unloaded model claims no model-backed job and spends no attempt', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { residencyGate: new StaticResidencyGate(false) });
    enqueueChat(enqueue);
    enqueue({ jobType: 'note_tidy', payload: { noteId: 'note_1' } });
    assert.equal((await jobRunner.drain(context.ownerId, 10)).claimed, 0);
    assert.deepEqual(context.graph.jobs.listByStatus(context.ownerId, 'queued').map((job) => job.attempts), [0, 0]);
    assert.equal(lastDecision(context), 'model_not_resident');
  });
});

test('a model that unloads mid-call requeues the job without spending an attempt or GPU time', async () => {
  await withAssistantContextAsync(async (context) => {
    const residencyGate = new StaticResidencyGate(true);
    let recordedGpuUse = 0;

    class UnloadingInference extends FakeAssistantInference {
      async complete(): Promise<never> {
        residencyGate.setResident(false);
        throw new Error('HTTP 500: inline_model_loading is not True in config.yml.');
      }
    }

    class CountingResourcePolicy extends NoLimitResourcePolicy {
      recordGpuUse(): void {
        recordedGpuUse += 1;
      }
    }

    const { jobRunner, enqueue } = setup(context, {
      inference: new UnloadingInference([]), residencyGate, resourcePolicy: new CountingResourcePolicy(),
    });
    enqueueChat(enqueue);
    const summary = await jobRunner.drain(context.ownerId, 10);
    assert.deepEqual([summary.failed, summary.preempted, recordedGpuUse], [0, 1, 0]);
    assert.equal(queuedOf(context, 'chat_note')[0]?.attempts, 0);
    assert.equal(lastDecision(context), 'model_not_resident');
  });
});

test('an unloaded model still lets deterministic jobs drain', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { residencyGate: new StaticResidencyGate(false) });
    enqueue({ jobType: 'capture_retention', payload: {} });
    enqueue({ jobType: 'daily_rollup', payload: { day: '2026-08-05' } });
    assert.equal((await jobRunner.drain(context.ownerId, 10)).completed, 2);
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'queued'), 0);
  });
});
