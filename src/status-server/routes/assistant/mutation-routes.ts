import {
  AssistantConfirmTokenRequestSchema,
  AssistantDestructiveRequestSchema,
  AssistantMutationRequestSchema,
  AssistantTopicForgetRequestSchema,
} from '@siftkit/contracts';
import { z } from '../../../lib/zod.js';
import { sendJson } from '../../http-utils.js';
import {
  assistantRoute, body, CorrectionSchema, id, PinSchema, success,
} from './helpers.js';

export const confirmEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, AssistantMutationRequestSchema);
  service.memoryMutations.confirm({ ownerId: service.ownerId,
    assertionId: id(match), reason: request.reason });
  sendJson(res, 200, success(service));
});

export const correctEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, CorrectionSchema);
  service.memoryMutations.correct({
    ownerId: service.ownerId, assertionId: id(match), reason: request.reason,
    object: request.object, objectText: request.objectText,
  });
  sendJson(res, 200, success(service));
});

export const pinEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, PinSchema);
  service.memoryMutations.setPinned({
    ownerId: service.ownerId, assertionId: id(match), reason: request.reason,
    pinned: request.pinned,
  });
  sendJson(res, 200, success(service));
});

export const demoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, AssistantMutationRequestSchema);
  service.memoryMutations.demote({
    ownerId: service.ownerId, assertionId: id(match), reason: request.reason,
  });
  sendJson(res, 200, success(service));
});

export const deleteAssertionEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, AssistantDestructiveRequestSchema);
  const assertionId = id(match);
  if (request.mode === 'preview') {
    sendJson(res, 200, service.memoryMutations.previewForgetAssertion(
      service.ownerId, assertionId,
    ));
  } else {
    service.memoryMutations.confirmForgetAssertion(
      service.ownerId, assertionId, request.previewToken,
    );
    sendJson(res, 200, success(service));
  }
});

export const evidenceDeletionPreviewEndpoint = assistantRoute(({ service, res, match }) => {
  sendJson(res, 200, service.memoryMutations.previewDeleteEvidence(service.ownerId, id(match)));
});

export const deleteEvidenceEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, AssistantConfirmTokenRequestSchema);
  service.memoryMutations.confirmDeleteEvidence(
    service.ownerId, id(match), request.previewToken,
  );
  sendJson(res, 200, success(service));
});

export const topicForgetPreviewEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, z.object({ topicKey: z.string().trim().min(1) }).strict());
  sendJson(
    res, 200, service.memoryMutations.previewForgetTopic(service.ownerId, request.topicKey),
  );
});

export const topicForgetEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, AssistantTopicForgetRequestSchema);
  service.memoryMutations.confirmForgetTopic(service.ownerId, request);
  sendJson(res, 200, success(service));
});

export const rebuildProjectionsEndpoint = assistantRoute(async ({ service, res }) => {
  await service.memoryMutations.rebuildProjections(
    service.ownerId, new AbortController().signal,
  );
  sendJson(res, 200, success(service));
});
