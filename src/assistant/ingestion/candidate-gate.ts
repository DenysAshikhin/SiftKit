import { BASIS_CONFIDENCE_CEILING } from '../domain/confidence.js';
import {
  isExplicitBasis, type AssertionBasis, type EvidenceSourceType,
} from '../domain/enums.js';
import type { SecretScanner, SensitiveTopic } from '../domain/secrets.js';
import type { PolicyStore } from '../storage/policy-store.js';

export type CandidateRejectionCode =
  | 'empty_rationale' | 'secret_prohibited' | 'basis_unsupported' | 'confidence_out_of_range'
  | 'dates_malformed' | 'dates_inconsistent' | 'blocked_topic';

export type CandidateGateOutcome =
  | { readonly kind: 'accept'; readonly confidence: number }
  | {
      readonly kind: 'needs_confirmation';
      readonly topic: SensitiveTopic;
      readonly confidence: number;
    }
  | {
      readonly kind: 'reject';
      readonly code: CandidateRejectionCode;
      readonly message: string;
    };

export interface CandidateGateInput {
  readonly ownerId: string;
  readonly basis: AssertionBasis;
  readonly sourceType: EvidenceSourceType;
  readonly confidence: number;
  readonly rationale: string;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  readonly subjectText: string;
  readonly objectText: string;
}

/** Which bases an evidence source can honestly support (§8.3, "cannot support its claimed basis"). */
const SUPPORTED_BASES: Record<EvidenceSourceType, readonly AssertionBasis[]> = {
  conversation_message: ['explicit_user_statement', 'assistant_inference'],
  question_answer: ['explicit_question_answer'],
  manual_correction: ['explicit_user_statement'],
  manual_import: ['manual_import'],
  desktop_activity: ['passive_observation', 'derived_aggregation'],
  screenshot: ['passive_observation'],
  accessibility_snapshot: ['passive_observation'],
  ocr_result: ['passive_observation'],
  mobile_event: ['passive_observation'],
};

/**
 * The deterministic §8.3 list. It never asks a model anything and never writes: it decides
 * whether a proposal may become a belief, and at what confidence.
 */
export class CandidateGate {
  constructor(
    private readonly policies: PolicyStore,
    private readonly secrets: SecretScanner,
  ) {}

  evaluate(input: CandidateGateInput): CandidateGateOutcome {
    if (input.rationale.trim().length === 0) {
      return { kind: 'reject', code: 'empty_rationale', message: 'Candidate has no rationale.' };
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      return {
        kind: 'reject', code: 'confidence_out_of_range',
        message: `Confidence must be within [0, 1]: ${input.confidence}`,
      };
    }

    const scan = this.secrets.scan(`${input.subjectText} ${input.objectText}`);
    if (scan.containsSecret) {
      return {
        kind: 'reject', code: 'secret_prohibited',
        message: 'Candidate contains credential material.',
      };
    }

    const supported = SUPPORTED_BASES[input.sourceType];
    if (!supported.includes(input.basis)) {
      return {
        kind: 'reject', code: 'basis_unsupported',
        message: `${input.sourceType} evidence cannot support basis ${input.basis}.`,
      };
    }

    const dates = this.checkDates(input.validFromUtc, input.validToUtc);
    if (dates !== null) {
      return dates;
    }

    for (const topic of scan.topics) {
      if (this.policies.isTopicBlockedFromInference(input.ownerId, topic)) {
        return {
          kind: 'reject', code: 'blocked_topic',
          message: `Topic ${topic} is blocked from inference by policy.`,
        };
      }
    }

    const confidence = Math.min(input.confidence, BASIS_CONFIDENCE_CEILING[input.basis]);
    const firstTopic = scan.topics[0];
    if (firstTopic !== undefined && !isExplicitBasis(input.basis)) {
      return { kind: 'needs_confirmation', topic: firstTopic, confidence };
    }
    return { kind: 'accept', confidence };
  }

  private checkDates(
    validFromUtc: string | null,
    validToUtc: string | null,
  ): CandidateGateOutcome | null {
    const from = validFromUtc === null ? null : Date.parse(validFromUtc);
    const to = validToUtc === null ? null : Date.parse(validToUtc);
    if ((from !== null && Number.isNaN(from)) || (to !== null && Number.isNaN(to))) {
      return {
        kind: 'reject', code: 'dates_malformed',
        message: 'Candidate validity dates are not parseable.',
      };
    }
    if (from !== null && to !== null && to <= from) {
      return {
        kind: 'reject', code: 'dates_inconsistent',
        message: 'Candidate validity window ends at or before it starts.',
      };
    }
    return null;
  }
}