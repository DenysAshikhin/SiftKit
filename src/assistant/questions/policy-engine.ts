import type { AssistantConfig } from '../../config/types.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { SUPPORTED_QUESTION_GAP_TYPES, type QuestionCandidate } from './candidates.js';
import type { QuestionEnvironmentStateProvider } from './environment-state.js';

export interface QuestionPolicyHistory {
  readonly shownToday: number;
  readonly shownThisWeek: number;
  readonly lastShownAtUtc: string | null;
  readonly lastDismissedAtUtc: string | null;
  readonly duplicateLiveQuestion: boolean;
}

export interface QuestionPolicyContext {
  isTopicBlocked(ownerId: string, topicKey: string): boolean;
  readHistory(ownerId: string, topicKey: string, nowUtc: string): QuestionPolicyHistory;
}

export type QuestionPolicyDecision =
  | { readonly kind: 'eligible'; readonly reason: 'eligible'; readonly score: number }
  | { readonly kind: 'pending_only'; readonly reason: 'environment_unavailable'; readonly score: 0 }
  | { readonly kind: 'ineligible'; readonly reason: string; readonly score: number };

const LIVE_STATUSES = ['planned', 'eligible', 'shown', 'snoozed'] as const;

function isLiveStatus(status: string): boolean {
  return LIVE_STATUSES.some((entry) => entry === status);
}

export class GraphQuestionPolicyContext implements QuestionPolicyContext {
  constructor(private readonly graph: AssistantGraph) {}

  isTopicBlocked(ownerId: string, topicKey: string): boolean {
    return this.graph.policies.isTopicBlockedFromInference(ownerId, topicKey);
  }

  readHistory(ownerId: string, topicKey: string, nowUtc: string): QuestionPolicyHistory {
    const now = Date.parse(nowUtc);
    const dayStart = now - 86_400_000;
    const weekStart = now - 7 * 86_400_000;
    const questions = this.graph.questions.listAll(ownerId);
    const shown = questions.filter((row) => row.shown_at_utc !== null);
    const lastShownAtUtc = shown.map((row) => row.shown_at_utc)
      .filter((value) => value !== null)
      .sort()
      .at(-1) ?? null;
    const lastDismissedAtUtc = questions
      .filter((row) => row.topic_key === topicKey && row.status === 'dismissed')
      .map((row) => row.updated_at_utc)
      .sort()
      .at(-1) ?? null;
    return {
      shownToday: shown.filter((row) => Date.parse(row.shown_at_utc ?? '') > dayStart).length,
      shownThisWeek: shown.filter((row) => Date.parse(row.shown_at_utc ?? '') > weekStart).length,
      lastShownAtUtc,
      lastDismissedAtUtc,
      duplicateLiveQuestion: questions.some(
        (row) => row.topic_key === topicKey && isLiveStatus(row.status),
      ),
    };
  }
}

function hoursBetween(earlierUtc: string, laterUtc: string): number {
  return (Date.parse(laterUtc) - Date.parse(earlierUtc)) / 3_600_000;
}

function isAllowedLocalTime(localTime: string, start: string, end: string): boolean {
  if (start === end) return true;
  if (start < end) return localTime >= start && localTime <= end;
  return localTime >= start || localTime <= end;
}

function score(candidate: QuestionCandidate): number {
  const signals = [
    candidate.uncertaintyReduction, candidate.futureUsefulness, candidate.currentRelevance,
    candidate.answerability, candidate.interruptionCost, candidate.sensitivityCost,
    candidate.repeatPenalty,
  ];
  if (signals.some((signal) => !Number.isFinite(signal) || signal < 0 || signal > 1)) {
    throw new Error('Question policy score components must be normalized to [0, 1].');
  }
  return candidate.uncertaintyReduction
    * candidate.futureUsefulness
    * candidate.currentRelevance
    * candidate.answerability
    - candidate.interruptionCost
    - candidate.sensitivityCost
    - candidate.repeatPenalty;
}

export class QuestionPolicyEngine {
  constructor(
    private readonly environment: QuestionEnvironmentStateProvider,
    private readonly context: QuestionPolicyContext,
  ) {}

  evaluate(candidate: QuestionCandidate, config: AssistantConfig): QuestionPolicyDecision {
    if (!config.Enabled) return this.ineligible('assistant_disabled');
    if (!config.Questions.Enabled) return this.ineligible('questions_disabled');
    if (candidate.concreteBenefit === null || candidate.concreteBenefit.trim() === '') {
      return this.ineligible('no_concrete_benefit');
    }
    if (!SUPPORTED_QUESTION_GAP_TYPES.some((gapType) => gapType === candidate.gapType)) {
      return this.ineligible('unsupported_gap_type');
    }
    if (this.context.isTopicBlocked(candidate.ownerId, candidate.topicKey)) {
      return this.ineligible('topic_blocked');
    }
    if (config.PrivateMode.Active) return this.ineligible('private_mode');

    const environment = this.environment.read();
    if (environment.kind === 'unavailable') {
      return { kind: 'pending_only', reason: 'environment_unavailable', score: 0 };
    }
    if (Date.parse(candidate.expiresAtUtc) <= Date.parse(environment.nowUtc)) {
      return this.ineligible('expired');
    }
    if (!isAllowedLocalTime(
      environment.localTime,
      config.Questions.AllowedLocalTimeStart,
      config.Questions.AllowedLocalTimeEnd,
    )) return this.ineligible('outside_allowed_time');

    const history = this.context.readHistory(
      candidate.ownerId, candidate.topicKey, environment.nowUtc,
    );
    if (history.shownToday >= config.Questions.MaxPerDay) return this.ineligible('daily_cap');
    if (history.shownThisWeek >= config.Questions.MaxPerWeek) return this.ineligible('weekly_cap');
    if (
      history.lastShownAtUtc !== null
      && hoursBetween(history.lastShownAtUtc, environment.nowUtc)
        < config.Questions.MinimumHoursBetweenQuestions
    ) return this.ineligible('minimum_interval');
    if (
      history.lastDismissedAtUtc !== null
      && hoursBetween(history.lastDismissedAtUtc, environment.nowUtc)
        < config.Questions.DismissedCooldownDays * 24
    ) return this.ineligible('dismissed_cooldown');
    if (history.duplicateLiveQuestion) return this.ineligible('duplicate_live_question');
    if (config.Questions.SuppressDuringFullscreen && environment.fullscreen) {
      return this.ineligible('fullscreen');
    }
    if (environment.locked) return this.ineligible('locked');
    if (config.Questions.SuppressDuringDoNotDisturb && environment.doNotDisturb) {
      return this.ineligible('do_not_disturb');
    }
    if (environment.presenting) return this.ineligible('presenting');
    if (environment.excludedApplication) return this.ineligible('excluded_application');
    const secondsSinceAnyInput = Math.min(
      environment.secondsSinceMouseInput, environment.secondsSinceKeyboardInput,
    );
    if (secondsSinceAnyInput < config.Questions.ActiveInputSuppressionSeconds) {
      return this.ineligible('recent_input');
    }

    const candidateScore = score(candidate);
    return candidateScore > 0
      ? { kind: 'eligible', reason: 'eligible', score: candidateScore }
      : this.ineligible('score_not_positive', candidateScore);
  }

  private ineligible(reason: string, candidateScore = 0): QuestionPolicyDecision {
    return { kind: 'ineligible', reason, score: candidateScore };
  }
}
