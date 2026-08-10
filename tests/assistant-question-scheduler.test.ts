import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import type { AssistantConfig } from '../src/config/types.js';
import type {
  QuestionCandidate,
  QuestionCandidateSource,
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
import type {
  QuestionPlanningService,
  QuestionProposal,
} from '../src/assistant/questions/planner.js';
import { QuestionScheduler } from '../src/assistant/questions/scheduler.js';
import { withAssistantContextAsync } from './helpers/assistant-fixture.js';

const baseCandidate: QuestionCandidate = {
  id: 'qc_1', ownerId: 'owner_local', topicKey: 'alpha',
  questionType: 'confirm_inference', gapType: 'candidate_confirmation',
  candidateIds: ['cand_1'], concreteBenefit: 'Improve future answers.',
  uncertaintyReduction: 0.8, futureUsefulness: 0.9, currentRelevance: 0.8,
  answerability: 0.9, interruptionCost: 0.1, sensitivityCost: 0.1,
  repeatPenalty: 0, expiresAtUtc: '2026-08-12T09:00:00.000Z',
};

class FixedCandidates implements QuestionCandidateSource {
  constructor(private readonly candidates: readonly QuestionCandidate[]) {}
  list(): QuestionCandidate[] { return [...this.candidates]; }
}

class FixedEnvironment implements QuestionEnvironmentStateProvider {
  constructor(private readonly state: QuestionEnvironmentState) {}
  read(): QuestionEnvironmentState { return this.state; }
}

class EmptyContext implements QuestionPolicyContext {
  isTopicBlocked(): boolean { return false; }
  readHistory(): QuestionPolicyHistory {
    return {
      shownToday: 0, shownThisWeek: 0, lastShownAtUtc: null,
      lastDismissedAtUtc: null, duplicateLiveQuestion: false,
    };
  }
}

class RecordingPlanner implements QuestionPlanningService {
  readonly planned: QuestionCandidate[] = [];
  async plan(candidate: QuestionCandidate): Promise<QuestionProposal> {
    this.planned.push(candidate);
    return { questionText: `Question about ${candidate.topicKey}?` };
  }
}

function enabledConfig(maxPerDay = 1): AssistantConfig {
  return {
    ...DEFAULT_ASSISTANT_CONFIG,
    Enabled: true,
    Questions: { ...DEFAULT_ASSISTANT_CONFIG.Questions, MaxPerDay: maxPerDay },
  };
}

const environment: QuestionEnvironmentState = {
  kind: 'available', nowUtc: '2026-08-05T09:00:00.000Z', localTime: '19:00',
  fullscreen: false, locked: false, doNotDisturb: false, presenting: false,
  excludedApplication: false, secondsSinceInput: 1_000,
};

test('scheduler orders by score, respects capacity, and marks one eligible question', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const planner = new RecordingPlanner();
    const stronger = { ...baseCandidate, id: 'qc_b', topicKey: 'beta', uncertaintyReduction: 1 };
    const scheduler = new QuestionScheduler({
      graph,
      candidates: new FixedCandidates([baseCandidate, stronger]),
      policy: new QuestionPolicyEngine(new FixedEnvironment(environment), new EmptyContext()),
      planner,
      config: enabledConfig(1),
    });
    const summary = await scheduler.planPending(ownerId, new AbortController().signal);
    assert.deepEqual(summary, { planned: 1, eligible: 1, pendingOnly: 0, expired: 0 });
    assert.equal(planner.planned[0]?.topicKey, 'beta');
    assert.equal(scheduler.current(ownerId)?.status, 'eligible');
  });
});

test('scheduler stores pending-only questions without exposing them', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const scheduler = new QuestionScheduler({
      graph,
      candidates: new FixedCandidates([baseCandidate]),
      policy: new QuestionPolicyEngine(
        new FixedEnvironment({ kind: 'unavailable' }), new EmptyContext(),
      ),
      planner: new RecordingPlanner(),
      config: enabledConfig(),
    });
    const summary = await scheduler.planPending(ownerId, new AbortController().signal);
    assert.equal(summary.pendingOnly, 1);
    assert.equal(graph.questions.listPending(ownerId)[0]?.status, 'planned');
    assert.equal(scheduler.current(ownerId), null);
  });
});

test('scheduler applies the refreshed configured unanswered expiry', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const scheduler = new QuestionScheduler({
      graph,
      candidates: new FixedCandidates([baseCandidate]),
      policy: new QuestionPolicyEngine(new FixedEnvironment(environment), new EmptyContext()),
      planner: new RecordingPlanner(),
      config: enabledConfig(),
    });
    scheduler.refreshConfig({
      ...enabledConfig(),
      Questions: { ...enabledConfig().Questions, UnansweredExpiryDays: 3 },
    });
    await scheduler.planPending(ownerId, new AbortController().signal);
    assert.equal(
      graph.questions.listPending(ownerId)[0]?.expires_at_utc,
      '2026-08-08T09:00:00.000Z',
    );
  });
});

test('scheduler expires due rows and deduplicates a live topic before planning', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    graph.questions.create({
      ownerId, topicKey: 'expired', questionText: 'Old?', questionType: 'confirm_inference',
      candidateIds: [], expectedValue: 0.5, interruptionCost: 0.1,
      eligibleAfterUtc: null, expiresAtUtc: '2026-08-04T09:00:00.000Z',
    });
    graph.questions.create({
      ownerId, topicKey: 'alpha', questionText: 'Existing?', questionType: 'confirm_inference',
      candidateIds: [], expectedValue: 0.5, interruptionCost: 0.1,
      eligibleAfterUtc: null, expiresAtUtc: '2026-08-12T09:00:00.000Z',
    });
    const planner = new RecordingPlanner();
    const scheduler = new QuestionScheduler({
      graph, candidates: new FixedCandidates([baseCandidate]),
      policy: new QuestionPolicyEngine(new FixedEnvironment(environment), new EmptyContext()),
      planner, config: enabledConfig(),
    });
    const summary = await scheduler.planPending(ownerId, new AbortController().signal);
    assert.equal(summary.expired, 1);
    assert.equal(summary.planned, 0);
    assert.equal(planner.planned.length, 0);
  });
});
