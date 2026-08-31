import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AssistantConfigPatchRequestSchema,
  AssistantConfirmTokenRequestSchema,
  AssistantExportRequestSchema,
  AssistantRestoreConfirmRequestSchema,
  KeyMaterialDtoSchema,
} from '@siftkit/contracts';
import { readConfig, writeConfig } from '../../config-store.js';
import { readBodyToFile, sendJson } from '../../http-utils.js';
import {
  assistantRoute, body, desktopBody, KEY_MATERIAL_BODY_LIMIT, RESTORE_BODY_LIMIT, sendArchive,
} from './helpers.js';

export const statusEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.status());
}, { requireEnabled: false });

export const configReadEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, { assistant: service.config });
}, { requireEnabled: false });

export const configPatchEndpoint = assistantRoute(async ({ service, ctx, req, res }) => {
  const request = await body(req, AssistantConfigPatchRequestSchema);
  const config = readConfig(ctx.configPath);
  const updated = { ...config, Assistant: request.assistant };
  writeConfig(ctx.configPath, updated);
  service.refreshConfig(request.assistant);
  sendJson(res, 200, { assistant: service.config });
}, { requireEnabled: false });

export const custodyEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.keyCustody.statusDto());
}, { requireEnabled: false });

export const keyExportEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.keyCustody.exportForShell());
}, { requireEnabled: false });

export const keyImportEndpoint = assistantRoute(async ({ service, req, res }) => {
  const material = await desktopBody(
    service, req, KeyMaterialDtoSchema, 'key_material', KEY_MATERIAL_BODY_LIMIT,
  );
  service.keyCustody.importFromShell(material);
  sendJson(res, 200, service.keyCustody.statusDto());
}, { requireEnabled: false });

export const desktopStateEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.desktopState());
}, { requireEnabled: false });

export const capturesPendingEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, { captures: service.listPendingCaptures() });
}, { requireEnabled: false });

export const backgroundDecisionsEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, { items: service.listBackgroundWorkDecisions() });
}, { requireEnabled: false });

export const factoryResetPreviewEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.previewFactoryReset());
}, { requireEnabled: false });

export const factoryResetEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, AssistantConfirmTokenRequestSchema);
  // `factoryReset` serializes itself against drains; do not wrap it again here.
  await service.factoryReset(request.previewToken);
  sendJson(res, 200, { ok: true });
}, { requireEnabled: false });

export const exportEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, AssistantExportRequestSchema);
  await sendArchive(res, await service.exports.export(request));
}, { requireEnabled: false });

export const backupEndpoint = assistantRoute(async ({ service, res }) => {
  await sendArchive(res, await service.backups.createBackup());
}, { requireEnabled: false });

/**
 * A restore upload is a whole backup, so it goes to disk as it arrives and is parsed from there.
 * The staging directory is this route's alone; `preview` copies what it wants to keep.
 */
export const restorePreviewEndpoint = assistantRoute(async ({ service, req, res }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-restore-'));
  try {
    const uploadPath = path.join(directory, 'upload.zip');
    await readBodyToFile(req, uploadPath, { maxBytes: RESTORE_BODY_LIMIT });
    sendJson(res, 200, await service.previewRestore(uploadPath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, { requireEnabled: false });

export const restoreEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, AssistantRestoreConfirmRequestSchema);
  sendJson(res, 200, await service.restore(request.uploadId, request.confirmToken));
}, { requireEnabled: false });
