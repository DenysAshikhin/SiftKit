import { parentPort } from 'node:worker_threads';
import {
  appendManagedLlamaLogChunk,
  updateManagedLlamaRunSpeculativeMetrics,
  type ManagedLlamaPendingLogChunkEntry,
} from '../state/managed-llama-runs.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import type { ManagedLlamaSpeculativeMetricsSnapshot } from './managed-llama-speculative-tracker.js';

type FlushWorkerRequest = {
  id: number;
  runId: string;
  databasePath: string;
  entries: ManagedLlamaPendingLogChunkEntry[];
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
    appendManagedLlamaLogChunk({
      runId: message.runId,
      streamKind: entry.streamKind,
      chunkText: entry.chunkText,
      databasePath: message.databasePath,
    });
  }
  const metricsFlushed = message.metricsSnapshot
    ? updateManagedLlamaRunSpeculativeMetrics({
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
  try {
    parentPort?.postMessage(handleFlushRequest(message));
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    } satisfies FlushWorkerResponse);
  }
});
