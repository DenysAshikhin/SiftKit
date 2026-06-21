import { JsonObjectSchema, type JsonObject, type MutableJsonObject, type OptionalJsonValue } from './json-types.js';
import { parseJsonValueText } from './json.js';

export class JsonRecordReader {
  public readonly record: JsonObject;

  public constructor(record: JsonObject) {
    this.record = record;
  }

  // asObject/fromJsonValue are the JSON-object validation boundary: they accept
  // an arbitrary runtime value and validate it into a concrete JsonObject via
  // JsonObjectSchema. `unknown` is the only honest input type for a validator
  // and is immediately schema-checked here; eslint permits it for this file
  // alone (see eslint.config.mjs).
  public static fromJsonValue(value: unknown): JsonRecordReader {
    return new JsonRecordReader(JsonRecordReader.asObject(value) || {});
  }

  public static asObject(value: unknown): JsonObject | null {
    const parsed = JsonObjectSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  public static parseObjectText(text: string | null): JsonObject | null {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }
    const parsed = parseJsonValueText(text);
    return JsonRecordReader.asObject(parsed);
  }

  public value(key: string): OptionalJsonValue {
    return this.record[key];
  }

  public string(key: string, fallback: string = ''): string {
    const value = this.value(key);
    return typeof value === 'string' ? value.trim() : fallback;
  }

  public optionalString(key: string): string | undefined {
    const value = this.string(key);
    return value ? value : undefined;
  }

  public nullableString(key: string): string | null {
    return this.optionalString(key) || null;
  }

  public boolean(key: string, fallback: boolean): boolean {
    const value = this.value(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  public number(key: string): number | null {
    const value = this.value(key);
    if (typeof value !== 'number' && typeof value !== 'string') {
      return null;
    }
    if (typeof value === 'string' && !value.trim()) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  public positiveNumber(key: string, fallback: number): number {
    const parsed = this.number(key);
    return parsed !== null && parsed > 0 ? parsed : fallback;
  }

  public nonNegativeInteger(key: string, fallback: number): number {
    const parsed = this.number(key);
    return parsed !== null && parsed >= 0 ? Math.trunc(parsed) : fallback;
  }

  public nullableNonNegativeInteger(key: string): number | null {
    const parsed = this.number(key);
    return parsed !== null && parsed >= 0 ? Math.trunc(parsed) : null;
  }

  public nullableNonNegativeNumber(key: string): number | null {
    const parsed = this.number(key);
    return parsed !== null && parsed >= 0 ? parsed : null;
  }

  public object(key: string): JsonObject | null {
    return JsonRecordReader.asObject(this.value(key));
  }

  public stringArray(key: string): string[] {
    const value = this.value(key);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  public mutableCopy(): MutableJsonObject {
    return { ...this.record };
  }
}
