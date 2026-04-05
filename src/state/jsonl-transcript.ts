import * as fs from 'node:fs';

type Dict = Record<string, unknown>;

export type JsonlEvent = { kind: string; at: string | null; payload: Dict };

export function readJsonlEvents(transcriptPath: string | null): JsonlEvent[] {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
    return [];
  }
  const content = fs.readFileSync(transcriptPath, 'utf8');
  const results: JsonlEvent[] = [];
  for (const raw of content.split(/\r?\n/gu)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Dict;
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
