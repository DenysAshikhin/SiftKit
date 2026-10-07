import type { RuntimeDatabase } from '../../src/state/runtime-db.ts';
import { readChatToolResultsFromTranscript, readChatToolTranscript } from '../../src/status-server/chat-tool-results.ts';

/** Reads a run's durable tool outcomes straight from its stored transcript. */
export function readChatToolResults(database: RuntimeDatabase, requestId: string) {
  return readChatToolResultsFromTranscript(readChatToolTranscript(database, requestId));
}
