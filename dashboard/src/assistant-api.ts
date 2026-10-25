import { z } from 'zod';
import {
  AssistantBackgroundDecisionHistoryResponseSchema,
  AssistantFactoryResetPreviewSchema,
  AssistantRestorePreviewResponseSchema,
  AssistantRestoreResultSchema,
  DesktopStateDtoSchema,
  PendingCapturesResponseSchema,
  type AssistantBackgroundWorkDecisionDto,
  type AssistantFactoryResetPreview,
  type AssistantRestorePreviewResponse,
  type AssistantRestoreResult,
  type DesktopStateDto,
  type PendingCapturesResponse,
} from '@siftkit/contracts';
import { bootstrapAssistantToken } from './api.ts';

export { bootstrapAssistantToken };

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

export function getAssistantDesktopState(token: string): Promise<DesktopStateDto> {
  return request('/assistant/desktop/state', token, DesktopStateDtoSchema);
}

export function getAssistantPendingCaptures(token: string): Promise<PendingCapturesResponse> {
  return request('/assistant/captures/pending', token, PendingCapturesResponseSchema);
}

export function getAssistantBackgroundDecisions(
  token: string,
): Promise<AssistantBackgroundWorkDecisionDto[]> {
  return request(
    '/assistant/background-decisions', token, AssistantBackgroundDecisionHistoryResponseSchema,
  ).then((result) => result.items);
}

const AssistantOkSchema = z.object({ ok: z.literal(true) }).strict();

/**
 * §16 archive transport. Kept out of `request` because these bodies and responses are `zip`
 * bytes: a JSON content type or a JSON parse would corrupt the archive either way.
 */
async function archiveRequest(
  path: string,
  token: string,
  body: Blob | string | undefined,
  contentType: string,
): Promise<Response> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': contentType }),
    },
    ...(body === undefined ? {} : { body }),
  });
  if (!response.ok) {
    throw new Error(`Assistant archive request failed (${response.status}).`);
  }
  return response;
}

export async function exportAssistant(
  token: string,
  includeDecryptedBlobs: boolean,
): Promise<Blob> {
  const response = await archiveRequest(
    '/assistant/export', token, JSON.stringify({ includeDecryptedBlobs }), 'application/json',
  );
  return response.blob();
}

export async function backupAssistant(token: string): Promise<Blob> {
  return (await archiveRequest('/assistant/backup', token, undefined, 'application/json')).blob();
}

export async function previewAssistantRestore(
  token: string,
  file: Blob,
): Promise<AssistantRestorePreviewResponse> {
  const response = await archiveRequest('/assistant/restore-preview', token, file, 'application/zip');
  return AssistantRestorePreviewResponseSchema.parse(await response.json());
}

export function confirmAssistantRestore(
  token: string,
  uploadId: string,
  confirmToken: string,
): Promise<AssistantRestoreResult> {
  return request('/assistant/restore', token, AssistantRestoreResultSchema, {
    method: 'POST', body: JSON.stringify({ uploadId, confirmToken }),
  });
}

export function previewAssistantFactoryReset(token: string): Promise<AssistantFactoryResetPreview> {
  return request('/assistant/factory-reset/preview', token, AssistantFactoryResetPreviewSchema);
}

export function confirmAssistantFactoryReset(token: string, previewToken: string) {
  return request('/assistant/factory-reset', token, AssistantOkSchema, {
    method: 'POST', body: JSON.stringify({ previewToken }),
  });
}
