import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUESTION_FEEDBACK_TYPES,
  QUESTION_STATUSES,
  QUESTION_TYPES,
  QuestionFeedbackTypeSchema,
  QuestionStatusSchema,
  QuestionTypeSchema,
} from '../src/assistant/domain/enums.js';
import {
  AssertionRowSchema,
  QuestionFeedbackRowSchema,
  QuestionRowSchema,
  RetrievalUsageRowSchema,
} from '../src/assistant/storage/rows.js';

test('Gate C question enums accept every persisted value and reject unknown values', () => {
  for (const value of QUESTION_TYPES) assert.equal(QuestionTypeSchema.parse(value), value);
  for (const value of QUESTION_STATUSES) assert.equal(QuestionStatusSchema.parse(value), value);
  for (const value of QUESTION_FEEDBACK_TYPES) {
    assert.equal(QuestionFeedbackTypeSchema.parse(value), value);
  }
  assert.equal(QuestionTypeSchema.safeParse('unknown').success, false);
  assert.equal(QuestionStatusSchema.safeParse('unknown').success, false);
  assert.equal(QuestionFeedbackTypeSchema.safeParse('unknown').success, false);
});

test('Gate C row schemas parse SQLite question, feedback, and retrieval rows', () => {
  const question = QuestionRowSchema.parse({
    id: 'question_1', owner_id: 'own_local', topic_key: 'project:siftkit',
    question_text: 'Is SiftKit still active?', question_type: 'confirm_inference',
    candidate_ids_json: '["candidate_1"]', expected_value: 0.8, interruption_cost: 0.2,
    status: 'planned', eligible_after_utc: null, expires_at_utc: null, shown_at_utc: null,
    answered_at_utc: null, answer_evidence_id: null,
    created_at_utc: '2026-08-10T00:00:00.000Z', updated_at_utc: '2026-08-10T00:00:00.000Z',
  });
  assert.equal(question.question_type, 'confirm_inference');

  const feedback = QuestionFeedbackRowSchema.parse({
    id: 'feedback_1', owner_id: 'own_local', question_id: 'question_1',
    feedback_type: 'snooze', value_json: '{"untilUtc":"2026-08-11T00:00:00.000Z"}',
    created_at_utc: '2026-08-10T00:00:00.000Z',
  });
  assert.equal(feedback.feedback_type, 'snooze');

  const usage = RetrievalUsageRowSchema.parse({
    id: 'usage_1', owner_id: 'own_local', conversation_id: 'chat_1', query_hash: 'abc',
    assertion_ids_json: '["ast_1"]', projection_ids_json: '["memproj_1"]',
    rendered_token_count: 42, usefulness_feedback: null,
    created_at_utc: '2026-08-10T00:00:00.000Z',
  });
  assert.equal(usage.rendered_token_count, 42);
  assert.equal(RetrievalUsageRowSchema.safeParse({ ...usage, rendered_token_count: -1 }).success, false);
});

test('assertion rows parse the durable user-demoted flag', () => {
  const assertion = AssertionRowSchema.parse({
    id: 'ast_1', owner_id: 'own_local', assertion_key: 'key', subject_node_id: 'node_1',
    predicate: 'PREFERS', object_kind: 'literal', object_node_id: null,
    object_value_type: 'string', object_value_json: '"TypeScript"',
    object_normalized_text: 'typescript', scope_node_id: null, status: 'active',
    basis: 'explicit_user_statement', confidence: 0.98, sensitivity: 'personal',
    valid_from_utc: null, valid_to_utc: null,
    first_observed_at_utc: '2026-08-10T00:00:00.000Z',
    last_observed_at_utc: '2026-08-10T00:00:00.000Z',
    recorded_at_utc: '2026-08-10T00:00:00.000Z', retired_at_utc: null,
    supersedes_assertion_id: null, pinned: 0, user_demoted: 1, attributes_json: '{}',
    created_at_utc: '2026-08-10T00:00:00.000Z', updated_at_utc: '2026-08-10T00:00:00.000Z',
    fts_rowid: null,
  });
  assert.equal(assertion.user_demoted, true);
});
