import type { AssistantGraph } from '../assistant-graph.js';
import type { SecretScanner } from '../domain/secrets.js';
import { hashTextContent } from '../domain/keys.js';
import { AssistantNotFoundError } from '../errors.js';

export interface AssistantQuestionConfigWriter {
  setQuestionSchedule(startLocalTime: string, endLocalTime: string): void;
  setQuestionRateLimits(maxPerDay: number, maxPerWeek: number): void;
}

export interface AnswerQuestionRequest {
  readonly ownerId: string;
  readonly questionId: string;
  readonly answer: string;
}

export type AnswerQuestionOutcome =
  | { readonly kind: 'accepted'; readonly evidenceId: string; readonly jobId: string }
  | { readonly kind: 'duplicate'; readonly evidenceId: string };

const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export class QuestionFeedbackService {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly secrets: SecretScanner,
    private readonly config: AssistantQuestionConfigWriter,
    private answerIngestionPriority: number,
  ) {}

  refreshAnswerIngestionPriority(priority: number): void {
    if (!Number.isInteger(priority)) {
      throw new Error('Question answer ingestion priority must be an integer.');
    }
    this.answerIngestionPriority = priority;
  }

  answer(request: AnswerQuestionRequest): AnswerQuestionOutcome {
    const question = this.requireOwnedQuestion(request.ownerId, request.questionId);
    const answer = request.answer.trim();
    if (answer.length === 0) throw new Error('Question answer cannot be empty.');
    const scan = this.secrets.scan(answer);
    if (scan.containsSecret) throw new Error('Question answer contains secret material.');
    const sourceEventId = `question_answer:${question.id}:${hashTextContent(answer)}`;
    const existing = this.graph.evidence.findBySourceEventId(request.ownerId, sourceEventId);
    if (existing !== null && question.answer_evidence_id === existing.id) {
      return { kind: 'duplicate', evidenceId: existing.id };
    }

    const transaction = this.graph.transactions.begin();
    try {
      const evidence = this.graph.evidence.recordTextEvidence({
        ownerId: request.ownerId,
        deviceId: null,
        parentEvidenceId: null,
        sourceType: 'question_answer',
        sourceEventId,
        sourceRef: question.id,
        capturedAtUtc: this.graph.nowUtc(),
        sourceTimezone: null,
        sensitivity: scan.sensitivityFloor,
        retentionUntilUtc: null,
        metadata: { questionId: question.id, questionType: question.question_type },
        text: answer,
      });
      this.graph.questions.recordFeedback({
        ownerId: request.ownerId,
        questionId: question.id,
        feedbackType: 'answer',
        value: { evidenceId: evidence.id },
      });
      this.graph.questions.answer(question.id, evidence.id);
      const job = this.graph.jobs.enqueue({
        ownerId: request.ownerId,
        jobType: 'question_answer_ingestion',
        payload: { questionId: question.id, evidenceId: evidence.id },
        idempotencyKey: `question_answer_ingestion:${question.id}:${evidence.content_hash}`,
      }, this.answerIngestionPriority);
      if (job === null) throw new Error('Question-answer ingestion job already exists.');
      transaction.commit();
      return { kind: 'accepted', evidenceId: evidence.id, jobId: job.id };
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  skip(ownerId: string, questionId: string): void {
    this.withQuestionFeedback(ownerId, questionId, 'skip', {}, 'dismiss');
  }

  snooze(ownerId: string, questionId: string, eligibleAfterUtc: string): void {
    const question = this.requireOwnedQuestion(ownerId, questionId);
    const eligibleAt = Date.parse(eligibleAfterUtc);
    if (Number.isNaN(eligibleAt) || eligibleAt <= Date.parse(this.graph.nowUtc())) {
      throw new Error('Snooze time must be in the future.');
    }
    if (question.expires_at_utc !== null && eligibleAt >= Date.parse(question.expires_at_utc)) {
      throw new Error('Snooze time must be before question expiry.');
    }
    const transaction = this.graph.transactions.begin();
    try {
      this.graph.questions.recordFeedback({
        ownerId, questionId, feedbackType: 'snooze', value: { eligibleAfterUtc },
      });
      this.graph.questions.snooze(questionId, eligibleAfterUtc);
      transaction.commit();
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  doNotRepeat(ownerId: string, questionId: string): void {
    this.block(ownerId, questionId, 'do_not_repeat');
  }

  blockTopic(ownerId: string, questionId: string): void {
    this.block(ownerId, questionId, 'block_topic');
  }

  changeSchedule(ownerId: string, startLocalTime: string, endLocalTime: string): void {
    if (!LOCAL_TIME_PATTERN.test(startLocalTime) || !LOCAL_TIME_PATTERN.test(endLocalTime)) {
      throw new Error('Question schedule must use HH:mm local times.');
    }
    const transaction = this.graph.transactions.begin();
    try {
      this.config.setQuestionSchedule(startLocalTime, endLocalTime);
      this.graph.questions.recordFeedback({
        ownerId, questionId: null, feedbackType: 'change_schedule',
        value: { startLocalTime, endLocalTime },
      });
      transaction.commit();
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  changeRateLimit(ownerId: string, maxPerDay: number, maxPerWeek: number): void {
    if (!Number.isInteger(maxPerDay) || maxPerDay < 0
      || !Number.isInteger(maxPerWeek) || maxPerWeek < 0) {
      throw new Error('Question rate limits must be non-negative integers.');
    }
    const transaction = this.graph.transactions.begin();
    try {
      this.config.setQuestionRateLimits(maxPerDay, maxPerWeek);
      this.graph.questions.recordFeedback({
        ownerId, questionId: null, feedbackType: 'change_rate_limit',
        value: { maxPerDay, maxPerWeek },
      });
      transaction.commit();
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  private block(
    ownerId: string,
    questionId: string,
    feedbackType: 'do_not_repeat' | 'block_topic',
  ): void {
    const question = this.requireOwnedQuestion(ownerId, questionId);
    const transaction = this.graph.transactions.begin();
    try {
      this.graph.policies.upsertPolicy({
        ownerId,
        policyType: 'never_infer_topic',
        key: question.topic_key,
        value: { reason: feedbackType },
        enabled: true,
        source: 'user',
      });
      this.graph.questions.recordFeedback({
        ownerId, questionId, feedbackType, value: { topicKey: question.topic_key },
      });
      this.graph.questions.block(questionId);
      transaction.commit();
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  private withQuestionFeedback(
    ownerId: string,
    questionId: string,
    feedbackType: 'skip',
    value: Record<string, never>,
    transition: 'dismiss',
  ): void {
    this.requireOwnedQuestion(ownerId, questionId);
    const transaction = this.graph.transactions.begin();
    try {
      this.graph.questions.recordFeedback({ ownerId, questionId, feedbackType, value });
      if (transition === 'dismiss') this.graph.questions.dismiss(questionId);
      transaction.commit();
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  private requireOwnedQuestion(ownerId: string, questionId: string) {
    const question = this.graph.questions.requireQuestion(questionId);
    if (question.owner_id !== ownerId) throw new AssistantNotFoundError(`Unknown question for owner: ${questionId}`);
    return question;
  }
}
