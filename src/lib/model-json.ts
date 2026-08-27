import { jsonrepair } from 'jsonrepair';

import { SummaryClassificationSchema } from '../planner-protocol/summary-tools.js';
import type { StructuredModelDecision } from '../summary/types.js';
import { getErrorMessage } from './errors.js';
import { JsonRecordReader } from './json-record-reader.js';
import {
  JsonValueSchema,
  type JsonObject,
  type JsonValue,
  type OptionalJsonValue,
} from './json-types.js';
import { stripCodeFence } from './text-format.js';

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

export class ModelJson {
  static parseSummaryDecision(text: string): StructuredModelDecision {
    const parsed = this.parseModelObject(text, 'SiftKit decision').value;
    return this.validateSummaryDecision(parsed);
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
    const parsed = this.parseJsonValue(stripCodeFence(text), payloadName);
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
        const value = JsonValueSchema.parse(JSON.parse(jsonrepair(normalized)));
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
