import { JsonObjectSchema, type JsonObject, type JsonSerializable } from '../../src/lib/json-types.js';

// Logged events may carry undefined-valued fields; the real JSONL logger drops
// them via JSON.stringify, so normalize the same way before schema-validating.
export function parseLoggedEvent(event: Record<string, JsonSerializable>): JsonObject {
  return JsonObjectSchema.parse(JSON.parse(JSON.stringify(event)));
}
