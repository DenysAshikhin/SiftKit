import { z } from './zod.js';
import { JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from './json-types.js';

function normalizeJsonText(text: string): string {
  const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  return normalized;
}

export function parseJsonText<T>(text: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(normalizeJsonText(text)));
}

export function parseJsonValueText(text: string): JsonValue {
  return JsonValueSchema.parse(JSON.parse(normalizeJsonText(text)));
}

export function parseJsonObjectText(text: string): JsonObject {
  return JsonObjectSchema.parse(JSON.parse(normalizeJsonText(text)));
}

/** Feeds exactly the bytes of stableStringify(value) to a sink without assembling the whole string. */
export function writeStableJson(value: JsonValue, write: (chunk: string) => void): void {
  if (value === null || typeof value !== 'object') { write(JSON.stringify(value)); return; }
  if (Array.isArray(value)) {
    write('[');
    value.forEach((item, index) => { if (index > 0) write(','); writeStableJson(item, write); });
    write(']');
    return;
  }
  write('{');
  Object.keys(value).sort().forEach((key, index) => {
    if (index > 0) write(',');
    write(`${JSON.stringify(key)}:`);
    writeStableJson(value[key] ?? null, write);
  });
  write('}');
}

export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] ?? null)}`);
  return `{${entries.join(',')}}`;
}
