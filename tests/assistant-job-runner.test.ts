import test from 'node:test';
import assert from 'node:assert/strict';

import { SecretScanner } from '../src/assistant/domain/secrets.ts';
import type { AssistantInferenceClient, AssistantAgentTurnRequest } from '../src/assistant/inference/client.ts';
import { AssistantJobRunner, type InteractivityGate, type ModelResidencyGate } from '../src/assistant/jobs/job-runner.ts';
import { VAULT_MAINTENANCE_REQUEST, type AssistantJobRequest, type AssistantJobType } from '../src/assistant/jobs/job-types.ts';
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
import { VaultMaintenance } from '../src/vault/maintenance.ts';
import { VaultNoteStore } from '../src/vault/note-store.ts';
import { VaultNoteWriter } from '../src/vault/note-writer/agent/note-writer.ts';
import type { VaultChatTurn } from '../src/vault/note-writer/chat-turn.ts';
import { VaultDailyRollup } from '../src/vault/note-writer/daily-rollup.ts';
import { VaultEditApplier } from '../src/vault/note-writer/edit-applier.ts';
import { VaultValidationQueue } from '../src/vault/validation-queue.ts';
import { ScriptedAgentInference, submitTurn } from './helpers/assistant-inference-fake.ts';
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

/** The runner over the real note-writer and maintenance sharing the fixture database. */
function setup(context: AssistantTestContext, overrides: RunnerOverrides = {}) {
  const { database, clock, ids, runtimeRoot, graph } = context;
  const store = new VaultNoteStore(database, clock, ids);
  const attachments = new VaultAttachments(database, clock, ids, runtimeRoot);
  const scanner = new SecretScanner();
  const capability = new StubImageCapability(true);
  const queue = new VaultValidationQueue(database);
  const applier = new VaultEditApplier({ store, database, audit: graph.audit, scanner, ownerDisplayName: 'Denys' });
  const jobRunner = new AssistantJobRunner({
    jobs: graph.jobs,
    decisions: graph.backgroundDecisions,
    noteWriter: new VaultNoteWriter({
      database, store, attachments, applier, audit: graph.audit, scanner, clock, capability, queue,
      inference: overrides.inference ?? new ScriptedAgentInference([]),
    }),
    maintenance: new VaultMaintenance({
      database, clock, queue, jobs: graph.jobs,
      retention: new VaultCaptureRetention({ database, attachments, audit: graph.audit, clock }), rollup: new VaultDailyRollup({ database, store }),
    }),
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
    enqueue({ jobType: 'vault_write', payload: { source: 'capture', attachmentId: outcome.attachmentId } });
    return outcome;
  };
  return { jobRunner, store, enqueue, submitCapture };
}

const TURN: VaultChatTurn = {
  sessionId: 'chat_1', sessionTitle: 'Editor', userMessageId: 'msg_1', capturedAtUtc: '2026-08-05T08:30:00.000Z',
  userText: 'I switched to Neovim.', assistantText: 'Nice.',
};
const USES_NEOVIM = submitTurn([
  { op: 'create_note', title: 'Neovim', type: 'software', lead: 'Neovim is a terminal text editor.' },
  { op: 'add_facts', note: 'the user', label: 'Uses', values: ['Neovim'] },
]);
const NO_OPERATIONS = submitTurn([]);
const GPU_CAPPED = (context: AssistantTestContext) => new AssistantResourcePolicy({
  database: context.database, clock: context.clock,
  background: { ...DEFAULT_ASSISTANT_CONFIG.Background, MaxGpuMinutesPerDay: 0 },
  power: new UnavailablePowerStateProvider(),
});

const enqueueChat = (enqueue: ReturnType<typeof setup>['enqueue'], turn: VaultChatTurn = TURN) =>
  enqueue({ jobType: 'vault_write', payload: { source: 'chat', turn } });
const queuedOf = (context: AssistantTestContext, jobType: AssistantJobType) => context.graph.jobs.listByStatus(context.ownerId, 'queued')
  .filter((job) => job.job_type === jobType);
const lastDecision = (context: AssistantTestContext) => context.graph.backgroundDecisions.list(context.ownerId)[0]?.reason;

/** Requests preemption from inside the model call, as an interactive request arriving mid-job would. */
class PreemptingInference extends ScriptedAgentInference {
  private runner: AssistantJobRunner | null = null;
  private readonly idleGate: StaticIdleGate;
  private readonly honourAbort: boolean;

  constructor(idleGate: StaticIdleGate, turns: ConstructorParameters<typeof ScriptedAgentInference>[0], honourAbort: boolean) {
    super(turns);
    this.idleGate = idleGate;
    this.honourAbort = honourAbort;
  }

  attachRunner(runner: AssistantJobRunner): void {
    this.runner = runner;
  }

  override async chat(request: AssistantAgentTurnRequest) {
    this.idleGate.setIdle(false);
    this.runner?.requestPreemption();
    if (this.honourAbort && request.abortSignal.aborted) throw new Error('Assistant inference aborted by interactive work.');
    return super.chat(request);
  }
}

test('a chat write job writes the chat note and queues maintenance', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, store, enqueue } = setup(context, { inference: new ScriptedAgentInference([USES_NEOVIM]) });
    enqueueChat(enqueue);
    assert.deepEqual(await jobRunner.drain(context.ownerId, 1), { claimed: 1, completed: 1, failed: 0, preempted: 0, recovered: 0 });
    assert.equal(store.resolve('Chat 2026-08-05 · Editor')?.kind, 'chat');
    assert.equal(queuedOf(context, 'vault_maintenance').length, 1);
  });
});

test('a drained chat turn rolls up into the daily note, then reviews the notes it created one batch at a time', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, store, enqueue } = setup(context, { inference: new ScriptedAgentInference([USES_NEOVIM, NO_OPERATIONS, NO_OPERATIONS]) });
    enqueueChat(enqueue);
    // Two new notes make a queue of 2, so each batch is one note: write, maintenance, then review and maintenance twice.
    assert.deepEqual(await jobRunner.drain(context.ownerId, -1), { claimed: 6, completed: 6, failed: 0, preempted: 0, recovered: 0 });
    assert.match(store.resolve('2026-08-05')?.body ?? '', /## Chats\n- \[\[Chat 2026-08-05 · Editor\]\]/);
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'queued'), 0);
    assert.ok(store.resolve('Neovim') !== null);
  });
});

test('refreshConfig applies new priorities to later follow-ups', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { inference: new ScriptedAgentInference([USES_NEOVIM]) });
    const priorities = { ...DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities, Maintenance: 7 };
    jobRunner.refreshConfig({ ...DEFAULT_ASSISTANT_CONFIG, Background: { ...DEFAULT_ASSISTANT_CONFIG.Background, JobPriorities: priorities } });
    enqueueChat(enqueue);
    await jobRunner.drain(context.ownerId, 1);
    assert.equal(queuedOf(context, 'vault_maintenance')[0]?.priority, 7);
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

test('a capture write job processes the capture and maintenance rolls up its local day', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, store, submitCapture } = setup(context, { inference: new ScriptedAgentInference([NO_OPERATIONS]) });
    const capture = submitCapture();
    assert.equal((await jobRunner.drain(context.ownerId, -1)).completed, 2);
    assert.equal(requireCapture(context.database, capture.attachmentId).state, 'processed');
    assert.match(store.resolve('2026-08-05')?.body ?? '', /^1 screenshot · 0 chats/);
  });
});

test('a capture write job for an already processed capture queues nothing', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue, submitCapture } = setup(context, { inference: new ScriptedAgentInference([NO_OPERATIONS]) });
    const capture = submitCapture();
    await jobRunner.drain(context.ownerId, -1);
    enqueue({ jobType: 'vault_write', payload: { source: 'capture', attachmentId: capture.attachmentId } });
    assert.equal((await jobRunner.drain(context.ownerId, -1)).completed, 1);
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'queued'), 0);
  });
});

test('a maintenance job applies the configured image age limit', async () => {
  await withAssistantContextAsync(async (context) => {
    const config: AssistantConfig = { ...DEFAULT_ASSISTANT_CONFIG, Vault: { CaptureImageMaxAgeDays: 1 } };
    const { jobRunner, enqueue, submitCapture } = setup(context, { inference: new ScriptedAgentInference([NO_OPERATIONS]), config });
    const capture = submitCapture();
    await jobRunner.drain(context.ownerId, -1);
    context.clock.advanceDays(2);
    enqueue(VAULT_MAINTENANCE_REQUEST);
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
    assert.equal(queuedOf(context, 'vault_write')[0]?.attempts, 0, 'preemption is not failure');
    assert.equal(store.resolve('Chat 2026-08-05 · Editor'), null);
    assert.equal(lastDecision(context), 'preemption_requested');
  });
});

test('preemption after the agent submitted commits the job instead of replaying it', async () => {
  await withAssistantContextAsync(async (context) => {
    const idleGate = new StaticIdleGate(true);
    const inference = new PreemptingInference(idleGate, [USES_NEOVIM], false);
    const { jobRunner, store, enqueue } = setup(context, { inference, idleGate });
    inference.attachRunner(jobRunner);
    enqueueChat(enqueue);

    assert.deepEqual(await jobRunner.drain(context.ownerId, -1), { claimed: 1, completed: 1, failed: 0, preempted: 0, recovered: 0 });
    assert.equal(queuedOf(context, 'vault_write').length, 0, 'a replayed chat job would duplicate the transcript');
    assert.equal(store.resolve('Chat 2026-08-05 · Editor')?.kind, 'chat');
    assert.equal(queuedOf(context, 'vault_maintenance').length, 1);
    assert.equal(lastDecision(context), 'preemption_requested');
  });
});

test('a failing job requeues with one attempt spent and then leaves nothing claimable', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context);
    enqueueChat(enqueue);
    const summary = await jobRunner.drain(context.ownerId, -1);
    assert.deepEqual([summary.claimed, summary.failed], [1, 1]);
    assert.equal(queuedOf(context, 'vault_write')[0]?.attempts, 1);
    assert.equal(lastDecision(context), 'no_claimable_job');
  });
});

test('recovery re-queues a lease abandoned by a crashed runner', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context);
    enqueue(VAULT_MAINTENANCE_REQUEST);
    context.graph.jobs.claimNext({ ownerId: context.ownerId, leaseOwner: 'crashed', leaseSeconds: 30, modelWorkAllowed: true });
    context.clock.advanceSeconds(31);
    const summary = await jobRunner.drain(context.ownerId, 5);
    assert.equal(summary.recovered, 1);
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'completed'), 1);
  });
});

test('the daily GPU cap skips model-backed jobs but still drains maintenance', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { resourcePolicy: GPU_CAPPED(context) });
    enqueueChat(enqueue);
    enqueue(VAULT_MAINTENANCE_REQUEST);
    assert.deepEqual(await jobRunner.drain(context.ownerId, -1), { claimed: 1, completed: 1, failed: 0, preempted: 0, recovered: 0 });
    assert.equal(queuedOf(context, 'vault_write').length, 1);
    assert.equal(lastDecision(context), 'daily_gpu_limit');
  });
});

test('an unlimited drain claims every claimable job and stops when none remain', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, store, enqueue } = setup(context);
    context.database.prepare("INSERT INTO vault_rollup_days (day) VALUES ('2026-08-03'), ('2026-08-04')").run();
    enqueue(VAULT_MAINTENANCE_REQUEST);
    assert.deepEqual(await jobRunner.drain(context.ownerId, -1), { claimed: 1, completed: 1, failed: 0, preempted: 0, recovered: 0 });
    assert.deepEqual(context.graph.backgroundDecisions.list(context.ownerId), []);
    assert.deepEqual([store.resolve('2026-08-03'), store.resolve('2026-08-04')].map((note) => note === null), [true, true], 'an empty day writes no daily note');
  });
});

test('a zero drain budget claims nothing', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context);
    enqueue(VAULT_MAINTENANCE_REQUEST);
    assert.deepEqual(await jobRunner.drain(context.ownerId, 0), { claimed: 0, completed: 0, failed: 0, preempted: 0, recovered: 0 });
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'queued'), 1);
    assert.deepEqual(context.graph.backgroundDecisions.list(context.ownerId), []);
  });
});

test('an unloaded model claims no model-backed job and spends no attempt', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { residencyGate: new StaticResidencyGate(false) });
    enqueueChat(enqueue);
    enqueue({ jobType: 'vault_write', payload: { source: 'review', noteIds: ['note_1'] } });
    assert.equal((await jobRunner.drain(context.ownerId, 10)).claimed, 0);
    assert.deepEqual(context.graph.jobs.listByStatus(context.ownerId, 'queued').map((job) => job.attempts), [0, 0]);
    assert.equal(lastDecision(context), 'model_not_resident');
  });
});

test('a model that unloads mid-call requeues the job without spending an attempt or GPU time', async () => {
  await withAssistantContextAsync(async (context) => {
    const residencyGate = new StaticResidencyGate(true);
    let recordedGpuUse = 0;

    class UnloadingInference extends ScriptedAgentInference {
      override async chat(): Promise<never> {
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
    assert.equal(queuedOf(context, 'vault_write')[0]?.attempts, 0);
    assert.equal(lastDecision(context), 'model_not_resident');
  });
});

test('an unloaded model still lets maintenance drain', async () => {
  await withAssistantContextAsync(async (context) => {
    const { jobRunner, enqueue } = setup(context, { residencyGate: new StaticResidencyGate(false) });
    enqueue(VAULT_MAINTENANCE_REQUEST);
    assert.equal((await jobRunner.drain(context.ownerId, 10)).completed, 1);
    assert.equal(context.graph.jobs.countByStatus(context.ownerId, 'queued'), 0);
  });
});
