import { jsonrepair } from 'jsonrepair';

import {
  RepoNativeToolCallSchema,
  restoreModelCommandSeparators,
} from '../repo-search/repo-tool-arguments.js';
import {
  isRepoSearchCommandToolName,
  normalizeRepoSearchCommandForToolName,
} from '../repo-search/planner-protocol.js';
import type {
  FinishAction as RepoSearchFinishAction,
  FinishValidationResult,
  PlannerAction as RepoSearchPlannerAction,
  ToolAction as RepoSearchToolAction,
  ToolBatchAction as RepoSearchToolBatchAction,
} from '../repo-search/planner-protocol.js';
import type {
  PlannerAction as SummaryPlannerAction,
  PlannerToolName,
  StructuredModelDecision,
  SummaryClassification,
} from '../summary/types.js';
import type { LlamaCppToolParameterSchema } from '../llm-protocol/types.js';
import { getErrorMessage } from './errors.js';
import { JsonRecordReader } from './json-record-reader.js';
import {
  JsonValueSchema,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  type OptionalJsonValue,
} from './json-types.js';
import { stripCodeFence } from './text-format.js';

export type PlannerParserToolDefinition = {
  function: {
    name: string;
    parameters?: LlamaCppToolParameterSchema;
  };
};

type PlannerParserOptions = {
  toolDefinitions: readonly PlannerParserToolDefinition[];
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

type RepoSearchToolCallNormalization =
  | { ok: true; action: RepoSearchToolAction }
  | { ok: false; reason: string };

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

  static parseSummaryPlannerAction(text: string, options: PlannerParserOptions): SummaryPlannerAction {
    const parsed = this.parsePlannerObject(text);
    return this.validateSummaryPlannerAction(parsed, options);
  }

  static parseRepoSearchPlannerAction(text: string, options: PlannerParserOptions): RepoSearchPlannerAction {
    const parsed = this.parsePlannerObject(text);
    return this.validateRepoSearchPlannerAction(parsed, options);
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

  private static validateSummaryPlannerAction(parsed: JsonObject, options: PlannerParserOptions): SummaryPlannerAction {
    const action = this.getAction(parsed);
    const directToolName = this.getSummaryPlannerToolName(action);
    const directToolDefinition = this.getToolDefinition(options, action);
    if (directToolName && directToolDefinition) {
      return {
        action: 'tool',
        tool_name: directToolName,
        args: this.getDirectToolArgs(parsed, directToolDefinition),
      };
    }

    if (action === 'tool_batch') {
      return {
        action: 'tool_batch',
        tool_calls: this.getBatchToolRecords(parsed).map((toolRecord) => {
          const toolAction = this.getAction(toolRecord);
          const toolName = this.getSummaryPlannerToolName(toolAction);
          const toolDefinition = this.getToolDefinition(options, toolAction);
          if (!toolName || !toolDefinition) {
            throw new Error('Provider returned an invalid planner tool batch action.');
          }
          return {
            tool_name: toolName,
            args: this.getDirectToolArgs(toolRecord, toolDefinition),
          };
        }),
      };
    }

    if (action === 'finish') {
      const classification = this.getClassification(parsed.classification);
      const output = typeof parsed.output === 'string' ? parsed.output.trim() : '';
      if (!classification || !output) {
        throw new Error('Provider returned an invalid planner finish action.');
      }
      return {
        action: 'finish',
        classification,
        rawReviewRequired: Boolean(parsed.raw_review_required ?? parsed.rawReviewRequired ?? false),
        output,
      };
    }

    throw new Error('Provider returned an unknown planner action.');
  }

  private static validateRepoSearchPlannerAction(
    parsed: JsonObject,
    options: PlannerParserOptions,
  ): RepoSearchPlannerAction {
    const action = this.getAction(parsed);
    const allowedToolNames = this.getAllowedToolNames(options);
    const directToolDefinition = this.getToolDefinition(options, action);
    if (allowedToolNames.has(action) && directToolDefinition) {
      const normalized = this.normalizeRepoSearchToolCall(
        action,
        this.getDirectToolArgs(parsed, directToolDefinition),
      );
      if (!normalized.ok) {
        throw new Error(`Provider returned an invalid planner tool action: ${normalized.reason}`);
      }
      return normalized.action;
    }

    if (action === 'tool_batch') {
      const toolCalls = this.getBatchToolRecords(parsed).map((toolRecord, index) => {
        const toolName = this.getAction(toolRecord);
        const toolDefinition = this.getToolDefinition(options, toolName);
        if (!allowedToolNames.has(toolName) || !toolDefinition) {
          throw new Error(
            `Provider returned an invalid planner tool batch action: call ${index + 1} uses unavailable tool "${toolName}"`,
          );
        }
        const normalized = this.normalizeRepoSearchToolCall(
          toolName,
          this.getDirectToolArgs(toolRecord, toolDefinition),
        );
        if (!normalized.ok) {
          throw new Error(
            `Provider returned an invalid planner tool batch action: call ${index + 1} — ${normalized.reason}`,
          );
        }
        return {
          tool_name: normalized.action.tool_name,
          args: normalized.action.args,
        };
      });
      return {
        action: 'tool_batch',
        tool_calls: toolCalls,
      } satisfies RepoSearchToolBatchAction;
    }

    if (action === 'finish') {
      const output = typeof parsed.output === 'string' ? parsed.output.trim() : '';
      if (!output) {
        throw new Error('Provider returned an invalid planner finish action: "output" must be a non-empty string');
      }
      const extraKeys = Object.keys(parsed).filter((key) => key !== 'action' && key !== 'output');
      if (extraKeys.length > 0) {
        throw new Error(
          `Provider returned an invalid planner finish action: finish accepts only "action" and "output"; remove: ${extraKeys.join(', ')}`,
        );
      }
      return { action: 'finish', output } satisfies RepoSearchFinishAction;
    }

    throw new Error(
      `Provider returned an unknown planner action "${action}"; valid actions: ${[...allowedToolNames, 'tool_batch', 'finish'].sort().join(', ')}`,
    );
  }

  /** Both callers gate on `allowedToolNames` before dispatching here, so this only validates arguments. */
  private static normalizeRepoSearchToolCall(
    toolName: string,
    rawArgs: JsonObject,
  ): RepoSearchToolCallNormalization {
    if (isRepoSearchCommandToolName(toolName)) {
      const command = normalizeRepoSearchCommandForToolName(toolName, this.getCommandArgValue(rawArgs));
      if (!command) {
        return { ok: false, reason: `"${toolName}" requires a non-empty "command" string` };
      }
      return {
        ok: true,
        action: {
          action: 'tool',
          tool_name: toolName,
          args: { command: restoreModelCommandSeparators(command) },
        },
      };
    }

    const nativeCall = RepoNativeToolCallSchema.safeParse({ toolName, args: rawArgs });
    if (!nativeCall.success) {
      const issue = nativeCall.error.issues[0];
      const issuePath = issue?.path.map(String).join('.') || 'args';
      const issueMessage = issue?.message.replace(/[.\s]+$/u, '') || 'schema validation failed';
      return {
        ok: false,
        reason: `"${toolName}" has invalid "${issuePath}": ${issueMessage}`,
      };
    }
    return {
      ok: true,
      action: { action: 'tool', tool_name: nativeCall.data.toolName, args: nativeCall.data.args },
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

  private static getClassification(value?: JsonValue): SummaryClassification | null {
    const classification = typeof value === 'string' ? value.trim().toLowerCase() : '';
    switch (classification) {
      case 'summary':
      case 'command_failure':
      case 'unsupported_input':
        return classification;
      default:
        return null;
    }
  }

  private static getAction(parsed: JsonObject): string {
    return typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
  }

  private static getSummaryPlannerToolName(value: string): PlannerToolName | null {
    switch (value.trim()) {
      case 'find_text':
        return 'find_text';
      case 'read_lines':
        return 'read_lines';
      case 'json_filter':
        return 'json_filter';
      case 'json_get':
        return 'json_get';
      default:
        return null;
    }
  }

  private static getDirectToolArgs(parsed: JsonObject, toolDefinition: PlannerParserToolDefinition): JsonObject {
    const parameters = this.getRecord(JsonValueSchema.parse(toolDefinition.function.parameters ?? {}));
    const properties = this.getRecord(parameters?.properties);
    const required = new Set(
      Array.isArray(parameters?.required)
        ? parameters.required.filter((entry): entry is string => typeof entry === 'string')
        : [],
    );
    const args: MutableJsonObject = {};
    for (const [key, value] of Object.entries(parsed)) {
      const schemaDeclaresOmission = properties !== null && Object.hasOwn(properties, key) && !required.has(key);
      if (key !== 'action' && (value !== null || !schemaDeclaresOmission)) {
        args[key] = value;
      }
    }
    return args;
  }

  private static getAllowedToolNames(options: PlannerParserOptions): Set<string> {
    return new Set<string>(
      options.toolDefinitions
        .map((toolDefinition) => toolDefinition.function.name.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  private static getToolDefinition(
    options: PlannerParserOptions,
    toolName: string,
  ): PlannerParserToolDefinition | null {
    const normalizedToolName = toolName.trim().toLowerCase();
    return (
      options.toolDefinitions.find(
        (toolDefinition) => toolDefinition.function.name.trim().toLowerCase() === normalizedToolName,
      ) ?? null
    );
  }

  private static getBatchToolRecords(parsed: JsonObject): JsonObject[] {
    if (!Array.isArray(parsed.calls) || parsed.calls.length === 0) {
      throw new Error('Provider returned an invalid planner tool batch action: "calls" must be a non-empty array');
    }
    return parsed.calls.map((toolCall, index) => {
      const toolRecord = this.getRecord(toolCall);
      if (!toolRecord) {
        throw new Error(
          `Provider returned an invalid planner tool batch action: call ${index + 1} is not a JSON object`,
        );
      }
      return toolRecord;
    });
  }

  private static getCommandArgValue(args: JsonObject): string {
    const commandValue = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
    return commandValue.trim();
  }
}
