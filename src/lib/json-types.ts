export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];

export type MutableJsonObject = { [key: string]: JsonValue };
export type MutableJsonArray = JsonValue[];
