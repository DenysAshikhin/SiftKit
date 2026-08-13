import { z } from 'zod';
import {
  AssistantAssertionDtoSchema,
  AssistantAssertionExplanationSchema,
  AssistantDeletionPreviewSchema,
  AssistantEvidenceDeletionPreviewSchema,
  AssistantEvidenceDtoSchema,
  AssistantMutationResponseSchema,
  AssistantNodeDetailSchema,
  AssistantNodeSummarySchema,
  AssistantPolicyDtoSchema,
  AssistantProjectionDtoSchema,
  AssistantQuestionDtoSchema,
  AssistantStatusResponseSchema,
  AssistantTopicForgetPreviewSchema,
  DesktopStateDtoSchema,
  type AssistantAssertionExplanation,
  type AssistantDeletionPreview,
  type AssistantEvidenceDeletionPreview,
  type AssistantEvidenceDto,
  type AssistantMutationResponse,
  type AssistantNodeDetail,
  type AssistantPolicyDto,
  type AssistantQuestionDto,
  type AssistantStatusResponse,
  type AssistantTopicForgetPreview,
  type AssistantTopicForgetRequest,
  type DesktopStateDto,
} from '@siftkit/contracts';
import {
  bootstrapAssistantToken,
  getAssistantMemoryHistory,
  getAssistantValidation,
  removeAssistantValidationCandidate,
  saveAssistantValidationNotes,
} from './api.js';

export {
  bootstrapAssistantToken,
  getAssistantMemoryHistory,
  getAssistantValidation,
  removeAssistantValidationCandidate,
  saveAssistantValidationNotes,
};

const SearchResponseSchema = z.object({
  nodes: z.array(AssistantNodeSummarySchema),
  assertions: z.array(AssistantAssertionDtoSchema),
  projections: z.array(AssistantProjectionDtoSchema),
}).strict();
const CurrentQuestionResponseSchema = z.object({ question: AssistantQuestionDtoSchema.nullable() }).strict();
const PolicyListResponseSchema = z.object({ items: z.array(AssistantPolicyDtoSchema) }).strict();
const NeighborhoodSchema = z.object({
  rootNodeId: z.string(),
  nodeIds: z.array(z.string()),
  assertionIds: z.array(z.string()),
  truncatedBy: z.array(z.enum(['max_hops', 'max_nodes', 'max_assertions', 'max_fanout'])),
}).strict();
const QuestionAnswerResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), evidenceId: z.string(), jobId: z.string() }).strict(),
  z.object({ kind: z.literal('duplicate'), evidenceId: z.string() }).strict(),
]);

export type AssistantSearchResult = z.infer<typeof SearchResponseSchema>;
export type AssistantNeighborhood = z.infer<typeof NeighborhoodSchema>;
export type AssistantQuestionAnswerResult = z.infer<typeof QuestionAnswerResponseSchema>;

async function request<S extends z.ZodTypeAny>(
  path: string,
  token: string,
  schema: S,
  init?: RequestInit,
): Promise<z.infer<S>> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });
  if (!response.ok) {
    let message = `Assistant request failed (${response.status}).`;
    try {
      const parsed = z.object({ error: z.object({ message: z.string() }) }).parse(await response.json());
      message = parsed.error.message;
    } catch {
      // Keep the status-only error; never reflect response bodies or credentials into the UI.
    }
    throw new Error(message);
  }
  return schema.parse(await response.json());
}

export function getAssistantStatus(token: string): Promise<AssistantStatusResponse> {
  return request('/assistant/status', token, AssistantStatusResponseSchema);
}

export function getAssistantDesktopState(token: string): Promise<DesktopStateDto> {
  return request('/assistant/desktop/state', token, DesktopStateDtoSchema);
}

/** Decrypted evidence bytes for a per-item reveal. Held in memory only; never cached. */
export async function fetchAssistantEvidencePixels(token: string, id: string): Promise<Blob> {
  const response = await fetch(`/assistant/evidence/blob?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Evidence pixels are unavailable (${response.status}).`);
  }
  return response.blob();
}

export function searchAssistantMemory(token: string, query: string): Promise<AssistantSearchResult> {
  const params = new URLSearchParams({ q: query, limit: '50' });
  return request(`/assistant/search?${params.toString()}`, token, SearchResponseSchema);
}

export function getAssistantNode(token: string, id: string): Promise<AssistantNodeDetail> {
  return request(`/assistant/graph/nodes/${encodeURIComponent(id)}`, token, AssistantNodeDetailSchema);
}

export function getAssistantNeighborhood(
  token: string,
  id: string,
  maxHops = 2,
): Promise<AssistantNeighborhood> {
  return request(
    `/assistant/graph/nodes/${encodeURIComponent(id)}/neighborhood?maxHops=${maxHops}`,
    token,
    NeighborhoodSchema,
  );
}

export function explainAssistantAssertion(
  token: string,
  id: string,
): Promise<AssistantAssertionExplanation> {
  return request(
    `/assistant/graph/assertions/${encodeURIComponent(id)}/explanation`,
    token,
    AssistantAssertionExplanationSchema,
  );
}

export function getAssistantEvidence(token: string, id: string): Promise<AssistantEvidenceDto> {
  return request(`/assistant/evidence/${encodeURIComponent(id)}`, token, AssistantEvidenceDtoSchema);
}

export function getCurrentAssistantQuestion(token: string): Promise<AssistantQuestionDto | null> {
  return request('/assistant/questions/current', token, CurrentQuestionResponseSchema)
    .then((result) => result.question);
}

export function getAssistantPolicies(token: string): Promise<AssistantPolicyDto[]> {
  return request('/assistant/policies', token, PolicyListResponseSchema).then((result) => result.items);
}

function mutate(
  token: string,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: object,
): Promise<AssistantMutationResponse> {
  return request(path, token, AssistantMutationResponseSchema, {
    method,
    body: JSON.stringify(body),
  });
}

export function confirmAssistantAssertion(token: string, id: string, reason: string) {
  return mutate(token, `/assistant/graph/assertions/${encodeURIComponent(id)}/confirm`, 'POST', { reason });
}

export function correctAssistantAssertion(token: string, id: string, objectText: string, reason: string) {
  return mutate(token, `/assistant/graph/assertions/${encodeURIComponent(id)}/correct`, 'POST', {
    reason,
    object: { kind: 'literal', valueType: 'string', value: objectText },
    objectText,
  });
}

export function pinAssistantAssertion(token: string, id: string, pinned: boolean, reason: string) {
  return mutate(token, `/assistant/graph/assertions/${encodeURIComponent(id)}/pin`, 'POST', { pinned, reason });
}

export function demoteAssistantAssertion(token: string, id: string, reason: string) {
  return mutate(token, `/assistant/graph/assertions/${encodeURIComponent(id)}/demote`, 'POST', { reason });
}

export function previewForgetAssistantAssertion(token: string, id: string): Promise<AssistantDeletionPreview> {
  return request(
    `/assistant/graph/assertions/${encodeURIComponent(id)}`,
    token,
    AssistantDeletionPreviewSchema,
    { method: 'DELETE', body: JSON.stringify({ mode: 'preview' }) },
  );
}

export function confirmForgetAssistantAssertion(
  token: string,
  id: string,
  previewToken: string,
) {
  return mutate(token, `/assistant/graph/assertions/${encodeURIComponent(id)}`, 'DELETE', {
    mode: 'confirm', previewToken,
  });
}

export function previewDeleteAssistantEvidence(
  token: string,
  id: string,
): Promise<AssistantEvidenceDeletionPreview> {
  return request(
    `/assistant/evidence/${encodeURIComponent(id)}/deletion-preview`,
    token,
    AssistantEvidenceDeletionPreviewSchema,
  );
}

export function confirmDeleteAssistantEvidence(token: string, id: string, previewToken: string) {
  return mutate(token, `/assistant/evidence/${encodeURIComponent(id)}`, 'DELETE', { previewToken });
}

export function previewForgetAssistantTopic(
  token: string,
  topicKey: string,
): Promise<AssistantTopicForgetPreview> {
  return request('/assistant/topics/forget-preview', token, AssistantTopicForgetPreviewSchema, {
    method: 'POST', body: JSON.stringify({ topicKey }),
  });
}

export function confirmForgetAssistantTopic(
  token: string,
  forgetRequest: AssistantTopicForgetRequest,
) {
  return mutate(token, '/assistant/topics/forget', 'POST', forgetRequest);
}

export function answerAssistantQuestion(token: string, id: string, answer: string) {
  return request(
    `/assistant/questions/${encodeURIComponent(id)}/answer`,
    token,
    QuestionAnswerResponseSchema,
    { method: 'POST', body: JSON.stringify({ answer }) },
  );
}

export function skipAssistantQuestion(token: string, id: string) {
  return mutate(token, `/assistant/questions/${encodeURIComponent(id)}/skip`, 'POST', {});
}

export function snoozeAssistantQuestion(token: string, id: string, eligibleAfterUtc: string) {
  return mutate(token, `/assistant/questions/${encodeURIComponent(id)}/snooze`, 'POST', { eligibleAfterUtc });
}

export function blockAssistantQuestionTopic(token: string, id: string) {
  return mutate(token, `/assistant/questions/${encodeURIComponent(id)}/block-topic`, 'POST', {});
}

export function setAssistantPolicyEnabled(token: string, id: string, enabled: boolean) {
  return mutate(token, `/assistant/policies/${encodeURIComponent(id)}`, 'PATCH', { enabled });
}

export function deleteAssistantPolicy(token: string, id: string) {
  return mutate(token, `/assistant/policies/${encodeURIComponent(id)}`, 'DELETE', {});
}
