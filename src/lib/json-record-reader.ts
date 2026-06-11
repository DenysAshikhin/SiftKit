import type { JsonObject, JsonValue, MutableJsonObject } from './json-types.js';

export class JsonRecordReader {
  public readonly record: JsonObject;

  public constructor(record: JsonObject) {
    this.record = record;
  }

  public static fromUnknown(value: unknown): JsonRecordReader {
    return new JsonRecordReader(JsonRecordReader.asObject(value) || {});
  }

  public static asObject(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : null;
  }

  public static parseObjectText(text: string | null): JsonObject | null {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }
    const parsed = JSON.parse(text) as unknown;
    return JsonRecordReader.asObject(parsed);
  }

  public value(key: string): JsonValue | undefined {
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
