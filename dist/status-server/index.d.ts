import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import { getStatusPath, getConfigPath, getMetricsPath, getIdleSummarySnapshotsPath } from './paths.js';
import { type ColorOptions, supportsAnsiColor, colorize, formatElapsed } from './formatting.js';
import { type RequestJsonOptions, type JsonResponse } from './http-utils.js';
import { type StatusMetadata } from './status-file.js';
import { type Metrics } from './metrics.js';
import { type IdleSummarySnapshot, buildIdleSummarySnapshot, buildIdleMetricsLogMessage } from './idle-summary.js';
import { type ManagedLlamaConfig } from './config-store.js';
import { type StatusRequestLogInput, type RepoSearchProgressEvent, type RunRecord, type DailyMetrics, buildStatusRequestLogMessage, buildRepoSearchProgressLogMessage, getStatusArtifactPath, loadDashboardRuns, buildDashboardRunDetail, buildDashboardDailyMetrics, normalizeIdleSummarySnapshotRow } from './dashboard-runs.js';
export { getStatusPath, getConfigPath, getMetricsPath, getIdleSummarySnapshotsPath, supportsAnsiColor, colorize, formatElapsed, buildIdleSummarySnapshot, buildIdleMetricsLogMessage, };
export { buildStatusRequestLogMessage, buildRepoSearchProgressLogMessage, getStatusArtifactPath, loadDashboardRuns, buildDashboardRunDetail, buildDashboardDailyMetrics, normalizeIdleSummarySnapshotRow, };
export type { StatusRequestLogInput, RepoSearchProgressEvent, RunRecord, DailyMetrics, };
export type { ColorOptions, IdleSummarySnapshot, StatusMetadata, Metrics, RequestJsonOptions, JsonResponse, ManagedLlamaConfig };
export type TerminateProcessTreeOptions = {
    processObject?: {
        platform: string;
        kill: (pid: number, signal?: string) => boolean;
    };
    spawnSyncImpl?: typeof spawnSync;
};
export declare function terminateProcessTree(pid: number | string, options?: TerminateProcessTreeOptions): boolean;
export type StartStatusServerOptions = {
    disableManagedLlamaStartup?: boolean;
};
type ExtendedServer = http.Server & {
    shutdownManagedLlamaForServerExit?: () => Promise<void>;
    shutdownManagedLlamaForProcessExitSync?: () => void;
    startupPromise?: Promise<void>;
};
export declare function startStatusServer(options?: StartStatusServerOptions): ExtendedServer;
