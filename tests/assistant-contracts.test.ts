import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AssistantAssertionDtoSchema,
  AssistantAssertionExplanationSchema,
  AssistantConfigPatchRequestSchema,
  AssistantDestructiveRequestSchema,
  AssistantErrorResponseSchema,
  AssistantGraphCleanupPreviewSchema,
  AssistantGraphCleanupRequestSchema,
  AssistantGraphCleanupResultSchema,
  AssistantEvidenceDtoSchema,
  AssistantMutationRequestSchema,
  AssistantMutationResponseSchema,
  AssistantClaimOwnerResponseSchema,
  AssistantNodeDetailSchema,
  AssistantNodeSummarySchema,
  AssistantPolicyDtoSchema,
  AssistantProjectionDtoSchema,
  AssistantQuestionDtoSchema,
  AssistantStatusResponseSchema,
  AssistantResolveIdentityRequestSchema,
  AssistantResolveIdentityResponseSchema,
  AssistantValidationCandidateDtoSchema,
  AssistantValidationNotesRequestSchema,
  PENDING_CAPTURE_LIST_STATES,
  PENDING_CAPTURE_STATES,
} from '@siftkit/contracts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';

test('assistant public contracts round-trip representative valid DTOs', () => {
  const examples = [
    [AssistantStatusResponseSchema, {
      available: true, enabled: false, ownerId: 'own_local', pendingQuestionCount: 0,
      pendingValidationCount: 1,
    }],
    [AssistantConfigPatchRequestSchema, { assistant: DEFAULT_ASSISTANT_CONFIG }],
    [AssistantNodeSummarySchema, { id: 'node_1', type: 'person', displayName: 'User', sensitivity: 'personal' }],
    [AssistantNodeDetailSchema, {
      id: 'node_1', type: 'person', displayName: 'User', sensitivity: 'personal',
      canonicalKey: 'person:owner', description: null, properties: {}, aliases: ['the user'],
      isOwner: true, status: 'active',
    }],
    [AssistantAssertionDtoSchema, {
      id: 'ast_1', subjectNodeId: 'node_1', predicate: 'PREFERS', objectText: 'PowerShell',
      scopeText: '', status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', pinned: false, userDemoted: false, validFromUtc: null,
      validToUtc: null, lastObservedAtUtc: '2026-08-10T00:00:00.000Z',
    }],
    [AssistantAssertionExplanationSchema, {
      assertion: {
        id: 'ast_1', subjectNodeId: 'node_1', predicate: 'PREFERS', objectText: 'PowerShell',
        scopeText: '', status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
        sensitivity: 'personal', pinned: false, userDemoted: false, validFromUtc: null,
        validToUtc: null, lastObservedAtUtc: '2026-08-10T00:00:00.000Z',
      },
      evidenceIds: ['ev_1'], mutationIds: ['mut_1'],
    }],
    [AssistantEvidenceDtoSchema, {
      id: 'ev_1', sourceType: 'conversation_message', sourceRef: 'chat_1',
      capturedAtUtc: '2026-08-10T00:00:00.000Z', sensitivity: 'personal', status: 'active',
      metadata: {}, contentAvailable: true, contentRevealed: false,
    }],
    [AssistantProjectionDtoSchema, {
      id: 'memproj_1', tier: 1, topicKey: 'profile', title: 'Profile', tokenCount: 10,
      sensitivity: 'personal', graphVersion: 2, content: '# Profile',
    }],
    [AssistantQuestionDtoSchema, {
      id: 'question_1', topicKey: 'tooling', questionText: 'Confirm?',
      questionType: 'confirm_inference', status: 'eligible', eligibleAfterUtc: null,
      expiresAtUtc: null, createdAtUtc: '2026-08-10T00:00:00.000Z',
    }],
    [AssistantPolicyDtoSchema, {
      id: 'pol_1', policyType: 'blocked_question_topic', topicKey: 'health', active: true,
    }],
    [AssistantValidationCandidateDtoSchema, {
      id: 'cand_1', status: 'needs_confirmation', proposedStatement: 'Uses PowerShell',
      rationale: 'Observed directly', confidence: 0.8, sensitivity: 'personal',
      evidenceId: 'ev_1', userNotes: '', createdAtUtc: '2026-08-10T00:00:00.000Z',
      hold: { kind: 'possible_owner_alias', name: 'denyz' },
    }],
    [AssistantResolveIdentityRequestSchema, { isOwner: true }],
    [AssistantResolveIdentityResponseSchema, { ok: true, graphVersion: 3, outcome: 'rejected' }],
    [AssistantClaimOwnerResponseSchema, {
      ok: true, graphVersion: 4, mergeId: 'merge_1', ownerNodeId: 'node_1',
      movedAssertionCount: 3, retiredAssertionCount: 2, movedAliases: ['demyus'],
    }],
    [AssistantValidationNotesRequestSchema, { notes: 'Check version.' }],
    [AssistantDestructiveRequestSchema, { mode: 'confirm', previewToken: 'signed' }],
    [AssistantMutationRequestSchema, { reason: 'User correction' }],
    [AssistantMutationResponseSchema, { ok: true, graphVersion: 3 }],
    [AssistantGraphCleanupPreviewSchema, {
      previewToken: 'signed', graphVersion: 4, orphanNodeIds: ['node_9'],
      resumableCaptureIds: [], discardableCaptureIds: ['ev_2'],
      reclassifiableEvidenceCount: 3, reclassifiableAssertionCount: 1,
    }],
    [AssistantGraphCleanupRequestSchema, { previewToken: 'signed', reclassifyScreenshots: true }],
    [AssistantGraphCleanupResultSchema, {
      ok: true, graphVersion: 5, nodesDeleted: 1, capturesRequeued: 0, capturesDiscarded: 1,
      evidenceReclassified: 3, assertionsReclassified: 1,
    }],
    [AssistantErrorResponseSchema, { error: { code: 'not_found', message: 'Missing' } }],
  ] as const;
  for (const [schema, value] of examples) {
    assert.deepEqual(schema.parse(value), value);
  }
});

test('assistant public contracts reject malformed and unknown fields', () => {
  assert.equal(AssistantStatusResponseSchema.safeParse({ available: true }).success, false);
  assert.equal(AssistantConfigPatchRequestSchema.safeParse({
    assistant: DEFAULT_ASSISTANT_CONFIG,
    unknown: true,
  }).success, false);
  assert.equal(AssistantDestructiveRequestSchema.safeParse({ mode: 'confirm' }).success, false);
  assert.equal(AssistantEvidenceDtoSchema.safeParse({
    id: 'ev_1', decryptedContent: 'must never be present by default',
  }).success, false);
  assert.equal(AssistantValidationNotesRequestSchema.safeParse({ notes: 4 }).success, false);
});

test('node detail rejects a status the graph cannot hold', () => {
  const parsed = AssistantNodeDetailSchema.safeParse({
    id: 'node_1', type: 'person', displayName: 'User', sensitivity: 'personal',
    canonicalKey: null, description: null, properties: {}, aliases: [],
    isOwner: false, status: 'bogus',
  });
  assert.equal(parsed.success, false);
});

test('the pending view lists exactly the drain states plus the in-flight one', () => {
  assert.deepEqual([...PENDING_CAPTURE_LIST_STATES], [...PENDING_CAPTURE_STATES, 'processing']);
});
