import { jsonrepair } from 'jsonrepair';

import {
  parseRepoSearchPlannerAction,
  type RepoSearchPlannerAction,
} from '../planner-protocol/repo-search.js';
import {
  parseSummaryPlannerAction,
  SummaryClassificationSchema,
  type SummaryPlannerAction,
  type SummaryPlannerParseOptions,
} from '../planner-protocol/summary.js';
import type {
  FinishValidationResult,
} from '../repo-search/planner-protocol.js';
import type {
  StructuredModelDecision,
} from '../summary/types.js';
import type { PlannerToolDefinition } from '../planner-protocol/json-schema.js';
import { getErrorMessage } from './errors.js';
import { JsonRecordReader } from './json-record-reader.js';
import {
  JsonValueSchema,
  type JsonObject,
  type JsonValue,
  type OptionalJsonValue,
} from './json-types.js';
import { stripCodeFence } from './text-format.js';

type RepoPlannerParserOptions = {
  toolDefinitions: readonly PlannerToolDefinition[];
};

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

const JSON_ESCAPE_CHARS: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
};

/**
 * Incrementally decodes the streamed value of a finish action's "output"
 * string over append-only accumulated content. Action classification,
 * output-marker detection, and value decoding all consume only newly
 * appended characters. A push shorter than the previous one resets the
 * state for early-stop truncation.
 */
const ACTION_FIELD_KEY = 'action';
const OUTPUT_FIELD_KEY = 'output';
const JSON_WHITESPACE_CHAR = /\s/u;
const JSON_UNICODE_ESCAPE = /^[0-9a-fA-F]{4}$/u;

type FinishOutputStage = 'scanning' | 'non-finish' | 'closed' | 'stalled';
type JsonEscapeStage = 'plain' | 'escape' | 'unicode';
type JsonStringRole = 'key' | 'action' | 'output' | 'ignored';

export class StreamingFinishOutputExtractor {
  private scannedTo = 0;
  private stage: FinishOutputStage = 'scanning';
  private depth = 0;
  private expectsTopLevelKey = false;
  private expectsTopLevelValue = false;
  private topLevelKey: string | null = null;
  private stringRole: JsonStringRole | null = null;
  private stringValue = '';
  private escapeStage: JsonEscapeStage = 'plain';
  private unicodeHex = '';
  private actionIsFinish = false;
  private outputStarted = false;
  private outputClosed = false;
  private decoded = '';

  push(text: string): string | null {
    if (text.length < this.scannedTo) {
      this.resetState();
    }
    if (this.isTerminal()) {
      this.scannedTo = text.length;
      return this.result();
    }
    for (let index = this.scannedTo; index < text.length; index += 1) {
      this.scanChar(text[index]);
      if (this.isTerminal()) {
        break;
      }
    }
    this.scannedTo = text.length;
    return this.result();
  }

  private scanChar(char: string): void {
    if (this.stringRole !== null) {
      this.scanStringChar(char);
      return;
    }
    if (char === '"') {
      this.startString();
      return;
    }
    if (this.depth === 0) {
      if (char === '{') {
        this.depth = 1;
        this.expectsTopLevelKey = true;
      }
      return;
    }
    if (this.depth === 1 && this.expectsTopLevelValue && !JSON_WHITESPACE_CHAR.test(char)) {
      this.expectsTopLevelValue = false;
      if (this.topLevelKey === ACTION_FIELD_KEY) {
        this.stage = 'non-finish';
        return;
      }
    }
    if (char === '{' || char === '[') {
      this.depth += 1;
    } else if (char === '}' || char === ']') {
      this.depth -= 1;
    } else if (this.depth === 1 && char === ':' && this.topLevelKey !== null) {
      this.expectsTopLevelValue = true;
    } else if (this.depth === 1 && char === ',') {
      this.topLevelKey = null;
      this.expectsTopLevelKey = true;
    }
  }

  private startString(): void {
    if (this.depth === 1 && this.expectsTopLevelKey) {
      this.stringRole = 'key';
      this.expectsTopLevelKey = false;
    } else if (this.depth === 1 && this.expectsTopLevelValue) {
      this.expectsTopLevelValue = false;
      if (this.topLevelKey === ACTION_FIELD_KEY) {
        this.stringRole = 'action';
      } else if (this.topLevelKey === OUTPUT_FIELD_KEY) {
        this.stringRole = 'output';
        this.outputStarted = true;
      } else {
        this.stringRole = 'ignored';
      }
    } else {
      this.stringRole = 'ignored';
    }
    this.stringValue = '';
    this.escapeStage = 'plain';
    this.unicodeHex = '';
  }

  private scanStringChar(char: string): void {
    if (this.escapeStage === 'unicode') {
      this.unicodeHex += char;
      if (this.unicodeHex.length === 4) {
        if (!JSON_UNICODE_ESCAPE.test(this.unicodeHex)) {
          this.stage = 'stalled';
          return;
        }
        this.appendStringChar(String.fromCharCode(parseInt(this.unicodeHex, 16)));
        this.unicodeHex = '';
        this.escapeStage = 'plain';
      }
      return;
    }
    if (this.escapeStage === 'escape') {
      if (char === 'u') {
        this.escapeStage = 'unicode';
      } else {
        this.appendStringChar(JSON_ESCAPE_CHARS[char] ?? char);
        this.escapeStage = 'plain';
      }
      return;
    }
    if (char === '"') {
      this.closeString();
    } else if (char === '\\') {
      this.escapeStage = 'escape';
    } else {
      this.appendStringChar(char);
    }
  }

  private appendStringChar(char: string): void {
    if (this.stringRole === 'output') {
      this.decoded += char;
    } else if (this.stringRole === 'key' || this.stringRole === 'action') {
      this.stringValue += char;
    }
  }

  private closeString(): void {
    if (this.stringRole === 'key') {
      this.topLevelKey = this.stringValue;
    } else if (this.stringRole === 'action') {
      if (this.stringValue !== 'finish') {
        this.stage = 'non-finish';
      } else {
        this.actionIsFinish = true;
        if (this.outputClosed) {
          this.stage = 'closed';
        }
      }
    } else if (this.stringRole === 'output') {
      this.outputClosed = true;
      if (this.actionIsFinish) {
        this.stage = 'closed';
      }
    }
    this.stringRole = null;
    this.stringValue = '';
    this.escapeStage = 'plain';
    this.unicodeHex = '';
  }

  private isTerminal(): boolean {
    return this.stage === 'non-finish' || this.stage === 'closed' || this.stage === 'stalled';
  }

  private result(): string | null {
    return this.actionIsFinish && this.outputStarted ? this.decoded : null;
  }

  private resetState(): void {
    this.scannedTo = 0;
    this.stage = 'scanning';
    this.depth = 0;
    this.expectsTopLevelKey = false;
    this.expectsTopLevelValue = false;
    this.topLevelKey = null;
    this.stringRole = null;
    this.stringValue = '';
    this.escapeStage = 'plain';
    this.unicodeHex = '';
    this.actionIsFinish = false;
    this.outputStarted = false;
    this.outputClosed = false;
    this.decoded = '';
  }
}

export class ModelJson {
  static parseSummaryDecision(text: string): StructuredModelDecision {
    const parsed = this.parseModelObject(text, 'SiftKit decision').value;
    return this.validateSummaryDecision(parsed);
  }

  static parseSummaryPlannerAction(text: string, options: SummaryPlannerParseOptions): SummaryPlannerAction {
    const parsed = this.parsePlannerObject(text);
    return parseSummaryPlannerAction(parsed, options);
  }

  static parseRepoSearchPlannerAction(text: string, options: RepoPlannerParserOptions): RepoSearchPlannerAction {
    const parsed = this.parsePlannerObject(text);
    return parseRepoSearchPlannerAction(parsed, options.toolDefinitions);
  }
  static parseRepoSearchFinishValidation(text: string): FinishValidationResult {
    const parsed = this.parseModelObject(text, 'finish validation').value;
    return this.validateFinishValidation(parsed);
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

  private static parsePlannerObject(text: string): JsonObject {
    const parsed = this.parseModelObject(text, 'planner');
    if (parsed.repaired && parsed.synthesizedNull) {
      throw new Error('Provider returned an invalid planner payload: JSON repair synthesized a missing value.');
    }
    return parsed.value;
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
    if (value === null) {
      return 1;
    }
    if (Array.isArray(value)) {
      let count = 0;
      for (const entry of value) {
        count += this.countNullValues(entry);
      }
      return count;
    }
    if (typeof value === 'object') {
      let count = 0;
      for (const entry of Object.values(value)) {
        count += this.countNullValues(entry);
      }
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
        if (char === '\n' || char === '\r') {
          lineComment = false;
        }
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
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = '';
        }
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
        text.slice(index, index + 4) === 'null' &&
        !this.isIdentifierCharacter(text[index - 1]) &&
        !this.isIdentifierCharacter(text[index + 4])
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

  private static validateFinishValidation(parsed: JsonObject): FinishValidationResult {
    const verdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
    if (verdict !== 'pass' && verdict !== 'fail') {
      throw new Error('Provider returned an invalid finish validation payload.');
    }
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    if (!reason) {
      throw new Error('Provider returned an invalid finish validation payload.');
    }
    return { verdict, reason };
  }

  private static getClassification(value?: JsonValue) {
    const parsed = SummaryClassificationSchema.safeParse(
      typeof value === 'string' ? value.trim().toLowerCase() : '',
    );
    return parsed.success ? parsed.data : null;
  }

}
