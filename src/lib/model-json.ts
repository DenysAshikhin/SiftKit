import { jsonrepair } from 'jsonrepair';

import { getFirstCommandToken } from '../repo-search/command-safety.js';
import {
  getRepoSearchCommandTokenForToolName,
  isRepoSearchCommandToolName,
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
import { getErrorMessage } from './errors.js';
import { JsonRecordReader } from './json-record-reader.js';
import { JsonValueSchema, type JsonObject, type JsonValue, type MutableJsonObject, type OptionalJsonValue } from './json-types.js';
import { stripCodeFence } from './text-format.js';

type RepoSearchParserOptions = {
  allowedToolNames: readonly string[];
};

/**
 * Per-tool argument shape for the native (non-`git`) repo tools. `requiredText` args must arrive as
 * non-empty strings or the call is rejected; `optional` args are passed through untouched and
 * value-validated by engine/repo-tools.ts.
 */
const REPO_TOOL_ARG_SPECS: Record<string, { requiredText: readonly string[]; optional: readonly string[] }> = {
  read: { requiredText: ['path'], optional: ['offset', 'limit'] },
  grep: { requiredText: ['pattern'], optional: ['path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'] },
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
    const parsed = this.parseModelObject(text, 'SiftKit decision');
    return this.validateSummaryDecision(parsed);
  }

  static parseSummaryPlannerAction(text: string): SummaryPlannerAction {
    const parsed = this.parseModelObject(text, 'planner');
    return this.validateSummaryPlannerAction(parsed);
  }

  static parseRepoSearchPlannerAction(
    text: string,
    options: RepoSearchParserOptions,
  ): RepoSearchPlannerAction {
    const parsed = this.parseModelObject(text, 'planner');
    return this.validateRepoSearchPlannerAction(parsed, this.getAllowedToolNames(options));
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
    const parsed = this.parseModelObject(text, 'finish validation');
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
    if (typeof parsed === 'string') {
      return this.getRecord(this.parseJsonValue(parsed, 'tool arguments'));
    }
    return this.getRecord(parsed);
  }

  private static parseModelObject(text: string, payloadName: string): JsonObject {
    const parsed = this.parseJsonValue(stripCodeFence(text), payloadName);
    const record = this.getRecord(parsed);
    if (!record) {
      throw new Error(`Provider returned an invalid ${payloadName} payload: expected JSON object.`);
    }
    return record;
  }

  private static parseJsonValue(text: string, payloadName: string): JsonValue {
    const normalized = String(text || '').trim();
    try {
      return JsonValueSchema.parse(JSON.parse(normalized));
    } catch (strictError) {
      try {
        return JsonValueSchema.parse(JSON.parse(jsonrepair(normalized)));
      } catch (repairError) {
        const message = getErrorMessage(repairError) || getErrorMessage(strictError) || 'unknown error';
        throw new Error(`Provider returned an invalid ${payloadName} payload: ${message}`);
      }
    }
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

  private static validateSummaryPlannerAction(parsed: JsonObject): SummaryPlannerAction {
    const action = this.getAction(parsed);
    const directToolName = this.getSummaryPlannerToolName(action);
    if (directToolName) {
      return {
        action: 'tool',
        tool_name: directToolName,
        args: this.getDirectToolArgs(parsed),
      };
    }

    if (action === 'tool_batch') {
      if (!Array.isArray(parsed.calls) || parsed.calls.length === 0) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      return {
        action: 'tool_batch',
        tool_calls: parsed.calls.map((toolCall) => {
          const toolRecord = this.getRecord(toolCall);
          const toolName = toolRecord ? this.getSummaryPlannerToolName(this.getAction(toolRecord)) : null;
          if (!toolRecord || !toolName) {
            throw new Error('Provider returned an invalid planner tool batch action.');
          }
          return { tool_name: toolName, args: this.getDirectToolArgs(toolRecord) };
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
    allowedToolNames: Set<string>,
  ): RepoSearchPlannerAction {
    const action = this.getAction(parsed);
    if (allowedToolNames.has(action)) {
      const toolAction = this.normalizeRepoSearchToolCall(action, this.getDirectToolArgs(parsed), allowedToolNames);
      if (!toolAction) {
        throw new Error('Provider returned an invalid planner tool action.');
      }
      return toolAction;
    }

    if (action === 'tool_batch') {
      if (!Array.isArray(parsed.calls) || parsed.calls.length === 0) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      const toolCalls = parsed.calls.map((toolCall) => {
        const toolRecord = this.getRecord(toolCall);
        if (!toolRecord) {
          throw new Error('Provider returned an invalid planner tool batch action.');
        }
        const toolName = this.getAction(toolRecord);
        const toolAction = allowedToolNames.has(toolName)
          ? this.normalizeRepoSearchToolCall(toolName, this.getDirectToolArgs(toolRecord), allowedToolNames)
          : null;
        if (!toolAction) {
          throw new Error('Provider returned an invalid planner tool batch action.');
        }
        return {
          tool_name: toolAction.tool_name,
          args: toolAction.args,
        };
      });
      return { action: 'tool_batch', tool_calls: toolCalls } satisfies RepoSearchToolBatchAction;
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

  private static getDirectToolArgs(parsed: JsonObject): JsonObject {
    const args: MutableJsonObject = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== 'action') {
        args[key] = value;
      }
    }
    return args;
  }

  private static getAllowedToolNames(options: RepoSearchParserOptions): Set<string> {
    return new Set<string>(
      options.allowedToolNames.map((toolName) => String(toolName || '').trim().toLowerCase()).filter(Boolean),
    );
  }

  private static getCommandArgValue(args: JsonObject): string {
    const commandValue = typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string'
        ? args.cmd
        : '';
    return commandValue.trim();
  }

}
