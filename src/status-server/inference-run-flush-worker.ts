import { parentPort } from 'node:worker_threads';
import {
  appendInferenceRunLogChunk,
  updateInferenceRunSpeculativeMetrics,
  type InferenceRunPendingLogChunkEntry,
} from '../state/inference-runs.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../state/runtime-db.js';
import type { ManagedLlamaSpeculativeMetricsSnapshot } from './managed-llama-speculative-tracker.js';

type FlushWorkerRequest = {
  id: number;
  runId: string;
  databasePath: string;
  entries: InferenceRunPendingLogChunkEntry[];
  metricsSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null;
};

type FlushWorkerResponse = {
  id: number;
  ok: boolean;
  errorMessage?: string;
  metricsFlushed?: boolean;
};

function handleFlushRequest(message: FlushWorkerRequest): FlushWorkerResponse {
  const database = getRuntimeDatabase(message.databasePath);
  database.exec('PRAGMA busy_timeout = 1;');
  for (const entry of message.entries) {
    appendInferenceRunLogChunk({
      runId: message.runId,
      streamKind: entry.streamKind,
      chunkText: entry.chunkText,
      databasePath: message.databasePath,
    });
  }
  const metricsFlushed = message.metricsSnapshot
    ? updateInferenceRunSpeculativeMetrics({
      runId: message.runId,
      speculativeAcceptedTokens: message.metricsSnapshot.latestSpeculativeAcceptedTokens,
      speculativeGeneratedTokens: message.metricsSnapshot.latestSpeculativeGeneratedTokens,
      stdoutCharacterCount: message.metricsSnapshot.stdoutOffset,
      stderrCharacterCount: message.metricsSnapshot.stderrOffset,
      databasePath: message.databasePath,
    })
    : false;
  return {
    id: message.id,
    ok: true,
    metricsFlushed,
  };
}

parentPort?.on('message', (message: FlushWorkerRequest) => {
  let response: FlushWorkerResponse;
  try {
    response = handleFlushRequest(message);
  } catch (error) {
    response = {
      id: message.id,
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  // This worker is unref'ed and outlives server.close(); a cached connection would keep
  // runtime.sqlite open (blocking directory removal on Windows) until the thread dies.
  // Close BEFORE responding — the main thread may terminate the worker as soon as it sees
  // the response, and terminating mid-close crashes better-sqlite3.
  try {
    closeRuntimeDatabase();
  } catch {
    // Never let a close failure eat the flush result.
  }
  parentPort?.postMessage(response);
});
