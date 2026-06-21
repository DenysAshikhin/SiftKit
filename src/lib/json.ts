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
