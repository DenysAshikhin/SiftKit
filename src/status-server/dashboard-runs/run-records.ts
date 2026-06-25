import { JsonRecordReader } from '../../lib/json-record-reader.js';
import { parseJsonValueText } from '../../lib/json.js';
import type { JsonObject, OptionalJsonValue } from '../../lib/json-types.js';
import { toNullableNonNegativeInteger } from '../../lib/telemetry-metrics.js';
import type { JsonlEvent } from '../../state/jsonl-transcript.js';
import type { RunLogDbRow, RunRecord } from './types.js';

function optionalStringField(value: OptionalJsonValue): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function normalizeRunRecord(record: JsonObject): RunRecord {
  return {
    id: String(record.id),
    kind: String(record.kind),
    status: String(record.status),
    startedAtUtc: optionalStringField(record.startedAtUtc),
    finishedAtUtc: optionalStringField(record.finishedAtUtc),
    title: String(record.title || ''),
    model: optionalStringField(record.model),
    backend: optionalStringField(record.backend),
    inputTokens: Number.isFinite(record.inputTokens) ? Number(record.inputTokens) : null,
    outputTokens: Number.isFinite(record.outputTokens) ? Number(record.outputTokens) : null,
    thinkingTokens: Number.isFinite(record.thinkingTokens) ? Number(record.thinkingTokens) : null,
    toolTokens: Number.isFinite(record.toolTokens) ? Number(record.toolTokens) : null,
    promptCacheTokens: Number.isFinite(record.promptCacheTokens) ? Number(record.promptCacheTokens) : null,
    promptEvalTokens: Number.isFinite(record.promptEvalTokens) ? Number(record.promptEvalTokens) : null,
    promptEvalDurationMs: Number.isFinite(record.promptEvalDurationMs) ? Number(record.promptEvalDurationMs) : null,
    generationDurationMs: Number.isFinite(record.generationDurationMs) ? Number(record.generationDurationMs) : null,
    speculativeAcceptedTokens: Number.isFinite(record.speculativeAcceptedTokens) ? Number(record.speculativeAcceptedTokens) : null,
    speculativeGeneratedTokens: Number.isFinite(record.speculativeGeneratedTokens) ? Number(record.speculativeGeneratedTokens) : null,
    durationMs: Number.isFinite(record.durationMs) ? Number(record.durationMs) : null,
    providerDurationMs: Number.isFinite(record.providerDurationMs) ? Number(record.providerDurationMs) : null,
    wallDurationMs: Number.isFinite(record.wallDurationMs) ? Number(record.wallDurationMs) : null,
    rawPaths: JsonRecordReader.asObject(record.rawPaths) || {},
  };
}

export function parseJsonObjectText(text: string | null): JsonObject | null {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  try {
    return JsonRecordReader.parseObjectText(text);
  } catch {
    return null;
  }
}

export function parseJsonlEventsFromText(text: string | null): JsonlEvent[] {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }
  const events: JsonlEvent[] = [];
  for (const raw of text.split(/\r?\n/gu)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = parseJsonValueText(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      const payload = JsonRecordReader.asObject(parsed);
      if (!payload) {
        continue;
      }
      events.push({
        kind: typeof payload.kind === 'string' ? payload.kind : 'event',
        at: typeof payload.at === 'string' ? payload.at : null,
        payload,
      });
    } catch {
      // ignore malformed lines
    }
  }
  return events;
}

export function getTranscriptDurationMsFromText(text: string | null): number | null {
  const events = parseJsonlEventsFromText(text);
  const points = events
    .map((event) => Date.parse(event.at || ''))
    .filter((value) => Number.isFinite(value));
  if (points.length < 2) {
    return null;
  }
  return Math.max(0, Math.max(...points) - Math.min(...points));
}

export function parseOptionalIsoDate(value: OptionalJsonValue): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeStatusForRunRecord(terminalState: string): string {
  if (terminalState === 'abandoned') {
    return 'failed';
  }
  if (terminalState === 'completed' || terminalState === 'failed') {
    return terminalState;
  }
  return 'running';
}

export function normalizeRunRecordFromDbRow(row: RunLogDbRow): RunRecord {
  return normalizeRunRecord({
    id: String(row.run_id || ''),
    kind: String(row.run_kind || 'unknown'),
    status: normalizeStatusForRunRecord(String(row.terminal_state || 'unknown')),
    startedAtUtc: typeof row.started_at_utc === 'string' ? row.started_at_utc : null,
    finishedAtUtc: typeof row.finished_at_utc === 'string' ? row.finished_at_utc : null,
    title: String(row.title || ''),
    model: typeof row.model === 'string' ? row.model : null,
    backend: typeof row.backend === 'string' ? row.backend : null,
    inputTokens: toNullableNonNegativeInteger(row.input_tokens),
    outputTokens: toNullableNonNegativeInteger(row.output_tokens),
    thinkingTokens: toNullableNonNegativeInteger(row.thinking_tokens),
    toolTokens: toNullableNonNegativeInteger(row.tool_tokens),
    promptCacheTokens: toNullableNonNegativeInteger(row.prompt_cache_tokens),
    promptEvalTokens: toNullableNonNegativeInteger(row.prompt_eval_tokens),
    promptEvalDurationMs: toNullableNonNegativeInteger(row.prompt_eval_duration_ms),
    generationDurationMs: toNullableNonNegativeInteger(row.generation_duration_ms),
    speculativeAcceptedTokens: toNullableNonNegativeInteger(row.speculative_accepted_tokens),
    speculativeGeneratedTokens: toNullableNonNegativeInteger(row.speculative_generated_tokens),
    durationMs: toNullableNonNegativeInteger(row.wall_duration_ms) ?? toNullableNonNegativeInteger(row.duration_ms),
    providerDurationMs: toNullableNonNegativeInteger(row.provider_duration_ms) ?? toNullableNonNegativeInteger(row.duration_ms),
    wallDurationMs: toNullableNonNegativeInteger(row.wall_duration_ms),
    rawPaths: {},
  });
}
