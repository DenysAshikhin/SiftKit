import { parentPort } from 'node:worker_threads';
import {
  appendInferenceRunLogChunk,
  type InferenceRunPendingLogChunkEntry,
} from '../state/inference-runs.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../state/runtime-db.js';

type FlushWorkerRequest = {
  id: number;
  runId: string;
  databasePath: string;
  entries: InferenceRunPendingLogChunkEntry[];
};

type FlushWorkerResponse = {
  id: number;
  ok: boolean;
  errorMessage?: string;
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
  return { id: message.id, ok: true };
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
  } catch (error) {
    // A close failure means the handle this worker was told to release is still open. It must
    // not eat the flush result, so report it on stderr (forwarded to the parent) and answer.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`inference run flush worker failed to close runtime.sqlite: ${message}\n`);
  }
  parentPort?.postMessage(response);
});
