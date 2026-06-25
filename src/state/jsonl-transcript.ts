import { existsSync, readFileSync } from 'node:fs';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import { parseJsonValueText } from '../lib/json.js';
import type { JsonObject } from '../lib/json-types.js';

export type JsonlEvent = { kind: string; at: string | null; payload: JsonObject };

export function readJsonlEvents(transcriptPath: string | null): JsonlEvent[] {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    return [];
  }
  const content = readFileSync(transcriptPath, 'utf8');
  const results: JsonlEvent[] = [];
  for (const raw of content.split(/\r?\n/gu)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JsonRecordReader.asObject(parseJsonValueText(line));
      if (!parsed) {
        continue;
      }
      results.push({
        kind: typeof parsed.kind === 'string' ? parsed.kind : 'event',
        at: typeof parsed.at === 'string' ? parsed.at : null,
        payload: parsed,
      });
    } catch {
      // skip malformed line
    }
  }
  return results;
}

export function getTranscriptDurationMs(transcriptPath: string | null): number | null {
  const events = readJsonlEvents(transcriptPath);
  const eventTimes = events
    .map((event) => Date.parse(event.at || ''))
    .filter((time) => Number.isFinite(time));
  if (eventTimes.length < 2) {
    return null;
  }
  return Math.max(0, Math.max(...eventTimes) - Math.min(...eventTimes));
}
