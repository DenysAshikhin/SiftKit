import {
  ActivityEventDtoSchema,
  CaptureSubmissionDtoSchema,
  EnvironmentStateDtoSchema,
  SuppressionAuditDtoSchema,
} from '@siftkit/contracts';
import { sendJson } from '../../http-utils.ts';
import {
  assistantRoute, CAPTURE_BODY_LIMIT, desktopBody, OBSERVATION_BODY_LIMIT,
} from './helpers.ts';

export const environmentEndpoint = assistantRoute(async ({ service, req, res }) => {
  service.ingestEnvironment(await desktopBody(
    service, req, EnvironmentStateDtoSchema, 'environment_state', OBSERVATION_BODY_LIMIT,
  ));
  sendJson(res, 200, { ok: true });
});

export const activityEndpoint = assistantRoute(async ({ service, req, res }) => {
  service.ingestActivity(await desktopBody(
    service, req, ActivityEventDtoSchema, 'activity_event', OBSERVATION_BODY_LIMIT,
  ));
  sendJson(res, 200, { ok: true });
});

export const captureEndpoint = assistantRoute(async ({ service, req, res }) => {
  const outcome = service.ingestCapture(await desktopBody(
    service, req, CaptureSubmissionDtoSchema, 'capture_submission', CAPTURE_BODY_LIMIT,
  ));
  sendJson(res, 200, { ok: true, outcome: outcome.kind });
});

export const suppressionEndpoint = assistantRoute(async ({ service, req, res }) => {
  service.ingestSuppression(await desktopBody(
    service, req, SuppressionAuditDtoSchema, 'suppression_audit', OBSERVATION_BODY_LIMIT,
  ));
  sendJson(res, 200, { ok: true });
});
