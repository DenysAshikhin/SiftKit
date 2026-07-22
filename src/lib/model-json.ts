import { jsonrepair } from 'jsonrepair';

import { getFirstCommandToken } from '../repo-search/command-safety.js';
import { getRepoSearchCommandTokenForToolName, isRepoSearchCommandToolName } from '../repo-search/planner-protocol.js';
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

/**
 * Per-tool argument shape for the native (non-`git`) repo tools. `requiredText` args must arrive as
 * non-empty strings or the call is rejected; `optional` args are passed through untouched and
 * value-validated by engine/repo-tools.ts.
 */
const REPO_TOOL_ARG_SPECS: Record<string, { requiredText: readonly string[]; optional: readonly string[] }> = {
  read: { requiredText: ['path'], optional: ['offset', 'limit'] },
  grep: {
    requiredText: ['pattern'],
    optional: ['path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'],
  },
  find: { requiredText: ['pattern'], optional: ['path', 'limit'] },
  ls: { requiredText: [], optional: ['path', 'limit'] },
  web_search: { requiredText: ['query'], optional: ['timeFilter'] },
  web_fetch: { requiredText: ['url'], optional: [] },
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

  static extractStreamingFinishOutput(text: string): string | null {
    if (!/"action"\s*:\s*"finish"/.test(text)) {
      return null;
    }
    const openMatch = /"output"\s*:\s*"/.exec(text);
    if (!openMatch) {
      return null;
    }
    return this.decodeJsonStringPrefix(text, openMatch.index + openMatch[0].length);
  }

  private static decodeJsonStringPrefix(text: string, start: number): string {
    let result = '';
    let index = start;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        break;
      }
      if (char === '\\') {
        const escape = text[index + 1];
        if (escape === undefined) {
          break;
        }
        if (escape === 'u') {
          const hex = text.slice(index + 2, index + 6);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
            break;
          }
          result += String.fromCharCode(parseInt(hex, 16));
          index += 6;
          continue;
        }
        result += JSON_ESCAPE_CHARS[escape] ?? escape;
        index += 2;
        continue;
      }
      result += char;
      index += 1;
    }
    return result;
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
      const toolAction = this.normalizeRepoSearchToolCall(
        action,
        this.getDirectToolArgs(parsed, directToolDefinition),
        allowedToolNames,
      );
      if (!toolAction) {
        throw new Error('Provider returned an invalid planner tool action.');
      }
      return toolAction;
    }

    if (action === 'tool_batch') {
      const toolCalls = this.getBatchToolRecords(parsed).map((toolRecord) => {
        const toolName = this.getAction(toolRecord);
        const toolDefinition = this.getToolDefinition(options, toolName);
        const toolAction =
          allowedToolNames.has(toolName) && toolDefinition
            ? this.normalizeRepoSearchToolCall(
                toolName,
                this.getDirectToolArgs(toolRecord, toolDefinition),
                allowedToolNames,
              )
            : null;
        if (!toolAction) {
          throw new Error('Provider returned an invalid planner tool batch action.');
        }
        return {
          tool_name: toolAction.tool_name,
          args: toolAction.args,
        };
      });
      return {
        action: 'tool_batch',
        tool_calls: toolCalls,
      } satisfies RepoSearchToolBatchAction;
    }

    if (action === 'finish') {
      const output = typeof parsed.output === 'string' ? parsed.output.trim() : '';
      const keys = Object.keys(parsed);
      if (!output || keys.some((key) => key !== 'action' && key !== 'output')) {
        throw new Error('Provider returned an invalid planner finish action.');
      }
      return { action: 'finish', output } satisfies RepoSearchFinishAction;
    }

    throw new Error('Provider returned an unknown planner action.');
  }

  private static normalizeRepoSearchToolCall(
    rawToolName: string,
    rawArgs: JsonObject,
    allowedToolNames: Set<string>,
  ): RepoSearchToolAction | null {
    const toolName = rawToolName;

    if (!allowedToolNames.has(toolName)) {
      return null;
    }

    if (isRepoSearchCommandToolName(toolName)) {
      const command = this.getCommandArgValue(rawArgs);
      if (!command || getFirstCommandToken(command) !== getRepoSearchCommandTokenForToolName(toolName)) {
        return null;
      }
      return { action: 'tool', tool_name: toolName, args: { command } };
    }

    const argSpec = REPO_TOOL_ARG_SPECS[toolName];
    if (!argSpec) {
      return null;
    }
    const args: MutableJsonObject = {};
    for (const key of argSpec.requiredText) {
      const rawValue = rawArgs[key];
      const value = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!value) {
        return null;
      }
      args[key] = value;
    }
    for (const key of argSpec.optional) {
      const rawValue = rawArgs[key];
      if (rawValue !== undefined) {
        args[key] = rawValue;
      }
    }
    return { action: 'tool', tool_name: toolName, args };
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
      throw new Error('Provider returned an invalid planner tool batch action.');
    }
    return parsed.calls.map((toolCall) => {
      const toolRecord = this.getRecord(toolCall);
      if (!toolRecord) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      return toolRecord;
    });
  }

  private static getCommandArgValue(args: JsonObject): string {
    const commandValue = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
    return commandValue.trim();
  }
}
