import type { IncomingMessage, ServerResponse } from 'node:http';
import { InferenceClient } from '../../llm-protocol/inference-client.ts';
import { resolveImageTokenBudget } from '../../llm-protocol/image-token-budget.ts';
import { JsonRecordReader } from '../../lib/json-record-reader.ts';
import { parseJsonValueText } from '../../lib/json.ts';
import {
  JsonValueSchema,
  type JsonValue,
  type OptionalJsonValue,
} from '../../lib/json-types.ts';
import { toError } from '../../lib/errors.ts';
import { getRuntimeRoot } from '../paths.ts';
import {
  readBody,
  parseJsonBody,
  sendBodyReadError,
  sendJson,
} from '../http-utils.ts';
import { sendServerErrorJson } from '../error-response.ts';
import { STATUS_TRUE } from '../status-file.ts';
import {
  getActiveModelPreset,
  readConfig,
  writeConfig,
  normalizeConfig,
  mergeConfig,
} from '../config-store.ts';
import { ExternalServerRestartError } from '../preset-runtime-coordinator.ts';
import { serverLogger } from '../server-logger.ts';
import {
  getModelRequestQueueDiagnostics,
  getPublishedStatusText,
  resumeModelRequestAdmission,
  unloadModelManually,
} from '../server-ops.ts';
import { ChatSessionSchema, InferenceRuntimeDashboardStatusSchema, ModelLifecycleRequestSchema, ModelLifecycleResponseSchema } from '@siftkit/contracts';
import type { ModelLifecycleAction } from '@siftkit/contracts';
import type { ServerContext } from '../server-types.ts';
import type { RouteEndpoint, RouteMatch } from '../route-table.ts';

const inferenceClient = new InferenceClient();

export function isStrictConfigPayload(value: OptionalJsonValue): boolean {
  const record = JsonRecordReader.asObject(value);
  if (!record) {
    return false;
  }
  const topLevelRequired = [
    'Version',
    'PolicyMode',
    'RawLogRetention',
    'ExpandReads',
    'PromptPrefix',
    'Runtime',
    'Thresholds',
    'Interactive',
    'Server',
  ];
  for (const key of topLevelRequired) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return false;
    }
  }
  const runtime = JsonRecordReader.asObject(record.Runtime);
  const thresholds = JsonRecordReader.asObject(record.Thresholds);
  const interactive = JsonRecordReader.asObject(record.Interactive);
  const server = JsonRecordReader.asObject(record.Server);
  if (!runtime || !thresholds || !interactive || !server) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(runtime, 'Engine')
    && Object.prototype.hasOwnProperty.call(thresholds, 'MinCharactersForSummary')
    && Object.prototype.hasOwnProperty.call(thresholds, 'MinLinesForSummary')
    && Object.prototype.hasOwnProperty.call(interactive, 'Enabled')
    && Object.prototype.hasOwnProperty.call(interactive, 'WrappedCommands')
    && Object.prototype.hasOwnProperty.call(interactive, 'IdleTimeoutMs')
    && Object.prototype.hasOwnProperty.call(interactive, 'MaxTranscriptCharacters')
    && Object.prototype.hasOwnProperty.call(interactive, 'TranscriptRetention')
    && Object.prototype.hasOwnProperty.call(server, 'ModelPresets');
}

export class HealthEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedEngineStartup } = ctx;
    const startupPending = ctx.engineBootstrap.inProgress;
    sendJson(res, startupPending ? 503 : 200, {
      ok: !startupPending,
      startupPending,
      disableManagedEngineStartup,
      statusPath,
      configPath,
      metricsPath,
      idleSummarySnapshotsPath: ctx.idleSummarySnapshotsPath,
      runtimeRoot: getRuntimeRoot(),
    });
    return;
  }
}

export class StatusReadEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath } = ctx;
    const currentStatus = getPublishedStatusText(ctx);
    const nowMs = Date.now();
    const expired = ctx.statusRuns.pruneExpired(nowMs);
    for (const entry of expired) {
      if (entry.phase === 'awaiting-terminal-metadata') {
        serverLogger.debug({ scope: 'st', id: entry.requestId, event: 'terminal_snapshot_expired', fields: '' });
      }
    }
    sendJson(res, 200, {
      running: currentStatus === STATUS_TRUE,
      status: currentStatus,
      statusPath,
      configPath,
      metrics: ctx.metrics,
      idleSummarySnapshotsPath: ctx.idleSummarySnapshotsPath,
      modelRequests: getModelRequestQueueDiagnostics(ctx),
      activeRuns: ctx.statusRuns.getActiveRuns(nowMs),
    });
    return;
  }
}

export class EngineConfigTestEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { ok: false, statusCode: 0, error: 'Expected valid JSON object.' });
      return;
    }
    const baseUrl = typeof parsedBody.BaseUrl === 'string' && parsedBody.BaseUrl.trim()
      ? parsedBody.BaseUrl.trim().replace(/\/$/u, '')
      : '';
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      sendJson(res, 400, { ok: false, statusCode: 0, error: 'BaseUrl must be an http(s) URL.' });
      return;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      sendJson(res, 400, { ok: false, statusCode: 0, error: 'BaseUrl must be an http(s) URL.' });
      return;
    }
    const timeoutMs = Number.isFinite(Number(parsedBody.HealthcheckTimeoutMs)) && Number(parsedBody.HealthcheckTimeoutMs) > 0
      ? Math.min(Math.trunc(Number(parsedBody.HealthcheckTimeoutMs)), 30_000)
      : 2_000;
    try {
      const response = await inferenceClient.probeModelsAtBaseUrl(baseUrl, timeoutMs);
      sendJson(res, 200, {
        ok: response.statusCode > 0 && response.statusCode < 400,
        statusCode: response.statusCode,
        baseUrl,
      });
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        statusCode: 0,
        baseUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
}

export class ConfigReadEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, disableManagedEngineStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const skipReady = requestUrl.searchParams.get('skip_ready') === '1';
    try {
      const coordinator = ctx.presetRuntimeCoordinator;
      if (skipReady || disableManagedEngineStartup || ctx.engineBootstrap.inProgress || !coordinator) {
        sendJson(res, 200, readConfig(configPath));
        return;
      }
      const runtimeStatus = coordinator.getStatus();
      if (runtimeStatus.processState === 'failed' || runtimeStatus.modelState === 'failed') {
        sendJson(res, 200, readConfig(configPath));
        return;
      }
      await coordinator.ensureActivePresetReady();
      sendJson(res, 200, readConfig(configPath));
    } catch (error) {
      sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
    }
    return;
  }
}

export class ConfigUpdateEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath } = ctx;
    let parsedBody: JsonValue;
    try {
      parsedBody = parseJsonValueText(await readBody(req) || '{}');
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    let nextConfig: ReturnType<typeof normalizeConfig>;
    try {
      const baseConfig = readConfig(configPath);
      nextConfig = isStrictConfigPayload(parsedBody)
        ? normalizeConfig(parsedBody)
        : normalizeConfig(mergeConfig(JsonValueSchema.parse(baseConfig), parsedBody));
      const selections = ChatSessionSchema.pick({ title: true, modelPresetOverrideId: true }).array().parse(
        ctx.runtimeDatabase.prepare(`SELECT title, model_preset_override_id AS modelPresetOverrideId
          FROM chat_sessions WHERE model_preset_override_id IS NOT NULL`).all(),
      );
      const stranded = selections.filter(session => !nextConfig.Server.ModelPresets.Presets
        .some(preset => preset.id === session.modelPresetOverrideId));
      if (stranded.length > 0) {
        throw new Error(`Model presets are selected by chats: ${stranded.map(session => session.title).join(', ')}. Change their model choices before deleting them.`);
      }
    } catch (error) {
      sendJson(res, 400, { error: toError(error).message });
      return;
    }
    // Saving never touches a managed inference runtime. A managed preset is applied by
    // POST /status/restart or lazily before the next model request. Coordinator-free
    // servers have no runtime transition, so their in-memory admission state updates here.
    writeConfig(configPath, nextConfig);
    // The dashboard settings page saves the Assistant block through this endpoint; the
    // running service must observe the change, not keep its boot-time snapshot.
    ctx.assistant?.refreshConfig(nextConfig.Assistant);
    if (!ctx.presetRuntimeCoordinator) {
      ctx.appliedModelPresetState.applyPreset(getActiveModelPreset(nextConfig));
      resumeModelRequestAdmission(ctx);
    }
    sendJson(res, 200, nextConfig);
    return;
  }
}

export class StatusRestartEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, disableManagedEngineStartup } = ctx;
    if (disableManagedEngineStartup) {
      sendJson(res, 400, { ok: false, restarted: false, error: 'Managed backend restart is disabled for this server.' });
      return;
    }
    const coordinator = ctx.presetRuntimeCoordinator;
    if (!coordinator) {
      sendJson(res, 503, { ok: false, restarted: false, error: 'Inference runtime coordinator is unavailable.' });
      return;
    }
    try {
      ctx.modelIdleController?.cancelForPresetChange();
      await coordinator.restartConfiguredPreset();
      sendJson(res, 200, { ok: true, restarted: true, config: readConfig(configPath) });
    } catch (error) {
      if (error instanceof ExternalServerRestartError) {
        sendJson(res, 400, { ok: false, restarted: false, error: error.message });
        return;
      }
      sendJson(res, 503, {
        ok: false,
        restarted: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
}

export class InferenceRuntimeReadEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const coordinator = ctx.presetRuntimeCoordinator;
    if (!coordinator) {
      sendJson(res, 503, { error: 'Inference runtime coordinator is unavailable.' });
      return;
    }
    const preset = ctx.appliedModelPresetState.getPreset();
    const gpuMemory = await ctx.gpuMemoryProbe.read();
    sendJson(res, 200, InferenceRuntimeDashboardStatusSchema.parse({
      ...coordinator.getStatus(),
      imageTokenBudget: preset.Backend === 'exl3' ? resolveImageTokenBudget(preset) : null,
      gpuFreeBytes: gpuMemory === null ? null : gpuMemory.freeBytes,
    }));
  }
}

export class ModelResidencyEndpoint implements RouteEndpoint {
  private readonly action: ModelLifecycleAction;

  constructor(action: ModelLifecycleAction) {
    this.action = action;
  }

  async handle(
    ctx: ServerContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const coordinator = ctx.presetRuntimeCoordinator;
    if (!coordinator) {
      sendJson(res, 503, ModelLifecycleResponseSchema.parse({
        ok: false,
        error: 'Inference runtime coordinator is unavailable.',
      }));
      return;
    }
    try {
      ctx.modelIdleController?.cancelForPresetChange();
      const action = ModelLifecycleRequestSchema.parse({ action: this.action }).action;
      const result = action === 'load'
        ? await coordinator.loadActivePresetNow()
        : await unloadModelManually(ctx, coordinator);
      if (result.status === 'busy') sendJson(res, 409, ModelLifecycleResponseSchema.parse({ ok: false, error: result.reason }));
      else sendJson(res, 200, ModelLifecycleResponseSchema.parse({ ok: true, status: result.status }));
    } catch (error) {
      sendJson(res, 503, ModelLifecycleResponseSchema.parse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}
