import type { RuntimeDatabase } from '../../src/state/runtime-db.js';
import { readChatToolResultsFromTranscript, readChatToolTranscript } from '../../src/status-server/chat-tool-results.js';

/** Reads a run's durable tool outcomes straight from its stored transcript. */
export function readChatToolResults(database: RuntimeDatabase, requestId: string) {
  return readChatToolResultsFromTranscript(readChatToolTranscript(database, requestId));
}
