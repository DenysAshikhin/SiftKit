import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import { getStatusPath, getConfigPath, getMetricsPath, getIdleSummarySnapshotsPath } from './paths.js';
import { type ColorOptions, supportsAnsiColor, colorize, formatElapsed } from './formatting.js';
import { type RequestJsonOptions, type JsonResponse } from './http-utils.js';
import { type StatusMetadata } from './status-file.js';
import { type Metrics } from './metrics.js';
import { type IdleSummarySnapshot, buildIdleSummarySnapshot, buildIdleMetricsLogMessage } from './idle-summary.js';
import { type ManagedLlamaConfig } from './config-store.js';
export { getStatusPath, getConfigPath, getMetricsPath, getIdleSummarySnapshotsPath, supportsAnsiColor, colorize, formatElapsed, buildIdleSummarySnapshot, buildIdleMetricsLogMessage, };
export type { ColorOptions, IdleSummarySnapshot, StatusMetadata, Metrics, RequestJsonOptions, JsonResponse, ManagedLlamaConfig };
export type TerminateProcessTreeOptions = {
    processObject?: {
        platform: string;
        kill: (pid: number, signal?: string) => boolean;
    };
    spawnSyncImpl?: typeof spawnSync;
};
export declare function terminateProcessTree(pid: number | string, options?: TerminateProcessTreeOptions): boolean;
export type StatusRequestLogInput = {
    running: boolean;
    statusPath?: string;
    requestId?: string | null;
    terminalState?: string | null;
    errorMessage?: string | null;
    characterCount?: number | null;
    promptCharacterCount?: number | null;
    promptTokenCount?: number | null;
    rawInputCharacterCount?: number | null;
    chunkInputCharacterCount?: number | null;
    budgetSource?: string | null;
    inputCharactersPerContextToken?: number | null;
    chunkThresholdCharacters?: number | null;
    chunkIndex?: number | null;
    chunkTotal?: number | null;
    chunkPath?: string | null;
    elapsedMs?: number | null;
    totalElapsedMs?: number | null;
    outputTokens?: number | null;
    totalOutputTokens?: number | null;
};
export declare function buildStatusRequestLogMessage(input: StatusRequestLogInput): string;
export type RepoSearchProgressEvent = {
    command?: unknown;
    turn?: unknown;
    maxTurns?: unknown;
    promptTokenCount?: unknown;
    elapsedMs?: unknown;
    kind?: string;
    thinkingText?: string;
    exitCode?: number | null;
    outputSnippet?: string;
};
export declare function buildRepoSearchProgressLogMessage(event: RepoSearchProgressEvent | null | undefined, mode: string): string | null;
export type StartStatusServerOptions = {
    disableManagedLlamaStartup?: boolean;
};
type ExtendedServer = http.Server & {
    shutdownManagedLlamaForServerExit?: () => Promise<void>;
    shutdownManagedLlamaForProcessExitSync?: () => void;
    startupPromise?: Promise<void>;
};
export declare function startStatusServer(options?: StartStatusServerOptions): ExtendedServer;
