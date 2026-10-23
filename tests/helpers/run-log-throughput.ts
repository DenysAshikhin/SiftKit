import type { RuntimeDatabase } from '../../src/state/database-handle.ts';

function metric([tokenCount, durationMs]: readonly [number, number]) {
  return { tokenCount, durationMs, tabbyWeightedTokens: tokenCount, tabbyDurationMs: durationMs, requestCount: 1,
    missingInternalRequests: 0, missingTabbyRequests: 0 };
}

/** A completed run log with measured prefill and decode, each given as [tokens, duration ms]. */
export function seedRunLogThroughput(
  database: RuntimeDatabase, runId: string, pp: readonly [number, number], decode: readonly [number, number],
): void {
  database.prepare(`INSERT INTO run_logs (run_id, request_id, run_kind, run_group, terminal_state, title, source_paths_json, flushed_at_utc, throughput_json)
    VALUES (?, ?, 'repo_search', 'repo_search', 'completed', 'run', '[]', '2026-10-23T00:00:00.000Z', ?)`)
    .run(runId, runId, JSON.stringify({ pp: metric(pp), decode: metric(decode) }));
}
