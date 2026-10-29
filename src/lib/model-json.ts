import { jsonrepair } from 'jsonrepair';

import { SummaryClassificationSchema } from '../planner-protocol/summary-tools.ts';
import type { StructuredModelDecision } from '../summary/types.ts';
import { getErrorMessage } from './errors.ts';
import { z } from './zod.ts';
import { JsonRecordReader } from './json-record-reader.ts';
import {
  JsonValueSchema,
  type JsonObject,
  type JsonValue,
  type OptionalJsonValue,
} from './json-types.ts';

type ParsedJsonValue = {
  value: JsonValue;
  repaired: boolean;
  synthesizedNull: boolean;
};

type ParsedModelObject = {
  value: JsonObject;
  repaired: boolean;
  synthesizedNull: boolean;
};

function removeKeys(value: JsonValue, path: readonly PropertyKey[], keys: readonly string[]): JsonValue {
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    return typeof head === 'number' ? value.map((entry, index) => (index === head ? removeKeys(entry, rest, keys) : entry)) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (head === undefined) return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  if (typeof head !== 'string') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === head ? removeKeys(entry, rest, keys) : entry]));
}

export class ModelJson {
  static parseSummaryDecision(text: string): StructuredModelDecision {
    const parsed = this.parseModelObject(text, 'SiftKit decision').value;
    return this.validateSummaryDecision(parsed);
  }

  /**
   * A model's typed JSON answer: the object itself, or the one embedded after prose or in a fence.
   * Keys the schema does not define are dropped; values are still validated, and a repair that invents a value is rejected.
   */
  static parseObject<T>(text: string, schema: z.ZodType<T>, payloadName: string): T {
    const parsed = this.parseModelObject(text, payloadName);
    if (parsed.repaired && parsed.synthesizedNull) {
      throw new Error(`Provider returned an invalid ${payloadName} payload: JSON repair synthesized a missing value.`);
    }
    const result = schema.safeParse(this.withoutUnrecognizedKeys(parsed.value, schema));
    if (!result.success) throw new Error(`Provider returned an invalid ${payloadName} payload: ${z.prettifyError(result.error)}`);
    return result.data;
  }

  /** Text starting with an object is the answer; otherwise the last fenced object, else the outermost braces. */
  private static answerObjectText(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return trimmed;
    const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu)]
      .map((match) => (match[1] ?? '').trim())
      .filter((candidate) => candidate.startsWith('{'));
    const lastFenced = fenced[fenced.length - 1];
    if (lastFenced !== undefined) return lastFenced;
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  }

  /** Removes the keys the schema reports as unrecognized (one parse reports every depth); other issues stay for the caller. */
  private static withoutUnrecognizedKeys<T>(value: JsonObject, schema: z.ZodType<T>): JsonValue {
    const result = schema.safeParse(value);
    if (result.success || !result.error.issues.every((issue) => issue.code === 'unrecognized_keys')) return value;
    let current: JsonValue = value;
    for (const issue of result.error.issues) {
      if (issue.code === 'unrecognized_keys') current = removeKeys(current, issue.path, issue.keys);
    }
    return current;
  }

  static parseToolArguments(value: OptionalJsonValue): JsonObject | null {
    if (typeof value === 'string') {
      try {
        return this.parseToolArgumentsText(value);
      } catch {
        return null;
      }
    }
    return this.getRecord(value);
  }

  private static parseToolArgumentsText(text: string): JsonObject | null {
    const parsed = this.parseJsonValue(text, 'tool arguments');
    if (parsed.repaired && parsed.synthesizedNull) {
      throw new Error('Provider returned invalid tool arguments: JSON repair synthesized a missing value.');
    }
    if (typeof parsed.value === 'string') {
      const nested = this.parseJsonValue(parsed.value, 'tool arguments');
      if (nested.repaired && nested.synthesizedNull) {
        throw new Error('Provider returned invalid tool arguments: JSON repair synthesized a missing value.');
      }
      return this.getRecord(nested.value);
    }
    return this.getRecord(parsed.value);
  }

  private static parseModelObject(text: string, payloadName: string): ParsedModelObject {
    const parsed = this.parseJsonValue(this.answerObjectText(text), payloadName);
    const record = this.getRecord(parsed.value);
    if (!record) {
      throw new Error(`Provider returned an invalid ${payloadName} payload: expected JSON object.`);
    }
    return {
      value: record,
      repaired: parsed.repaired,
      synthesizedNull: parsed.synthesizedNull,
    };
  }

  private static parseJsonValue(text: string, payloadName: string): ParsedJsonValue {
    const normalized = String(text || '').trim();
    try {
      return {
        value: JsonValueSchema.parse(JSON.parse(normalized)),
        repaired: false,
        synthesizedNull: false,
      };
    } catch (strictError) {
      try {
        const value = JsonValueSchema.parse(JSON.parse(jsonrepair(this.keepRawBackslashes(normalized))));
        return {
          value,
          repaired: true,
          synthesizedNull: this.countNullValues(value) > this.countUnquotedNullTokens(normalized),
        };
      } catch (repairError) {
        const message = getErrorMessage(repairError) || getErrorMessage(strictError) || 'unknown error';
        throw new Error(`Provider returned an invalid ${payloadName} payload: ${message}`);
      }
    }
  }

  /**
   * Models write Windows paths with raw backslashes. A string holding an escape JSON lacks (`\s`, `\U`) was written
   * raw, so every backslash in it is kept literally except before a quote or another backslash; repair would drop them.
   */
  private static keepRawBackslashes(text: string): string {
    return text.replace(/"(?:[^"\\]|\\.)*"/gsu, (literal) => {
      const raw = [...literal.matchAll(/\\(u[0-9a-fA-F]{4}|.)/gsu)].some(([, escape]) => escape !== undefined
        && escape.length === 1 && !'"\\/bfnrt'.includes(escape));
      return raw ? literal.replace(/\\(.)/gsu, (escape, next: string) => (next === '"' || next === '\\' ? escape : `\\\\${next}`)) : literal;
    });
  }

  private static countNullValues(value: JsonValue): number {
    if (value === null) return 1;
    if (Array.isArray(value)) {
      let count = 0;
      for (const entry of value) count += this.countNullValues(entry);
      return count;
    }
    if (typeof value === 'object') {
      let count = 0;
      for (const entry of Object.values(value)) count += this.countNullValues(entry);
      return count;
    }
    return 0;
  }

  private static countUnquotedNullTokens(text: string): number {
    let count = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (lineComment) {
        if (char === '\n' || char === '\r') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === '*' && text[index + 1] === '/') {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '/' && text[index + 1] === '/') {
        lineComment = true;
        index += 1;
        continue;
      }
      if (char === '/' && text[index + 1] === '*') {
        blockComment = true;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (
        text.slice(index, index + 4) === 'null'
        && !this.isIdentifierCharacter(text[index - 1])
        && !this.isIdentifierCharacter(text[index + 4])
      ) {
        count += 1;
        index += 3;
      }
    }
    return count;
  }

  private static isIdentifierCharacter(value: string | undefined): boolean {
    return typeof value === 'string' && /[\p{L}\p{N}_$]/u.test(value);
  }

  private static getRecord(value: OptionalJsonValue): JsonObject | null {
    return JsonRecordReader.asObject(value);
  }

  private static validateSummaryDecision(parsed: JsonObject): StructuredModelDecision {
    const classification = this.getClassification(parsed.classification);
    if (!classification) {
      throw new Error('Provider returned an invalid SiftKit decision classification.');
    }
    const output = typeof parsed.output === 'string' ? parsed.output.trim() : '';
    if (!output) {
      throw new Error('Provider returned an empty SiftKit decision output.');
    }
    return {
      classification,
      rawReviewRequired: Boolean(parsed.raw_review_required ?? parsed.rawReviewRequired ?? false),
      output,
    };
  }

  private static getClassification(value?: JsonValue) {
    const parsed = SummaryClassificationSchema.safeParse(
      typeof value === 'string' ? value.trim().toLowerCase() : '',
    );
    return parsed.success ? parsed.data : null;
  }
}
