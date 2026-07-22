/**
 * Dashboard routes: runs listing, run detail, metrics timeseries, and
 * idle-summary snapshots.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  MetricsResponse,
  IdleSummaryResponse,
  WebSearchQuotaResponse,
  DashboardBenchmarkSessionDetail,
  DashboardBenchmarkSessionsResponse,
  DashboardBenchmarkQuestionPresetsResponse,
  DashboardBenchmarkQuestionPreset,
  DashboardBenchmarkAttempt,
} from '@siftkit/contracts';
import { existsSync } from 'node:fs';
import { z } from '../../lib/zod.js';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import { parseJsonBody, readBody, sendJson } from '../http-utils.js';
import {
  queryDashboardRunsFromDb,
  queryDashboardRunDetailFromDb,
  buildDashboardDailyMetrics,
  buildDashboardTaskDailyMetrics,
  buildDashboardToolStats,
  normalizeIdleSummarySnapshotRow,
  previewDashboardRunLogDeletion,
  deleteDashboardRunLogs,
  type DashboardRunLogDeleteCriteria,
  type DashboardRunLogType,
  type IdleSummarySnapshotRow,
} from '../dashboard-runs.js';
import { queryRecentSnapshots } from '../idle-summary.js';
import { getIdleSummaryDatabase } from '../server-ops.js';
import { getRuntimeRoot, getMetricsPath } from '../paths.js';
import { DEFAULT_WEB_SEARCH_CONFIG, readConfig } from '../config-store.js';
import { readWebSearchUsage } from '../web-search-usage.js';
import { WebSearchQuotaCache } from '../web-search-quota.js';
import {
  deleteInferenceRun,
  listInferenceRuns,
  readInferenceRunLogTextByStream,
  readInferenceRun,
} from '../../state/inference-runs.js';
import {
  deleteBenchmarkMatrixSession,
  listBenchmarkMatrixRunsForSession,
  listBenchmarkMatrixSessions,
  readBenchmarkMatrixRunLogTextByStream,
  readBenchmarkMatrixSession,
} from '../../state/benchmark-matrix.js';
import {
  deleteBenchmarkRun,
  deleteEvalResult,
  listBenchmarkRuns,
  listEvalResults,
  readBenchmarkRun,
  readEvalResult,
} from '../../state/runtime-results.js';
import {
  deleteRuntimeArtifact,
  listRuntimeArtifacts,
  readRuntimeArtifact,
} from '../../state/runtime-artifacts.js';
import {
  createBenchmarkQuestionPreset,
  createBenchmarkSessionPlan,
  deleteBenchmarkQuestionPreset,
  listBenchmarkQuestionPresets,
  listBenchmarkSessions,
  readBenchmarkLogTextByStream,
  readBenchmarkSessionDetail,
  seedBenchmarkQuestionPresets,
  updateBenchmarkAttemptGrade,
  updateBenchmarkQuestionPreset,
  type BenchmarkManagedPresetInput,
  type BenchmarkSpecOverrideInput,
} from '../../state/dashboard-benchmark.js';
import {
  cancelBenchmarkJob,
  hasActiveBenchmarkJob,
  startBenchmarkJob,
  subscribeBenchmarkJob,
} from '../dashboard-benchmark-runner.js';
import { pickManagedFilePath } from '../file-picker.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.js';
import type { ServerContext } from '../server-types.js';
import type { SiftConfig } from '../../config/index.js';
import type { JsonObject, OptionalJsonValue } from '../../lib/json-types.js';
import type { WebSearchConfig } from '../../web-search/types.js';
import { parseDashboardRunLogDeleteRequest } from '../route-request-normalizers.js';
import { SseResponseWriter } from '../sse-response-writer.js';

const webSearchQuotaCache = new WebSearchQuotaCache();

const BenchmarkTaskKindSchema = z.enum(['repo-search', 'summary']);
const BenchmarkSessionStatusFilterSchema = z.enum(['', 'running', 'completed', 'failed', 'cancelled']).catch('');
const InferenceRunStatusFilterSchema = z.enum(['', 'running', 'ready', 'failed', 'stopped', 'sync_completed']).catch('');
const BenchmarkMatrixSessionStatusFilterSchema = z.enum(['', 'running', 'completed', 'failed']).catch('');
const ManagedFilePickerTargetSchema = z.enum(['managed-llama-executable', 'managed-llama-model']);

function readArrayOfStrings(value: OptionalJsonValue): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
}

function readPositiveInteger(value: OptionalJsonValue, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function getManagedPresetInputs(config: SiftConfig, selectedIds: string[]): BenchmarkManagedPresetInput[] {
  const presets = config.Server.ModelPresets.Presets;
  return selectedIds.map((id) => {
    const preset = presets.find((entry) => entry.id === id);
    if (!preset) {
      throw new Error(`Managed llama preset not found: ${id}`);
    }
    return {
      ...preset,
      id,
      label: String(preset.label || id),
    };
  });
}

function readSpecOverrides(value: OptionalJsonValue): BenchmarkSpecOverrideInput[] {
  if (!Array.isArray(value)) {
    return [{ label: 'Current spec settings' }];
  }
  return value
    .map((entry) => JsonRecordReader.asObject(entry))
    .filter((entry): entry is JsonObject => entry !== null)
    .map((entry) => {
      const reader = new JsonRecordReader(entry);
      return {
        label: reader.optionalString('label'),
        SpeculativeEnabled: typeof reader.value('SpeculativeEnabled') === 'boolean' ? Boolean(reader.value('SpeculativeEnabled')) : undefined,
        SpeculativeType: reader.optionalString('SpeculativeType'),
        SpeculativeNgramSizeN: reader.number('SpeculativeNgramSizeN') ?? undefined,
        SpeculativeNgramSizeM: reader.number('SpeculativeNgramSizeM') ?? undefined,
        SpeculativeNgramMinHits: reader.number('SpeculativeNgramMinHits') ?? undefined,
        SpeculativeDraftMax: reader.number('SpeculativeDraftMax') ?? undefined,
        SpeculativeDraftMin: reader.number('SpeculativeDraftMin') ?? undefined,
      };
    });
}

function parseDashboardRunLogDeleteCriteria(body: JsonObject): { criteria: DashboardRunLogDeleteCriteria | null; error: string | null } {
  const request = parseDashboardRunLogDeleteRequest(body);
  if (request) {
    return {
      criteria: request.mode === 'count'
        ? request
        : { mode: 'before_date', type: request.type, beforeDate: request.beforeDate },
      error: null,
    };
  }
  const reader = new JsonRecordReader(body);
  const mode = reader.string('mode').toLowerCase();
  const type = reader.string('type').toLowerCase();
  const validType = type === 'all'
    || type === 'summary'
    || type === 'repo_search'
    || type === 'planner'
    || type === 'chat'
    || type === 'other';
  if (!validType) {
    return { criteria: null, error: 'Expected a valid run-log type.' };
  }
  if (mode === 'count') {
    return { criteria: null, error: 'Expected count to be a positive integer.' };
  }
  if (mode === 'beforedate' || mode === 'before_date') {
    return { criteria: null, error: 'Expected beforeDate in YYYY-MM-DD format.' };
  }
  return { criteria: null, error: 'Expected mode to be count or before_date.' };
}

class DashboardRunsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const query = requestUrl.searchParams;
    const search = (query.get('search') || '').trim().toLowerCase();
    const kind = (query.get('kind') || '').trim().toLowerCase();
    const statusFilter = (query.get('status') || '').trim().toLowerCase();
    const initial = requestUrl.searchParams.get('initial') === '1';
    const limitRaw = Number(requestUrl.searchParams.get('limitPerGroup') || 20);
    const limitPerGroup = Number.isFinite(limitRaw) ? Math.max(1, Math.trunc(limitRaw)) : 20;
    const runs = idleSummaryDatabase
      ? queryDashboardRunsFromDb(idleSummaryDatabase, {
        search,
        kind,
        status: statusFilter,
        initial,
        limitPerGroup,
      })
      : [];
    sendJson(res, 200, { runs, total: runs.length });
    return;
  }
}

class DashboardRunDetailEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/runs\//u, ''));
    const detail = idleSummaryDatabase ? queryDashboardRunDetailFromDb(idleSummaryDatabase, runId) : null;
    if (!detail) {
      sendJson(res, 404, { error: 'Run not found.' });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }
}

class DashboardMetricsTimeseriesEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const config = readConfig(ctx.configPath);
    const days = buildDashboardDailyMetrics(
      runtimeRoot,
      idleSummaryDatabase,
      ctx.metrics
    );
    const taskDays = buildDashboardTaskDailyMetrics(idleSummaryDatabase, ctx.metrics);
    const toolStats = buildDashboardToolStats(idleSummaryDatabase, ctx.metrics, config);
    const webSearchUsage = readWebSearchUsage(getMetricsPath(), new Date());
    sendJson(res, 200, { days, taskDays, toolStats, webSearchUsage } satisfies MetricsResponse);
    return;
  }
}

class DashboardWebSearchQuotaEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const config = readConfig(ctx.configPath);
    const webSearchConfig: WebSearchConfig = config.WebSearch ?? {
      ...DEFAULT_WEB_SEARCH_CONFIG,
      ProviderOrder: [...DEFAULT_WEB_SEARCH_CONFIG.ProviderOrder],
    };
    const quotas = await webSearchQuotaCache.read(webSearchConfig);
    sendJson(res, 200, { quotas } satisfies WebSearchQuotaResponse);
    return;
  }
}

class DashboardIdleSummaryEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    if (!existsSync(idleSummarySnapshotsPath)) {
      sendJson(res, 200, { latest: null, snapshots: [] } satisfies IdleSummaryResponse);
      return;
    }
    const limitValue = Number(requestUrl.searchParams.get('limit') || 30);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitValue) ? Math.floor(limitValue) : 30));
    const rows = queryRecentSnapshots(getIdleSummaryDatabase(ctx), limit);
    const snapshots = rows
      .map(normalizeIdleSummarySnapshotRow)
      .filter((entry): entry is IdleSummarySnapshotRow => entry !== null);
    sendJson(res, 200, { latest: snapshots[0] || null, snapshots } satisfies IdleSummaryResponse);
    return;
  }
}

class BenchmarkQuestionPresetListEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    seedBenchmarkQuestionPresets();
    sendJson(res, 200, { presets: listBenchmarkQuestionPresets({ includeDisabled: true }) } satisfies DashboardBenchmarkQuestionPresetsResponse);
    return;
  }
}

class BenchmarkQuestionPresetCreateEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    try {
      const preset = createBenchmarkQuestionPreset({
        title: String(parsedBody.title || ''),
        taskKind: BenchmarkTaskKindSchema.parse(parsedBody.taskKind),
        prompt: String(parsedBody.prompt || ''),
        enabled: parsedBody.enabled !== false,
      });
      sendJson(res, 200, { preset } satisfies { preset: DashboardBenchmarkQuestionPreset });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
}

class BenchmarkQuestionPresetMutationEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const presetId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/question-presets\//u, ''));
    if (req.method === 'DELETE') {
      sendJson(res, 200, { ok: true, deleted: deleteBenchmarkQuestionPreset(presetId), id: presetId });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    try {
      const preset = updateBenchmarkQuestionPreset({
        id: presetId,
        title: typeof parsedBody.title === 'string' ? parsedBody.title : undefined,
        taskKind: BenchmarkTaskKindSchema.optional().catch(undefined).parse(parsedBody.taskKind),
        prompt: typeof parsedBody.prompt === 'string' ? parsedBody.prompt : undefined,
        enabled: typeof parsedBody.enabled === 'boolean' ? parsedBody.enabled : undefined,
      });
      if (!preset) {
        sendJson(res, 404, { error: 'Benchmark question preset not found.' });
      } else {
        sendJson(res, 200, { preset } satisfies { preset: DashboardBenchmarkQuestionPreset });
      }
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
}

class BenchmarkSessionListEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const limitValue = Number(requestUrl.searchParams.get('limit') || 50);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 50;
    const status = BenchmarkSessionStatusFilterSchema.parse(String(requestUrl.searchParams.get('status') || '').trim());
    sendJson(res, 200, { sessions: listBenchmarkSessions({ limit, status }) } satisfies DashboardBenchmarkSessionsResponse);
    return;
  }
}

class BenchmarkSessionCreateEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    if (hasActiveBenchmarkJob()) {
      sendJson(res, 409, { error: 'A benchmark session is already running.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    try {
      const config = readConfig(ctx.configPath);
      const managedPresetIds = readArrayOfStrings(parsedBody.managedPresetIds);
      const sessionPlan = createBenchmarkSessionPlan({
        questionPresetIds: readArrayOfStrings(parsedBody.questionPresetIds),
        repetitions: readPositiveInteger(parsedBody.repetitions, 1),
        managedPresets: getManagedPresetInputs(config, managedPresetIds),
        specOverrides: readSpecOverrides(parsedBody.specOverrides),
        originalConfigJson: JSON.stringify(config),
      });
      startBenchmarkJob(ctx, sessionPlan.session.id);
      sendJson(res, 200, sessionPlan);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
}

class BenchmarkSessionEventsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/sessions\//u, '').replace(/\/events$/u, ''));
    const sseWriter = new SseResponseWriter(req, res);
    sseWriter.open();
    let unsubscribe = (): void => {};
    unsubscribe = subscribeBenchmarkJob(sessionId, (event) => {
      if (sseWriter.isClientDisconnected()) {
        unsubscribe();
        return;
      }
      sseWriter.writeEvent(event.event, event.payload);
    });
    return;
  }
}

class BenchmarkSessionDetailEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/sessions\//u, ''));
    const detail = readBenchmarkSessionDetail(sessionId);
    if (!detail) {
      sendJson(res, 404, { error: 'Benchmark session not found.' });
      return;
    }
    const conformingDetail: DashboardBenchmarkSessionDetail = detail;
    sendJson(res, 200, {
      ...conformingDetail,
      logTextByStream: readBenchmarkLogTextByStream({ sessionId }),
    });
    return;
  }
}

class BenchmarkSessionCancelEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/sessions\//u, '').replace(/\/cancel$/u, ''));
    sendJson(res, 200, { ok: true, cancelled: cancelBenchmarkJob(sessionId), id: sessionId });
    return;
  }
}

class BenchmarkAttemptGradeEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const attemptId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/attempts\//u, '').replace(/\/grade$/u, ''));
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    try {
      const attempt = updateBenchmarkAttemptGrade({
        attemptId,
        outputQualityScore: parsedBody.outputQualityScore === null ? null : Number(parsedBody.outputQualityScore),
        toolUseQualityScore: parsedBody.toolUseQualityScore === null ? null : Number(parsedBody.toolUseQualityScore),
        reviewNotes: typeof parsedBody.reviewNotes === 'string' ? parsedBody.reviewNotes : null,
        reviewedBy: typeof parsedBody.reviewedBy === 'string' ? parsedBody.reviewedBy : 'codex',
      });
      if (!attempt) {
        sendJson(res, 404, { error: 'Benchmark attempt not found.' });
      } else {
        sendJson(res, 200, { attempt } satisfies { attempt: DashboardBenchmarkAttempt });
      }
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
}

class RunLogsPreviewEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const { criteria, error } = parseDashboardRunLogDeleteCriteria(parsedBody);
    if (!criteria) {
      sendJson(res, 400, { error: error || 'Expected valid run-log delete criteria.' });
      return;
    }
    const preview = idleSummaryDatabase
      ? previewDashboardRunLogDeletion(idleSummaryDatabase, criteria)
      : { matchCount: 0 };
    sendJson(res, 200, { ok: true, ...preview });
    return;
  }
}

class RunLogsDeleteEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const { criteria, error } = parseDashboardRunLogDeleteCriteria(parsedBody);
    if (!criteria) {
      sendJson(res, 400, { error: error || 'Expected valid run-log delete criteria.' });
      return;
    }
    const deletion = idleSummaryDatabase
      ? deleteDashboardRunLogs(idleSummaryDatabase, criteria)
      : { deletedCount: 0, deletedRunIds: [] };
    sendJson(res, 200, { ok: true, ...deletion });
    return;
  }
}

class ManagedLlamaRunsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const limitValue = Number(requestUrl.searchParams.get('limit') || 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 100;
    const status = InferenceRunStatusFilterSchema.parse(String(requestUrl.searchParams.get('status') || '').trim());
    const runs = listInferenceRuns({ limit, status });
    sendJson(res, 200, { runs });
    return;
  }
}

class ManagedLlamaRunDetailEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/managed-llama\/runs\//u, ''));
    const run = readInferenceRun(runId);
    if (!run) {
      sendJson(res, 404, { error: 'Managed llama run not found.' });
      return;
    }
    const logTextByStream = readInferenceRunLogTextByStream(runId);
    sendJson(res, 200, { run, logTextByStream });
    return;
  }
}

class ManagedLlamaRunDeleteEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/managed-llama\/runs\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteInferenceRun(runId), id: runId });
    return;
  }
}

class BenchmarkMatrixSessionsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const limitValue = Number(requestUrl.searchParams.get('limit') || 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 100;
    const status = BenchmarkMatrixSessionStatusFilterSchema.parse(String(requestUrl.searchParams.get('status') || '').trim());
    const sessions = listBenchmarkMatrixSessions({ limit, status });
    sendJson(res, 200, { sessions });
    return;
  }
}

class BenchmarkMatrixSessionDetailEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/benchmark-matrix\/sessions\//u, ''));
    const session = readBenchmarkMatrixSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Benchmark matrix session not found.' });
      return;
    }
    const runs = listBenchmarkMatrixRunsForSession(sessionId).map((run) => ({
      ...run,
      logTextByStream: readBenchmarkMatrixRunLogTextByStream(run.id),
    }));
    sendJson(res, 200, { session, runs });
    return;
  }
}

class BenchmarkMatrixSessionDeleteEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/benchmark-matrix\/sessions\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteBenchmarkMatrixSession(sessionId), id: sessionId });
    return;
  }
}

class BenchmarkRunsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const limitValue = Number(requestUrl.searchParams.get('limit') || 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 100;
    sendJson(res, 200, { rows: listBenchmarkRuns({ limit }) });
    return;
  }
}

class BenchmarkRunDetailEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/benchmark-runs\//u, ''));
    const row = readBenchmarkRun(id);
    if (!row) {
      sendJson(res, 404, { error: 'Benchmark run not found.' });
      return;
    }
    sendJson(res, 200, { row });
    return;
  }
}

class BenchmarkRunDeleteEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/benchmark-runs\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteBenchmarkRun(id), id });
    return;
  }
}

class EvalResultsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const limitValue = Number(requestUrl.searchParams.get('limit') || 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 100;
    sendJson(res, 200, { rows: listEvalResults({ limit }) });
    return;
  }
}

class EvalResultDetailEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/eval-results\//u, ''));
    const row = readEvalResult(id);
    if (!row) {
      sendJson(res, 404, { error: 'Eval result not found.' });
      return;
    }
    sendJson(res, 200, { row });
    return;
  }
}

class EvalResultDeleteEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/eval-results\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteEvalResult(id), id });
    return;
  }
}

class RuntimeArtifactsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const limitValue = Number(requestUrl.searchParams.get('limit') || 200);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(1000, Math.trunc(limitValue))) : 200;
    const artifactKind = String(requestUrl.searchParams.get('kind') || '').trim();
    const requestId = String(requestUrl.searchParams.get('requestId') || '').trim();
    sendJson(res, 200, {
      rows: listRuntimeArtifacts({
        artifactKind,
        requestId,
        limit,
      }),
    });
    return;
  }
}

class RuntimeArtifactDetailEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/runtime-artifacts\//u, ''));
    const row = readRuntimeArtifact(id);
    if (!row) {
      sendJson(res, 404, { error: 'Runtime artifact not found.' });
      return;
    }
    sendJson(res, 200, { row });
    return;
  }
}

class RuntimeArtifactDeleteEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/runtime-artifacts\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteRuntimeArtifact(id), id });
    return;
  }
}

class SystemPickFileEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const pathname = match.pathname;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtimeRoot = getRuntimeRoot();
    const { idleSummarySnapshotsPath } = ctx;
    const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const parsedTarget = ManagedFilePickerTargetSchema.safeParse(String(parsedBody.target || '').trim());
    if (!parsedTarget.success) {
      sendJson(res, 400, { error: 'Expected a valid file picker target.' });
      return;
    }
    const target = parsedTarget.data;
    const initialPath = typeof parsedBody.initialPath === 'string' && parsedBody.initialPath.trim()
      ? parsedBody.initialPath.trim()
      : null;
    try {
      const result = await pickManagedFilePath(target, initialPath);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = /only supported on Windows/iu.test(message) ? 501 : 500;
      sendJson(res, statusCode, { error: message });
    }
    return;
  }
}
const BENCHMARK_QUESTION_PRESET_MUTATION_ENDPOINT = new BenchmarkQuestionPresetMutationEndpoint();

const DASHBOARD_ROUTES = new RouteTable([
  { method: 'GET', path: '/dashboard/runs', endpoint: new DashboardRunsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/runs\/([^/]+)$/u, endpoint: new DashboardRunDetailEndpoint() },
  { method: 'GET', path: '/dashboard/metrics/timeseries', endpoint: new DashboardMetricsTimeseriesEndpoint() },
  { method: 'GET', path: '/dashboard/web-search-quota', endpoint: new DashboardWebSearchQuotaEndpoint() },
  { method: 'GET', path: '/dashboard/metrics/idle-summary', endpoint: new DashboardIdleSummaryEndpoint() },
  { method: 'GET', path: '/dashboard/benchmark/question-presets', endpoint: new BenchmarkQuestionPresetListEndpoint() },
  { method: 'POST', path: '/dashboard/benchmark/question-presets', endpoint: new BenchmarkQuestionPresetCreateEndpoint() },
  { method: 'PUT', path: /^\/dashboard\/benchmark\/question-presets\/([^/]+)$/u, endpoint: BENCHMARK_QUESTION_PRESET_MUTATION_ENDPOINT },
  { method: 'DELETE', path: /^\/dashboard\/benchmark\/question-presets\/([^/]+)$/u, endpoint: BENCHMARK_QUESTION_PRESET_MUTATION_ENDPOINT },
  { method: 'GET', path: '/dashboard/benchmark/sessions', endpoint: new BenchmarkSessionListEndpoint() },
  { method: 'POST', path: '/dashboard/benchmark/sessions', endpoint: new BenchmarkSessionCreateEndpoint() },
  { method: 'GET', path: /^\/dashboard\/benchmark\/sessions\/([^/]+)\/events$/u, endpoint: new BenchmarkSessionEventsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/benchmark\/sessions\/([^/]+)$/u, endpoint: new BenchmarkSessionDetailEndpoint() },
  { method: 'POST', path: /^\/dashboard\/benchmark\/sessions\/([^/]+)\/cancel$/u, endpoint: new BenchmarkSessionCancelEndpoint() },
  { method: 'PUT', path: /^\/dashboard\/benchmark\/attempts\/([^/]+)\/grade$/u, endpoint: new BenchmarkAttemptGradeEndpoint() },
  { method: 'POST', path: '/dashboard/admin/run-logs/preview', endpoint: new RunLogsPreviewEndpoint() },
  { method: 'DELETE', path: '/dashboard/admin/run-logs', endpoint: new RunLogsDeleteEndpoint() },
  { method: 'GET', path: '/dashboard/admin/managed-llama/runs', endpoint: new ManagedLlamaRunsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/admin\/managed-llama\/runs\/([^/]+)$/u, endpoint: new ManagedLlamaRunDetailEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/admin\/managed-llama\/runs\/([^/]+)$/u, endpoint: new ManagedLlamaRunDeleteEndpoint() },
  { method: 'GET', path: '/dashboard/admin/benchmark-matrix/sessions', endpoint: new BenchmarkMatrixSessionsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/admin\/benchmark-matrix\/sessions\/([^/]+)$/u, endpoint: new BenchmarkMatrixSessionDetailEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/admin\/benchmark-matrix\/sessions\/([^/]+)$/u, endpoint: new BenchmarkMatrixSessionDeleteEndpoint() },
  { method: 'GET', path: '/dashboard/admin/benchmark-runs', endpoint: new BenchmarkRunsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/admin\/benchmark-runs\/([^/]+)$/u, endpoint: new BenchmarkRunDetailEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/admin\/benchmark-runs\/([^/]+)$/u, endpoint: new BenchmarkRunDeleteEndpoint() },
  { method: 'GET', path: '/dashboard/admin/eval-results', endpoint: new EvalResultsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/admin\/eval-results\/([^/]+)$/u, endpoint: new EvalResultDetailEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/admin\/eval-results\/([^/]+)$/u, endpoint: new EvalResultDeleteEndpoint() },
  { method: 'GET', path: '/dashboard/admin/runtime-artifacts', endpoint: new RuntimeArtifactsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/admin\/runtime-artifacts\/([^/]+)$/u, endpoint: new RuntimeArtifactDetailEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/admin\/runtime-artifacts\/([^/]+)$/u, endpoint: new RuntimeArtifactDeleteEndpoint() },
  { method: 'POST', path: '/dashboard/system/pick-file', endpoint: new SystemPickFileEndpoint() },
]);

export async function handleDashboardRoute(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _requestUrl: URL,
): Promise<boolean> {
  return await DASHBOARD_ROUTES.handle(ctx, req, res, pathname);
}
