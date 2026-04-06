/**
 * Resolved runtime directory layout. Produced by `initializeRuntime()` and
 * surfaced through `SiftConfig.Paths` for consumers that want the
 * pre-computed set.
 */
export type RuntimePaths = {
    RuntimeRoot: string;
    Logs: string;
    EvalFixtures: string;
    EvalResults: string;
};
export declare function getRepoLocalRuntimeRoot(): string | null;
export declare function getRepoLocalLogsPath(): string | null;
/**
 * Resolves the active runtime-root directory by inspecting (in order):
 *   1. `sift_kit_status` / `SIFTKIT_STATUS_PATH` env vars — the caller points
 *      at a status file, we walk up to find the runtime root containing
 *      `<root>/status/inference.txt`.
 *   2. The repo-local `.siftkit/` directory under the nearest SiftKit repo.
 *   3. `%USERPROFILE%/.siftkit`.
 *   4. `<cwd>/.codex/siftkit`.
 *   5. `%TEMP%/siftkit` as a last resort.
 *
 * Each candidate is tested for writability before being returned.
 */
export declare function getRuntimeRoot(): string;
/** Creates (mkdir -p) the standard runtime subdirectories and returns their paths. */
export declare function initializeRuntime(): RuntimePaths;
export declare function getConfigPath(): string;
export declare function getStatusDirectory(): string;
export declare function getInferenceStatusPath(): string;
export declare function getIdleSummarySnapshotsPath(): string;
export declare function getMetricsDirectory(): string;
export declare function getObservedBudgetStatePath(): string;
export declare function getCompressionMetricsPath(): string;
export declare function getRuntimeLogsPath(): string;
export declare function getSummaryRequestLogsDirectory(): string;
export declare function getSummaryRequestLogPath(requestId: string): string;
export declare function getPlannerFailedLogsDirectory(): string;
export declare function getPlannerFailedPath(requestId: string): string;
export declare function getPlannerDebugPath(requestId: string): string;
export declare function getAbandonedLogsDirectory(): string;
export declare function getAbandonedRequestPath(requestId: string): string;
export declare function getRepoSearchLogRoot(): string;
export declare function getRepoSearchSuccessfulDirectory(): string;
export declare function getRepoSearchFailedDirectory(): string;
export declare function getChatSessionsRoot(): string;
export declare function getChatSessionPath(sessionId: string): string;
