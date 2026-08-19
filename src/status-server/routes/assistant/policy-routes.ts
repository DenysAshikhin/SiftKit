import { AssistantValidationNotesRequestSchema } from '@siftkit/contracts';
import { sendJson } from '../../http-utils.js';
import {
  assistantRoute, BlockPolicyTopicSchema, body, id, PolicyPatchSchema, sendError, success,
} from './helpers.js';

export const listPoliciesEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, { items: service.listPolicies() });
});

export const blockPolicyTopicEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, BlockPolicyTopicSchema);
  service.blockPolicyTopic(request.topic);
  sendJson(res, 200, success(service));
});

export const patchPolicyEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const policyId = id(match);
  const found = service.setPolicyEnabled(policyId, (await body(req, PolicyPatchSchema)).enabled);
  if (!found) sendError(res, 404, 'not_found', 'Policy was not found.');
  else sendJson(res, 200, success(service));
});

export const deletePolicyEndpoint = assistantRoute(({ service, res, match }) => {
  const found = service.deletePolicy(id(match));
  if (!found) sendError(res, 404, 'not_found', 'Policy was not found.');
  else sendJson(res, 200, success(service));
});

export const listValidationEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, { items: service.listValidationQueue() });
});

export const validationNotesEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, AssistantValidationNotesRequestSchema);
  if (!service.setValidationNotes(id(match), request.notes)) {
    sendError(res, 404, 'not_found', 'Validation candidate was not found.');
  } else sendJson(res, 200, success(service));
});

export const deleteValidationEndpoint = assistantRoute(({ service, res, match }) => {
  if (!service.removeValidationCandidate(id(match))) {
    sendError(res, 404, 'not_found', 'Validation candidate was not found.');
  } else sendJson(res, 200, success(service));
});
