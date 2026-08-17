import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import { JsonObjectSchema, type JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { QuestionFeedbackType, QuestionStatus, QuestionType } from '../domain/enums.js';
import { AssistantConflictError, AssistantNotFoundError } from '../errors.js';
import type { IdGenerator } from '../ids.js';
import {
  QuestionFeedbackRowSchema,
  QuestionRowSchema,
  type QuestionFeedbackRow,
  type QuestionRow,
} from './rows.js';

const CandidateIdListSchema = z.array(z.string());
const LIVE_QUESTION_STATUSES = ['planned', 'eligible', 'shown', 'snoozed'] as const;

export interface CreateQuestionInput {
  readonly ownerId: string;
  readonly topicKey: string;
  readonly questionText: string;
  readonly questionType: QuestionType;
  readonly candidateIds: readonly string[];
  readonly expectedValue: number;
  readonly interruptionCost: number;
  readonly eligibleAfterUtc: string | null;
  readonly expiresAtUtc: string | null;
}

export interface RecordQuestionFeedbackInput {
  readonly ownerId: string;
  readonly questionId: string | null;
  readonly feedbackType: QuestionFeedbackType;
  readonly value: JsonObject;
}

export class QuestionStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  create(input: CreateQuestionInput): QuestionRow {
    if (this.findLiveByTopic(input.ownerId, input.topicKey) !== null) {
      throw new Error(`A live question already exists for topic: ${input.topicKey}`);
    }
    const id = this.ids.next('question');
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO assistant_questions (
        id, owner_id, topic_key, question_text, question_type, candidate_ids_json,
        expected_value, interruption_cost, status, eligible_after_utc, expires_at_utc,
        shown_at_utc, answered_at_utc, answer_evidence_id, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      id, input.ownerId, input.topicKey, input.questionText, input.questionType,
      JSON.stringify([...input.candidateIds]), input.expectedValue, input.interruptionCost,
      input.eligibleAfterUtc, input.expiresAtUtc, nowUtc, nowUtc,
    );
    return this.requireQuestion(id);
  }

  getQuestion(questionId: string): QuestionRow | null {
    const row = this.database.prepare('SELECT * FROM assistant_questions WHERE id = ?').get(questionId);
    return row === undefined || row === null ? null : QuestionRowSchema.parse(row);
  }

  requireQuestion(questionId: string): QuestionRow {
    const row = this.getQuestion(questionId);
    if (row === null) throw new AssistantNotFoundError(`Unknown assistant question: ${questionId}`);
    return row;
  }

  readCandidateIds(row: QuestionRow): string[] {
    return parseJsonText(row.candidate_ids_json, CandidateIdListSchema);
  }

  findLiveByTopic(ownerId: string, topicKey: string): QuestionRow | null {
    const row = this.database.prepare(`
      SELECT * FROM assistant_questions
      WHERE owner_id = ? AND topic_key = ? AND status IN ('planned', 'eligible', 'shown', 'snoozed')
      LIMIT 1
    `).get(ownerId, topicKey);
    return row === undefined || row === null ? null : QuestionRowSchema.parse(row);
  }

  listPending(ownerId: string): QuestionRow[] {
    return z.array(QuestionRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_questions
      WHERE owner_id = ? AND status IN ('planned', 'eligible', 'shown', 'snoozed')
      ORDER BY expected_value DESC, created_at_utc ASC, id ASC
    `).all(ownerId));
  }

  countPending(ownerId: string): number {
    return z.object({ count: z.number() }).parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM assistant_questions
      WHERE owner_id = ? AND status IN ('planned', 'eligible', 'shown', 'snoozed')
    `).get(ownerId)).count;
  }

  listAll(ownerId: string): QuestionRow[] {
    return z.array(QuestionRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_questions
      WHERE owner_id = ? ORDER BY created_at_utc ASC, id ASC
    `).all(ownerId));
  }

  markEligible(questionId: string, eligibleAfterUtc: string): QuestionRow {
    return this.transition(questionId, ['planned', 'snoozed'], 'eligible', {
      eligibleAfterUtc, shownAtUtc: null, answeredAtUtc: null, answerEvidenceId: null,
    });
  }

  markShown(questionId: string): QuestionRow {
    return this.transition(questionId, ['eligible'], 'shown', {
      eligibleAfterUtc: null, shownAtUtc: this.clock.nowUtc(),
      answeredAtUtc: null, answerEvidenceId: null,
    });
  }

  answer(questionId: string, evidenceId: string): QuestionRow {
    return this.transition(questionId, LIVE_QUESTION_STATUSES, 'answered', {
      eligibleAfterUtc: null, shownAtUtc: undefined,
      answeredAtUtc: this.clock.nowUtc(), answerEvidenceId: evidenceId,
    });
  }

  dismiss(questionId: string): QuestionRow {
    return this.transition(questionId, LIVE_QUESTION_STATUSES, 'dismissed', {
      eligibleAfterUtc: null, shownAtUtc: undefined, answeredAtUtc: null, answerEvidenceId: null,
    });
  }

  snooze(questionId: string, eligibleAfterUtc: string): QuestionRow {
    return this.transition(questionId, ['planned', 'eligible', 'shown'], 'snoozed', {
      eligibleAfterUtc, shownAtUtc: undefined, answeredAtUtc: null, answerEvidenceId: null,
    });
  }

  block(questionId: string): QuestionRow {
    return this.transition(questionId, LIVE_QUESTION_STATUSES, 'blocked', {
      eligibleAfterUtc: null, shownAtUtc: undefined, answeredAtUtc: null, answerEvidenceId: null,
    });
  }

  expireDue(ownerId: string): number {
    const result = this.database.prepare(`
      UPDATE assistant_questions
      SET status = 'expired', updated_at_utc = ?
      WHERE owner_id = ? AND status IN ('planned', 'eligible', 'shown', 'snoozed')
        AND expires_at_utc IS NOT NULL AND expires_at_utc <= ?
    `).run(this.clock.nowUtc(), ownerId, this.clock.nowUtc());
    return result.changes;
  }

  recordFeedback(input: RecordQuestionFeedbackInput): QuestionFeedbackRow {
    const id = this.ids.next('question_feedback');
    this.database.prepare(`
      INSERT INTO assistant_question_feedback (
        id, owner_id, question_id, feedback_type, value_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id, input.ownerId, input.questionId, input.feedbackType,
      JSON.stringify(input.value), this.clock.nowUtc(),
    );
    return QuestionFeedbackRowSchema.parse(this.database.prepare(
      'SELECT * FROM assistant_question_feedback WHERE id = ?',
    ).get(id));
  }

  readFeedbackValue(row: QuestionFeedbackRow): JsonObject {
    return parseJsonText(row.value_json, JsonObjectSchema);
  }

  listFeedback(ownerId: string, questionId: string): QuestionFeedbackRow[] {
    return z.array(QuestionFeedbackRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_question_feedback
      WHERE owner_id = ? AND question_id = ?
      ORDER BY created_at_utc ASC, id ASC
    `).all(ownerId, questionId));
  }

  private transition(
    questionId: string,
    allowed: readonly QuestionStatus[],
    next: QuestionStatus,
    values: {
      readonly eligibleAfterUtc: string | null;
      readonly shownAtUtc: string | null | undefined;
      readonly answeredAtUtc: string | null;
      readonly answerEvidenceId: string | null;
    },
  ): QuestionRow {
    const current = this.requireQuestion(questionId);
    if (!allowed.some((status) => status === current.status)) {
      throw new AssistantConflictError(`Cannot transition assistant question from ${current.status} to ${next}.`);
    }
    this.database.prepare(`
      UPDATE assistant_questions
      SET status = ?, eligible_after_utc = ?, shown_at_utc = ?, answered_at_utc = ?,
          answer_evidence_id = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(
      next,
      values.eligibleAfterUtc,
      values.shownAtUtc === undefined ? current.shown_at_utc : values.shownAtUtc,
      values.answeredAtUtc,
      values.answerEvidenceId,
      this.clock.nowUtc(),
      questionId,
    );
    return this.requireQuestion(questionId);
  }
}
