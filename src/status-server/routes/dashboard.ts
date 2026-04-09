/**
 * Dashboard routes: runs listing, run detail, metrics timeseries, and
 * idle-summary snapshots.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import { sendJson } from '../http-utils.js';
import {
  loadDashboardRuns,
  buildDashboardRunDetail,
  buildDashboardDailyMetrics,
  buildDashboardTaskDailyMetrics,
  buildDashboardToolStats,
  normalizeIdleSummarySnapshotRow,
  type IdleSummarySnapshotRow,
} from '../dashboard-runs.js';
import { queryRecentSnapshots } from '../idle-summary.js';
import { getIdleSummaryDatabase } from '../server-ops.js';
import { getRuntimeRoot } from '../paths.js';
import { readConfig } from '../config-store.js';
import type { ServerContext } from '../server-types.js';
import type { SiftConfig } from '../../config/index.js';

export async function handleDashboardRoute(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  const runtimeRoot = getRuntimeRoot();
  const { idleSummarySnapshotsPath } = ctx;

  if (req.method === 'GET' && pathname === '/dashboard/runs') {
    const query = requestUrl.searchParams;
    const search = (query.get('search') || '').trim().toLowerCase();
    const kind = (query.get('kind') || '').trim().toLowerCase();
    const statusFilter = (query.get('status') || '').trim().toLowerCase();
    const runs = loadDashboardRuns(runtimeRoot).filter((run) => {
      if (kind && String(run.kind).toLowerCase() !== kind) {
        return false;
      }
      if (statusFilter && String(run.status).toLowerCase() !== statusFilter) {
        return false;
      }
      if (!search) {
        return true;
      }
      return String(run.title || '').toLowerCase().includes(search) || String(run.id).toLowerCase().includes(search);
    });
    sendJson(res, 200, { runs, total: runs.length });
    return true;
  }

  if (req.method === 'GET' && /^\/dashboard\/runs\/[^/]+$/u.test(pathname)) {
    const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/runs\//u, ''));
    const detail = buildDashboardRunDetail(runtimeRoot, runId);
    if (!detail) {
      sendJson(res, 404, { error: 'Run not found.' });
      return true;
    }
    sendJson(res, 200, detail);
    return true;
  }

  if (req.method === 'GET' && pathname === '/dashboard/metrics/timeseries') {
    const idleSummaryDatabase = fs.existsSync(idleSummarySnapshotsPath) ? getIdleSummaryDatabase(ctx) : null;
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

  return false;
}
