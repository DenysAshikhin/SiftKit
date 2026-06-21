import { z } from './zod.js';

export const JsonValueSchema = z.json();
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export const OptionalJsonValueSchema = JsonValueSchema.optional();

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = z.infer<typeof JsonValueSchema>;
export type JsonObject = z.infer<typeof JsonObjectSchema>;
export type OptionalJsonValue = z.infer<typeof OptionalJsonValueSchema>;
export type JsonArray = readonly JsonValue[];

export type MutableJsonObject = { [key: string]: JsonValue };
export type MutableJsonArray = JsonValue[];

// Runtime narrowing for an arbitrary JSON value down to a plain object. Used at
// boundaries that index dynamic keys off parsed JSON without a cast.
export function isJsonObject(value: OptionalJsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Input accepted by a JSON serializer (JSON.stringify). Unlike JsonValue it
// permits `undefined` (omitted object fields), so typed DTOs with optional
// properties are assignable without a cast at output boundaries like sendJson.
export type JsonSerializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonSerializable[]
  | { readonly [key: string]: JsonSerializable };
