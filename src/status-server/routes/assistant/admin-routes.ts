import {
  AssistantConfigPatchRequestSchema,
  AssistantConfirmTokenRequestSchema,
  AssistantExportRequestSchema,
  AssistantRestoreConfirmRequestSchema,
  KeyMaterialDtoSchema,
} from '@siftkit/contracts';
import { readConfig, writeConfig } from '../../config-store.js';
import { readBodyBytes, sendJson } from '../../http-utils.js';
import {
  assistantRoute, body, desktopBody, KEY_MATERIAL_BODY_LIMIT, RESTORE_BODY_LIMIT, sendZip,
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
  sendZip(res, await service.exports.export(request));
}, { requireEnabled: false });

export const backupEndpoint = assistantRoute(async ({ service, res }) => {
  sendZip(res, await service.backups.createBackup());
}, { requireEnabled: false });

export const restorePreviewEndpoint = assistantRoute(async ({ service, req, res }) => {
  sendJson(res, 200, service.previewRestore(
    await readBodyBytes(req, { maxBytes: RESTORE_BODY_LIMIT }),
  ));
}, { requireEnabled: false });

export const restoreEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, AssistantRestoreConfirmRequestSchema);
  sendJson(res, 200, await service.restore(request.uploadId, request.confirmToken));
}, { requireEnabled: false });
