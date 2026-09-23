import type { ChatMessage } from '../types';

type CompactionFold = { kind: 'compaction'; key: string; originals: ChatMessage[]; summary: ChatMessage | null };

export type CompactionSegment =
  | CompactionFold
  | { kind: 'messages'; key: string; messages: ChatMessage[] };

/**
 * Splits a transcript at each compaction summary. The rows a summary replaced fold behind it, and
 * rows the model still sees follow it, so every compaction keeps its own place in the conversation.
 */
export function buildCompactionSegments(messages: readonly ChatMessage[]): CompactionSegment[] {
  const segments: CompactionSegment[] = [];
  let lastFold: CompactionFold | null = null;
  let originals: ChatMessage[] = [];
  let retained: ChatMessage[] = [];
  for (const message of messages) {
    if (message.kind === 'compaction_summary') {
      lastFold = { kind: 'compaction', key: `compaction:${message.id}`, originals, summary: message };
      segments.push(lastFold);
      if (retained.length > 0) segments.push({ kind: 'messages', key: `messages:${segments.length}`, messages: retained });
      originals = [];
      retained = [];
    } else if (message.compressedIntoSummary === true) {
      originals.push(message);
    } else {
      retained.push(message);
    }
  }
  // Flagged rows after the last summary belong to it; with no summary at all they fold on their own.
  if (originals.length > 0 && lastFold) lastFold.originals.push(...originals);
  else if (originals.length > 0) segments.push({ kind: 'compaction', key: `compaction:orphan:${segments.length}`, originals, summary: null });
  if (retained.length > 0) segments.push({ kind: 'messages', key: `messages:${segments.length}`, messages: retained });
  return segments;
}

/** Applies the server's report that the running operation compacted every earlier run's rows. */
export function markEarlierRunsCompacted(persisted: ChatMessage[], compactedEarlierHistory: boolean): ChatMessage[] {
  return compactedEarlierHistory
    ? persisted.map((message) => message.compressedIntoSummary === true ? message : { ...message, compressedIntoSummary: true })
    : persisted;
}
