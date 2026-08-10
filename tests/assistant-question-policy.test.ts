import assert from 'node:assert/strict';
import test from 'node:test';

import type { AssistantConfig } from '../src/config/types.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import {
  GraphQuestionCandidateSource,
  type QuestionCandidate,
} from '../src/assistant/questions/candidates.js';
import type {
  QuestionEnvironmentState,
  QuestionEnvironmentStateProvider,
} from '../src/assistant/questions/environment-state.js';
import {
  QuestionPolicyEngine,
  type QuestionPolicyContext,
  type QuestionPolicyHistory,
} from '../src/assistant/questions/policy-engine.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

const available: QuestionEnvironmentState = {
  kind: 'available',
  nowUtc: '2026-08-05T23:00:00.000Z',
  localTime: '19:00',
  fullscreen: false,
  locked: false,
  doNotDisturb: false,
  presenting: false,
  excludedApplication: false,
  secondsSinceInput: 1_000,
};

const candidate: QuestionCandidate = {
  id: 'question_candidate_1',
  ownerId: 'owner_local',
  topicKey: 'powershell',
  questionType: 'confirm_inference',
  gapType: 'candidate_confirmation',
  candidateIds: ['cand_1'],
  concreteBenefit: 'Avoid repeating an uncertain shell preference.',
  uncertaintyReduction: 0.9,
  futureUsefulness: 0.9,
  currentRelevance: 0.9,
  answerability: 0.9,
  interruptionCost: 0.1,
  sensitivityCost: 0.1,
  repeatPenalty: 0,
  expiresAtUtc: '2026-08-12T23:00:00.000Z',
};

const emptyHistory: QuestionPolicyHistory = {
  shownToday: 0,
  shownThisWeek: 0,
  lastShownAtUtc: null,
  lastDismissedAtUtc: null,
  duplicateLiveQuestion: false,
};

class FakeEnvironment implements QuestionEnvironmentStateProvider {
  state: QuestionEnvironmentState = available;
  read(): QuestionEnvironmentState { return this.state; }
}

class FakePolicyContext implements QuestionPolicyContext {
  blocked = false;
  history: QuestionPolicyHistory = emptyHistory;
  isTopicBlocked(): boolean { return this.blocked; }
  readHistory(): QuestionPolicyHistory { return this.history; }
}

function config(overrides: Partial<AssistantConfig['Questions']> = {}): AssistantConfig {
  return {
    ...DEFAULT_ASSISTANT_CONFIG,
    Enabled: true,
    Questions: { ...DEFAULT_ASSISTANT_CONFIG.Questions, ...overrides },
  };
}

function evaluate(options: {
  readonly candidate?: QuestionCandidate;
  readonly config?: AssistantConfig;
  readonly environment?: QuestionEnvironmentState;
  readonly history?: QuestionPolicyHistory;
  readonly blocked?: boolean;
} = {}) {
  const environment = new FakeEnvironment();
  environment.state = options.environment ?? available;
  const context = new FakePolicyContext();
  context.history = options.history ?? emptyHistory;
  context.blocked = options.blocked ?? false;
  return new QuestionPolicyEngine(environment, context).evaluate(
    options.candidate ?? candidate,
    options.config ?? config(),
  );
}

test('question policy accepts a useful, answerable candidate in the allowed window', () => {
  const result = evaluate();
  assert.equal(result.kind, 'eligible');
  assert.ok(result.score > 0);
});

test('question policy returns stable reasons for every hard gate', () => {
  const cases: readonly [string, ReturnType<typeof evaluate>][] = [
    ['assistant_disabled', evaluate({ config: { ...config(), Enabled: false } })],
    ['questions_disabled', evaluate({ config: config({ Enabled: false }) })],
    ['no_concrete_benefit', evaluate({ candidate: { ...candidate, concreteBenefit: null } })],
    ['unsupported_gap_type', evaluate({ candidate: { ...candidate, gapType: 'idle_curiosity' } })],
    ['topic_blocked', evaluate({ blocked: true })],
    ['outside_allowed_time', evaluate({ environment: { ...available, localTime: '12:00' } })],
    ['daily_cap', evaluate({ history: { ...emptyHistory, shownToday: 1 } })],
    ['weekly_cap', evaluate({ history: { ...emptyHistory, shownThisWeek: 3 } })],
    ['minimum_interval', evaluate({
      history: { ...emptyHistory, lastShownAtUtc: '2026-08-05T12:00:00.000Z' },
    })],
    ['dismissed_cooldown', evaluate({
      history: { ...emptyHistory, lastDismissedAtUtc: '2026-08-01T23:00:00.000Z' },
    })],
    ['duplicate_live_question', evaluate({
      history: { ...emptyHistory, duplicateLiveQuestion: true },
    })],
    ['expired', evaluate({
      candidate: { ...candidate, expiresAtUtc: '2026-08-05T22:59:59.000Z' },
    })],
    ['fullscreen', evaluate({ environment: { ...available, fullscreen: true } })],
    ['locked', evaluate({ environment: { ...available, locked: true } })],
    ['do_not_disturb', evaluate({ environment: { ...available, doNotDisturb: true } })],
    ['presenting', evaluate({ environment: { ...available, presenting: true } })],
    ['excluded_application', evaluate({
      environment: { ...available, excludedApplication: true },
    })],
    ['recent_input', evaluate({ environment: { ...available, secondsSinceInput: 10 } })],
    ['private_mode', evaluate({ config: { ...config(), PrivateMode: {
      Active: true, ExpiresAtUtc: null,
    } } })],
    ['score_not_positive', evaluate({ candidate: {
      ...candidate, uncertaintyReduction: 0, sensitivityCost: 0, interruptionCost: 0,
    } })],
  ];
  for (const [reason, result] of cases) {
    assert.equal(result.kind, 'ineligible', reason);
    assert.equal(result.reason, reason);
  }
});

test('unavailable environment is pending-only and never eligible', () => {
  assert.deepEqual(evaluate({ environment: { kind: 'unavailable' } }), {
    kind: 'pending_only', reason: 'environment_unavailable', score: 0,
  });
});

test('allowed time supports midnight wrap and sensitivity cost lowers score', () => {
  const wrapped = evaluate({
    config: config({ AllowedLocalTimeStart: '22:00', AllowedLocalTimeEnd: '02:00' }),
    environment: { ...available, localTime: '01:00' },
  });
  assert.equal(wrapped.kind, 'eligible');
  const lowCost = evaluate({ candidate: { ...candidate, sensitivityCost: 0 } });
  const highCost = evaluate({ candidate: { ...candidate, sensitivityCost: 0.8 } });
  assert.ok(lowCost.score > highCost.score);
});

test('candidate source derives only confirmation, conflict, and unplanned-goal gaps', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const person = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    graph.nodes.createNode({
      ownerId, type: 'goal', canonicalKey: 'goal:ship', displayName: 'Ship Gate C',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, parentEvidenceId: null, sourceType: 'conversation_message',
      sourceEventId: 'chat:candidate', sourceRef: 'chat', capturedAtUtc: graph.nowUtc(),
      sourceTimezone: null, sensitivity: 'personal', retentionUntilUtc: null,
      metadata: {}, text: 'I might prefer PowerShell.',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
      payload: {}, confidence: 0.5, sensitivity: 'personal',
      extractorName: 'test', extractorVersion: '1',
    });
    const proposed = graph.candidates.propose({
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'HAS_ROLE',
      object: { kind: 'literal', valueType: 'string', value: 'PowerShell user' },
      scope: null, basis: 'assistant_inference', confidence: 0.5,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      rationale: 'Uncertain statement.',
    });
    if (proposed === null) throw new Error('Expected candidate proposal.');
    graph.candidates.needsConfirmation(proposed.id, 'confidence');
    const assertion = graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: person.id,
      predicate: 'HAS_ROLE',
      object: { kind: 'literal', valueType: 'string', value: 'developer' },
      scopeNodeId: null, basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: graph.nowUtc(), topics: [],
      attributes: {}, searchText: {
        subject: 'the user', predicate: 'HAS_ROLE', object: 'developer', scope: '',
      },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 1 }],
    });
    if (assertion.kind !== 'created') throw new Error('Expected assertion creation.');
    graph.assertions.setStatus(assertion.assertionId, 'disputed');

    const result = new GraphQuestionCandidateSource(graph).list(ownerId);
    assert.deepEqual(
      result.map((entry) => entry.questionType).sort(),
      ['confirm_inference', 'follow_active_goal', 'resolve_conflict'],
    );
    assert.ok(result.every((entry) => entry.concreteBenefit !== null));
  });
});
