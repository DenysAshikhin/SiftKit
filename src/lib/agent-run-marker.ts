/**
 * Marker identifying processes spawned from inside an agent run. The engine sets both env vars on
 * every `run` child; the CLI refuses (or degrades) calls to the server whose model lock the
 * run holds, and forwards the run ID as a header so that server can reject self-lineage requests.
 */
export const AGENT_RUN_ID_ENV = 'SIFTKIT_AGENT_RUN_ID';
/** The status server that holds the marked run's model lock; another server is not nested. */
export const AGENT_SERVER_URL_ENV = 'SIFTKIT_AGENT_SERVER_URL';
export const AGENT_RUN_ID_HEADER = 'x-siftkit-agent-run-id';

/** The env a spawned command inherits from the agent run that owns it. */
export function buildAgentRunEnv(runId: string, serverUrl: string): Record<string, string> {
  return { [AGENT_RUN_ID_ENV]: runId, [AGENT_SERVER_URL_ENV]: serverUrl };
}

/** The agent run this process is nested in, when `targetStatusUrl` is the server that holds its model lock. */
export function readNestedAgentRunId(targetStatusUrl: string): string | null {
  const runId = (process.env[AGENT_RUN_ID_ENV] || '').trim();
  if (!runId) return null;
  const serverUrl = (process.env[AGENT_SERVER_URL_ENV] || '').trim();
  if (!serverUrl) throw new Error(`${AGENT_RUN_ID_ENV} is set without ${AGENT_SERVER_URL_ENV}; the nested-run marker is incomplete.`);
  return new URL(serverUrl).origin === new URL(targetStatusUrl).origin ? runId : null;
}
