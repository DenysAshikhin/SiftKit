import {
  ActivityEventDtoSchema,
  CaptureSubmissionDtoSchema,
  EnvironmentStateDtoSchema,
  MobileEnvelopeSchema,
  SuppressionAuditDtoSchema,
} from '@siftkit/contracts';
import { sendJson } from '../../http-utils.js';
import {
  assistantRoute, body, CAPTURE_BODY_LIMIT, desktopBody, OBSERVATION_BODY_LIMIT, sendError,
} from './helpers.js';

export const mobileEndpoint = assistantRoute(async ({ service, req, res }) => {
  // §7.6: while the flag is off the mobile route is indistinguishable from absent, which is
  // why this is decided before the enabled gate can answer with a reason.
  if (!service.config.Mobile.Enabled) {
    sendError(res, 404, 'not_found', 'Not found.');
    return;
  }
  if (!service.enabled) {
    sendError(res, 409, 'assistant_disabled', 'Assistant is disabled.');
    return;
  }
  const envelope = await body(req, MobileEnvelopeSchema);
  const verdict = service.ingestMobileEnvelope(envelope);
  if (verdict.kind === 'rejected') {
    sendError(res, 403, 'envelope_rejected', `Envelope rejected: ${verdict.reason}.`);
  } else {
    sendJson(res, 202, { ok: true });
  }
}, { requireEnabled: false });

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
