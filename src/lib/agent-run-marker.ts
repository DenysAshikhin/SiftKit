/**
 * Marker identifying processes spawned from inside a repo-agent run. The
 * engine sets the env var on every `run`/command child; the CLI refuses (or
 * degrades) server calls when it is present, and forwards it as a header so
 * the server can reject self-lineage requests instead of deadlocking.
 */
export const AGENT_RUN_ID_ENV = 'SIFTKIT_AGENT_RUN_ID';
export const AGENT_RUN_ID_HEADER = 'x-siftkit-agent-run-id';

export function readNestedAgentRunId(): string | null {
  const value = (process.env[AGENT_RUN_ID_ENV] || '').trim();
  return value ? value : null;
}
