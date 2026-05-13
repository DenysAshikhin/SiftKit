/**
 * Dashboard routes: runs listing, run detail, metrics timeseries, and
 * idle-summary snapshots.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
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
import { getRuntimeRoot } from '../paths.js';
import { readConfig } from '../config-store.js';
import {
  deleteManagedLlamaRun,
  listManagedLlamaRuns,
  readManagedLlamaLogTextByStream,
  readManagedLlamaRun,
} from '../../state/managed-llama-runs.js';
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
  type BenchmarkSessionStatus,
} from '../../state/dashboard-benchmark.js';
import {
  cancelBenchmarkJob,
  hasActiveBenchmarkJob,
  startBenchmarkJob,
  subscribeBenchmarkJob,
} from '../dashboard-benchmark-runner.js';
import {
  pickManagedFilePath,
  type ManagedFilePickerTarget,
} from '../file-picker.js';
import type { ServerContext } from '../server-types.js';
import type { SiftConfig } from '../../config/index.js';
import type { Dict } from '../../lib/types.js';

function writeDashboardSse(res: http.ServerResponse, eventName: string, payload: unknown): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function readArrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function getManagedPresetInputs(config: Dict, selectedIds: string[]): BenchmarkManagedPresetInput[] {
  const server = config.Server && typeof config.Server === 'object' && !Array.isArray(config.Server) ? config.Server as Dict : {};
  const llama = server.LlamaCpp && typeof server.LlamaCpp === 'object' && !Array.isArray(server.LlamaCpp) ? server.LlamaCpp as Dict : {};
  const presets = Array.isArray(llama.Presets) ? llama.Presets as Dict[] : [];
  return selectedIds.map((id) => {
    const preset = presets.find((entry) => String(entry.id || '') === id);
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

function readSpecOverrides(value: unknown): BenchmarkSpecOverrideInput[] {
  if (!Array.isArray(value)) {
    return [{ label: 'Current spec settings' }];
  }
  return value
    .filter((entry): entry is Dict => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      label: typeof entry.label === 'string' ? entry.label : undefined,
      SpeculativeEnabled: typeof entry.SpeculativeEnabled === 'boolean' ? entry.SpeculativeEnabled : undefined,
      SpeculativeType: typeof entry.SpeculativeType === 'string' ? entry.SpeculativeType : undefined,
      SpeculativeNgramSizeN: Number.isFinite(entry.SpeculativeNgramSizeN) ? Number(entry.SpeculativeNgramSizeN) : undefined,
      SpeculativeNgramSizeM: Number.isFinite(entry.SpeculativeNgramSizeM) ? Number(entry.SpeculativeNgramSizeM) : undefined,
      SpeculativeNgramMinHits: Number.isFinite(entry.SpeculativeNgramMinHits) ? Number(entry.SpeculativeNgramMinHits) : undefined,
      SpeculativeDraftMax: Number.isFinite(entry.SpeculativeDraftMax) ? Number(entry.SpeculativeDraftMax) : undefined,
      SpeculativeDraftMin: Number.isFinite(entry.SpeculativeDraftMin) ? Number(entry.SpeculativeDraftMin) : undefined,
    }));
}

function parseDashboardRunLogDeleteCriteria(body: Dict): { criteria: DashboardRunLogDeleteCriteria | null; error: string | null } {
  const mode = String(body.mode || '').trim().toLowerCase();
  const type = String(body.type || '').trim().toLowerCase() as DashboardRunLogType;
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
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1) {
      return { criteria: null, error: 'Expected count to be a positive integer.' };
    }
    return { criteria: { mode, type, count }, error: null };
  }
  if (mode === 'before_date') {
    const beforeDate = String(body.beforeDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(beforeDate)) {
      return { criteria: null, error: 'Expected beforeDate in YYYY-MM-DD format.' };
    }
    const parsed = Date.parse(`${beforeDate}T00:00:00.000Z`);
    if (!Number.isFinite(parsed)) {
      return { criteria: null, error: 'Expected a valid beforeDate.' };
    }
    return { criteria: { mode, type, beforeDate }, error: null };
  }
  return { criteria: null, error: 'Expected mode to be count or before_date.' };
}

export async function handleDashboardRoute(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  const runtimeRoot = getRuntimeRoot();
  const { idleSummarySnapshotsPath } = ctx;
  const idleSummaryDatabase = getIdleSummaryDatabase(ctx);

  if (req.method === 'GET' && pathname === '/dashboard/runs') {
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
    return true;
  }

  if (req.method === 'GET' && /^\/dashboard\/runs\/[^/]+$/u.test(pathname)) {
    const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/runs\//u, ''));
    const detail = idleSummaryDatabase ? queryDashboardRunDetailFromDb(idleSummaryDatabase, runId) : null;
    if (!detail) {
      sendJson(res, 404, { error: 'Run not found.' });
      return true;
    }
    sendJson(res, 200, detail);
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/metrics/timeseries') {
    const config = readConfig(ctx.configPath) as SiftConfig;
    const days = buildDashboardDailyMetrics(
      runtimeRoot,
      idleSummaryDatabase,
      ctx.metrics
    );
    const taskDays = buildDashboardTaskDailyMetrics(idleSummaryDatabase, ctx.metrics);
    const toolStats = buildDashboardToolStats(idleSummaryDatabase, ctx.metrics, config);
    sendJson(res, 200, { days, taskDays, toolStats });
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/metrics/idle-summary') {
    if (!fs.existsSync(idleSummarySnapshotsPath)) {
      sendJson(res, 200, { latest: null, snapshots: [] });
      return true;
    }
    const limitValue = Number(requestUrl.searchParams.get('limit') || 30);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitValue) ? Math.floor(limitValue) : 30));
    const rows = queryRecentSnapshots(getIdleSummaryDatabase(ctx), limit);
    const snapshots = rows
      .map(normalizeIdleSummarySnapshotRow)
      .filter((entry): entry is IdleSummarySnapshotRow => entry !== null);
    sendJson(res, 200, { latest: snapshots[0] || null, snapshots });
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/benchmark/question-presets') {
    seedBenchmarkQuestionPresets();
    sendJson(res, 200, { presets: listBenchmarkQuestionPresets({ includeDisabled: true }) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/dashboard/benchmark/question-presets') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    try {
      const preset = createBenchmarkQuestionPreset({
        title: String(parsedBody.title || ''),
        taskKind: String(parsedBody.taskKind || '') as 'repo-search' | 'summary',
        prompt: String(parsedBody.prompt || ''),
        enabled: parsedBody.enabled !== false,
      });
      sendJson(res, 200, { preset });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if ((req.method === 'PUT' || req.method === 'DELETE') && /^\/dashboard\/benchmark\/question-presets\/[^/]+$/u.test(pathname)) {
    const presetId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/question-presets\//u, ''));
    if (req.method === 'DELETE') {
      sendJson(res, 200, { ok: true, deleted: deleteBenchmarkQuestionPreset(presetId), id: presetId });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    try {
      const preset = updateBenchmarkQuestionPreset({
        id: presetId,
        title: typeof parsedBody.title === 'string' ? parsedBody.title : undefined,
        taskKind: typeof parsedBody.taskKind === 'string' ? parsedBody.taskKind as 'repo-search' | 'summary' : undefined,
        prompt: typeof parsedBody.prompt === 'string' ? parsedBody.prompt : undefined,
        enabled: typeof parsedBody.enabled === 'boolean' ? parsedBody.enabled : undefined,
      });
      if (!preset) {
        sendJson(res, 404, { error: 'Benchmark question preset not found.' });
      } else {
        sendJson(res, 200, { preset });
      }
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/benchmark/sessions') {
    const limitValue = Number(requestUrl.searchParams.get('limit') || 50);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 50;
    const status = String(requestUrl.searchParams.get('status') || '').trim() as BenchmarkSessionStatus | '';
    sendJson(res, 200, { sessions: listBenchmarkSessions({ limit, status }) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/dashboard/benchmark/sessions') {
    if (hasActiveBenchmarkJob()) {
      sendJson(res, 409, { error: 'A benchmark session is already running.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
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
    return true;
  }

  if (req.method === 'GET' && /^\/dashboard\/benchmark\/sessions\/[^/]+\/events$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/sessions\//u, '').replace(/\/events$/u, ''));
    let disconnected = false;
    req.on('close', () => { disconnected = true; });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    let unsubscribe = (): void => {};
    unsubscribe = subscribeBenchmarkJob(sessionId, (event) => {
      if (disconnected) {
        unsubscribe();
        return;
      }
      writeDashboardSse(res, event.event, event.payload);
    });
    return true;
  }

  if (req.method === 'GET' && /^\/dashboard\/benchmark\/sessions\/[^/]+$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/sessions\//u, ''));
    const detail = readBenchmarkSessionDetail(sessionId);
    if (!detail) {
      sendJson(res, 404, { error: 'Benchmark session not found.' });
      return true;
    }
    sendJson(res, 200, {
      ...detail,
      logTextByStream: readBenchmarkLogTextByStream({ sessionId }),
    });
    return true;
  }

  if (req.method === 'POST' && /^\/dashboard\/benchmark\/sessions\/[^/]+\/cancel$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/sessions\//u, '').replace(/\/cancel$/u, ''));
    sendJson(res, 200, { ok: true, cancelled: cancelBenchmarkJob(sessionId), id: sessionId });
    return true;
  }

  if (req.method === 'PUT' && /^\/dashboard\/benchmark\/attempts\/[^/]+\/grade$/u.test(pathname)) {
    const attemptId = decodeURIComponent(pathname.replace(/^\/dashboard\/benchmark\/attempts\//u, '').replace(/\/grade$/u, ''));
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
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
        sendJson(res, 200, { attempt });
      }
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/dashboard/admin/run-logs/preview') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const { criteria, error } = parseDashboardRunLogDeleteCriteria(parsedBody);
    if (!criteria) {
      sendJson(res, 400, { error: error || 'Expected valid run-log delete criteria.' });
      return true;
    }
    const preview = idleSummaryDatabase
      ? previewDashboardRunLogDeletion(idleSummaryDatabase, criteria)
      : { matchCount: 0 };
    sendJson(res, 200, { ok: true, ...preview });
    return true;
  }

  if (req.method === 'DELETE' && pathname === '/dashboard/admin/run-logs') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const { criteria, error } = parseDashboardRunLogDeleteCriteria(parsedBody);
    if (!criteria) {
      sendJson(res, 400, { error: error || 'Expected valid run-log delete criteria.' });
      return true;
    }
    const deletion = idleSummaryDatabase
      ? deleteDashboardRunLogs(idleSummaryDatabase, criteria)
      : { deletedCount: 0, deletedRunIds: [] };
    sendJson(res, 200, { ok: true, ...deletion });
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/admin/managed-llama/runs') {
    const limitValue = Number(requestUrl.searchParams.get('limit') || 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 100;
    const status = String(requestUrl.searchParams.get('status') || '').trim();
    const runs = listManagedLlamaRuns({ limit, status: status as '' | 'running' | 'ready' | 'failed' | 'stopped' | 'sync_completed' });
    sendJson(res, 200, { runs });
    return true;
  }

  if (req.method === 'GET' && /^\/dashboard\/admin\/managed-llama\/runs\/[^/]+$/u.test(pathname)) {
    const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/managed-llama\/runs\//u, ''));
    const run = readManagedLlamaRun(runId);
    if (!run) {
      sendJson(res, 404, { error: 'Managed llama run not found.' });
      return true;
    }
    const logTextByStream = readManagedLlamaLogTextByStream(runId);
    sendJson(res, 200, { run, logTextByStream });
    return true;
  }

  if (req.method === 'DELETE' && /^\/dashboard\/admin\/managed-llama\/runs\/[^/]+$/u.test(pathname)) {
    const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/managed-llama\/runs\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteManagedLlamaRun(runId), id: runId });
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/admin/benchmark-matrix/sessions') {
    const limitValue = Number(requestUrl.searchParams.get('limit') || 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 100;
    const status = String(requestUrl.searchParams.get('status') || '').trim();
    const sessions = listBenchmarkMatrixSessions({ limit, status: status as '' | 'running' | 'completed' | 'failed' });
    sendJson(res, 200, { sessions });
    return true;
  }

  if (req.method === 'GET' && /^\/dashboard\/admin\/benchmark-matrix\/sessions\/[^/]+$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/benchmark-matrix\/sessions\//u, ''));
    const session = readBenchmarkMatrixSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Benchmark matrix session not found.' });
      return true;
    }
    const runs = listBenchmarkMatrixRunsForSession(sessionId).map((run) => ({
      ...run,
      logTextByStream: readBenchmarkMatrixRunLogTextByStream(run.id),
    }));
    sendJson(res, 200, { session, runs });
    return true;
  }

  if (req.method === 'DELETE' && /^\/dashboard\/admin\/benchmark-matrix\/sessions\/[^/]+$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/benchmark-matrix\/sessions\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteBenchmarkMatrixSession(sessionId), id: sessionId });
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/admin/benchmark-runs') {
    const limitValue = Number(requestUrl.searchParams.get('limit') || 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 100;
    sendJson(res, 200, { rows: listBenchmarkRuns({ limit }) });
    return true;
  }

  if (req.method === 'GET' && /^\/dashboard\/admin\/benchmark-runs\/[^/]+$/u.test(pathname)) {
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/benchmark-runs\//u, ''));
    const row = readBenchmarkRun(id);
    if (!row) {
      sendJson(res, 404, { error: 'Benchmark run not found.' });
      return true;
    }
    sendJson(res, 200, { row });
    return true;
  }

  if (req.method === 'DELETE' && /^\/dashboard\/admin\/benchmark-runs\/[^/]+$/u.test(pathname)) {
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/benchmark-runs\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteBenchmarkRun(id), id });
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/admin/eval-results') {
    const limitValue = Number(requestUrl.searchParams.get('limit') || 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 100;
    sendJson(res, 200, { rows: listEvalResults({ limit }) });
    return true;
  }

  if (req.method === 'GET' && /^\/dashboard\/admin\/eval-results\/[^/]+$/u.test(pathname)) {
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/eval-results\//u, ''));
    const row = readEvalResult(id);
    if (!row) {
      sendJson(res, 404, { error: 'Eval result not found.' });
      return true;
    }
    sendJson(res, 200, { row });
    return true;
  }

  if (req.method === 'DELETE' && /^\/dashboard\/admin\/eval-results\/[^/]+$/u.test(pathname)) {
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/eval-results\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteEvalResult(id), id });
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/admin/runtime-artifacts') {
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
    return true;
  }

  if (req.method === 'GET' && /^\/dashboard\/admin\/runtime-artifacts\/[^/]+$/u.test(pathname)) {
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/runtime-artifacts\//u, ''));
    const row = readRuntimeArtifact(id);
    if (!row) {
      sendJson(res, 404, { error: 'Runtime artifact not found.' });
      return true;
    }
    sendJson(res, 200, { row });
    return true;
  }

  if (req.method === 'DELETE' && /^\/dashboard\/admin\/runtime-artifacts\/[^/]+$/u.test(pathname)) {
    const id = decodeURIComponent(pathname.replace(/^\/dashboard\/admin\/runtime-artifacts\//u, ''));
    sendJson(res, 200, { ok: true, deleted: deleteRuntimeArtifact(id), id });
    return true;
  }

  if (req.method === 'POST' && pathname === '/dashboard/system/pick-file') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const target = String(parsedBody.target || '').trim() as ManagedFilePickerTarget;
    if (target !== 'managed-llama-executable' && target !== 'managed-llama-model') {
      sendJson(res, 400, { error: 'Expected a valid file picker target.' });
      return true;
    }
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
    return true;
  }

  return false;
}
