import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { DesktopStateDtoSchema, type CaptureSubmissionDto } from '@siftkit/contracts';
import { AssistantService } from '../src/assistant/assistant-service.js';
import { AssistantConflictError, AssistantNotFoundError } from '../src/assistant/errors.js';
import { FixedClock } from '../src/assistant/clock.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import type {
  AssistantImageCapability, AssistantImageCapabilityProvider,
} from '../src/assistant/images/image-capability.js';
import { QuestionStore } from '../src/assistant/storage/question-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { MemoryAssistantConfigWriter } from './helpers/assistant-fixture.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { closeHttpServer, getAddressInfo, requestJson } from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';
import { ALWAYS_IDLE, ALWAYS_RESIDENT } from './helpers/assistant-gates.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf'
  + 'FcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

class StubImageCapability implements AssistantImageCapabilityProvider {
  constructor(private readonly capable: boolean) {}

  read(): AssistantImageCapability {
    return {
      instanceId: this.capable ? 'exl3:1' : null,
      visionCapable: this.capable,
      healthy: this.capable,
    };
  }
}

function captureDto(capturedAtUtc: string): CaptureSubmissionDto {
  return {
    schemaVersion: 1,
    capturedAtUtc,
    reason: 'fixed_cadence',
    display: {
      id: 'DISPLAY1', name: 'Monitor', primary: true,
      pixelWidth: 1920, pixelHeight: 1080, logicalWidth: 1920, logicalHeight: 1080,
      scaleFactor: 1,
    },
    foregroundContextKey: 'app:code|siftkit',
    foreground: {
      processName: 'Code.exe',
      executablePath: 'C:/Code.exe',
      applicationId: 'app:code',
      normalizedTitle: 'SiftKit',
      fullscreen: false,
    },
    pixelSha256: '1'.repeat(64),
    perceptualHash: 'f0e1d2c3b4a59687',
    imageDataUrl: PNG_DATA_URL,
  };
}

function createEligibleQuestion(service: AssistantService, nowUtc: string): string {
  const question = service.graph.questions.create({
    ownerId: service.ownerId,
    topicKey: 'preferences:editor',
    questionText: 'Do you prefer VS Code?',
    questionType: 'confirm_inference',
    candidateIds: [],
    expectedValue: 0.8,
    interruptionCost: 0.1,
    eligibleAfterUtc: null,
    expiresAtUtc: null,
  });
  service.graph.questions.markEligible(question.id, nowUtc);
  return question.id;
}

function buildService(runtimeRoot: string, clock: FixedClock): AssistantService {
  const config = {
    ...DEFAULT_ASSISTANT_CONFIG,
    Enabled: true,
    Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, ScreenshotsEnabled: true },
  };
  return AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock,
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(config),
    inference: new FakeAssistantInference([]),
    tokens: new EstimateTokenCounter(4),
    idleGate: ALWAYS_IDLE,
    residencyGate: ALWAYS_RESIDENT,
    imageCapability: new StubImageCapability(false),
    config,
  });
}

test('desktop state reports config, custody, capability, queue depth, and the eligible question', () => {
  const runtimeRoot = createManagedTempDir('siftkit-desktop-state-');
  const clock = new FixedClock('2026-08-10T09:00:00.000Z');
  const service = buildService(runtimeRoot, clock);
  try {
    const outcome = service.ingestCapture(captureDto(clock.nowUtc()));
    assert.equal(outcome.kind, 'accepted');
    const questionId = createEligibleQuestion(service, clock.nowUtc());

    const state = DesktopStateDtoSchema.parse(service.desktopState());
    assert.equal(state.assistantEnabled, true);
    assert.equal(state.captureEnabled, true);
    assert.equal(state.paused, false);
    assert.equal(state.custody.custody, 'file');
    assert.equal(state.imageCapability.capable, false);
    assert.equal(state.imageCapability.instanceId, null);
    assert.equal(state.imageCapability.queueDepth, 1);
    assert.deepEqual(state.pendingQuestion, {
      id: questionId, questionText: 'Do you prefer VS Code?',
    });

    assert.equal(
      service.graph.questions.requireQuestion(questionId).status, 'eligible',
      'a state poll never marks a question shown',
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('mark-shown is the only writer of shown_at_utc and rejects every other status', () => {
  const runtimeRoot = createManagedTempDir('siftkit-desktop-shown-');
  const clock = new FixedClock('2026-08-10T09:00:00.000Z');
  const service = buildService(runtimeRoot, clock);
  try {
    const questionId = createEligibleQuestion(service, clock.nowUtc());
    assert.equal(service.graph.questions.requireQuestion(questionId).shown_at_utc, null);

    service.markQuestionShown(questionId);
    const shown = service.graph.questions.requireQuestion(questionId);
    assert.equal(shown.status, 'shown');
    assert.equal(shown.shown_at_utc, clock.nowUtc());

    assert.throws(() => service.markQuestionShown(questionId), AssistantConflictError);

    service.dismissQuestion(questionId);
    assert.equal(service.graph.questions.requireQuestion(questionId).status, 'dismissed');
    assert.throws(() => service.markQuestionShown(questionId), AssistantConflictError);
    assert.throws(() => service.dismissQuestion(questionId), AssistantConflictError);

    assert.throws(() => service.markQuestionShown('question_missing'), AssistantNotFoundError);
    assert.throws(() => service.dismissQuestion('question_missing'), AssistantNotFoundError);
  } finally {
    closeRuntimeDatabase();
  }
});

test('the desktop state and question routes serve the shell contract end to end', async () => {
  const tempRoot = createManagedTempDir('siftkit-desktop-state-route-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  const enabled = {
    ...initial.Assistant,
    Enabled: true,
    Observation: { ...initial.Assistant.Observation, ScreenshotsEnabled: true },
  };
  writeConfig(getConfigPath(), { ...initial, Assistant: enabled });
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  try {
    assert.equal(
      (await requestJson(`${baseUrl}/assistant/desktop/state`)).statusCode, 401,
      'the state poll requires the bearer',
    );

    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const headers = { Authorization: `Bearer ${token}` };

    const first = await requestJson(`${baseUrl}/assistant/desktop/state`, { headers });
    assert.equal(first.statusCode, 200);
    const firstState = DesktopStateDtoSchema.parse(first.body);
    assert.equal(firstState.assistantEnabled, true);
    assert.equal(firstState.captureEnabled, true);
    assert.equal(firstState.paused, false);
    assert.equal(firstState.pendingQuestion, null);

    const database = getRuntimeDatabase(path.join(tempRoot, '.siftkit', 'runtime.sqlite'));
    const questions = new QuestionStore(
      database, new FixedClock('2026-08-10T09:00:00.000Z'), new SequentialIdGenerator(),
    );
    const question = questions.create({
      ownerId: LOCAL_OWNER_ID,
      topicKey: 'preferences:editor',
      questionText: 'Do you prefer VS Code?',
      questionType: 'confirm_inference',
      candidateIds: [],
      expectedValue: 0.8,
      interruptionCost: 0.1,
      eligibleAfterUtc: null,
      expiresAtUtc: null,
    });
    questions.markEligible(question.id, '2026-08-10T09:00:00.000Z');

    const polled = await requestJson(`${baseUrl}/assistant/desktop/state`, { headers });
    const polledState = DesktopStateDtoSchema.parse(polled.body);
    assert.deepEqual(polledState.pendingQuestion, {
      id: question.id, questionText: 'Do you prefer VS Code?',
    });
    assert.equal(
      questions.requireQuestion(question.id).status, 'eligible',
      'the poll must not transition the question',
    );

    const shown = await requestJson(`${baseUrl}/assistant/questions/mark-shown`, {
      method: 'POST', headers, body: JSON.stringify({ questionId: question.id }),
    });
    assert.equal(shown.statusCode, 200);
    assert.equal(questions.requireQuestion(question.id).status, 'shown');
    assert.notEqual(questions.requireQuestion(question.id).shown_at_utc, null);

    assert.equal((await requestJson(`${baseUrl}/assistant/questions/mark-shown`, {
      method: 'POST', headers, body: JSON.stringify({ questionId: question.id }),
    })).statusCode, 409, 'mark-shown rejects a question that is not eligible');

    const dismissed = await requestJson(`${baseUrl}/assistant/questions/dismiss`, {
      method: 'POST', headers, body: JSON.stringify({ questionId: question.id }),
    });
    assert.equal(dismissed.statusCode, 200);
    assert.equal(questions.requireQuestion(question.id).status, 'dismissed');

    assert.equal((await requestJson(`${baseUrl}/assistant/questions/mark-shown`, {
      method: 'POST', headers, body: JSON.stringify({ questionId: 'question_missing' }),
    })).statusCode, 404);

    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        assistant: { ...enabled, PrivateMode: { Active: true, ExpiresAtUtc: null } },
      }),
    })).statusCode, 200);
    const paused = DesktopStateDtoSchema.parse(
      (await requestJson(`${baseUrl}/assistant/desktop/state`, { headers })).body,
    );
    assert.equal(paused.paused, true);

    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ assistant: { ...enabled, Enabled: false } }),
    })).statusCode, 200);
    const disabled = await requestJson(`${baseUrl}/assistant/desktop/state`, { headers });
    assert.equal(disabled.statusCode, 200, 'the tray needs state even while the assistant is off');
    const disabledState = DesktopStateDtoSchema.parse(disabled.body);
    assert.equal(disabledState.assistantEnabled, false);
    assert.equal(disabledState.captureEnabled, false);
    assert.equal(disabledState.pendingQuestion, null);

    assert.equal((await requestJson(`${baseUrl}/assistant/questions/dismiss`, {
      method: 'POST', headers, body: JSON.stringify({ questionId: question.id }),
    })).statusCode, 409, 'question mutations stay behind the enabled gate');
  } finally {
    await closeHttpServer(server);
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});
