import { jsonrepair } from 'jsonrepair';

import { getFirstCommandToken } from '../repo-search/command-safety.js';
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
import { stripCodeFence } from './text-format.js';

type RepoSearchParserOptions = {
  allowedToolNames: readonly string[];
};

const SUMMARY_CLASSIFICATIONS = new Set<string>(['summary', 'command_failure', 'unsupported_input']);
const SUMMARY_PLANNER_TOOL_NAMES = new Set<string>(['find_text', 'read_lines', 'json_filter', 'json_get']);
const LEGACY_REPO_SEARCH_TOOL_ALIAS = 'run_repo_cmd';

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
    options: RepoSearchParserOptions
  ): RepoSearchPlannerAction {
    const parsed = this.parseModelObject(text, 'planner');
    return this.validateRepoSearchPlannerAction(parsed, this.getAllowedToolNames(options));
  }

  static parseRepoSearchFinishValidation(text: string): FinishValidationResult {
    const parsed = this.parseModelObject(text, 'finish validation');
    return this.validateFinishValidation(parsed);
  }

  static parseToolArguments(value: unknown): Record<string, unknown> | null {
    if (typeof value === 'string') {
      try {
        return this.parseToolArgumentsText(value);
      } catch {
        return null;
      }
    }

    return this.getRecord(value);
  }

  private static parseToolArgumentsText(text: string): Record<string, unknown> | null {
    const parsed = this.parseJsonValue(text, 'tool arguments');
    if (typeof parsed === 'string') {
      return this.getRecord(this.parseJsonValue(parsed, 'tool arguments'));
    }
    return this.getRecord(parsed);
  }

  private static parseModelObject(text: string, payloadName: string): Record<string, unknown> {
    const parsed = this.parseJsonValue(stripCodeFence(text), payloadName);
    const record = this.getRecord(parsed);
    if (!record) {
      throw new Error(`Provider returned an invalid ${payloadName} payload: expected JSON object.`);
    }
    return record;
  }

  private static parseJsonValue(text: string, payloadName: string): unknown {
    const normalized = String(text || '').trim();
    try {
      return JSON.parse(normalized) as unknown;
    } catch (strictError) {
      try {
        return JSON.parse(jsonrepair(normalized)) as unknown;
      } catch (repairError) {
        throw new Error(
          `Provider returned an invalid ${payloadName} payload: ${this.getErrorMessage(repairError, strictError)}`
        );
      }
    }
  }

  private static getErrorMessage(error: unknown, fallback: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (fallback instanceof Error && fallback.message) {
      return fallback.message;
    }
    return String(error || fallback || 'unknown error');
  }

  private static getRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private static validateSummaryDecision(parsed: Record<string, unknown>): StructuredModelDecision {
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

  private static validateSummaryPlannerAction(parsed: Record<string, unknown>): SummaryPlannerAction {
    const action = this.getAction(parsed);
    if (action === 'tool') {
      const toolName = this.getSummaryPlannerToolName(parsed.tool_name);
      const args = this.getRecord(parsed.args);
      if (!toolName || !args) {
        throw new Error('Provider returned an invalid planner tool action.');
      }
      return { action: 'tool', tool_name: toolName, args };
    }

    if (action === 'tool_batch') {
      if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      return {
        action: 'tool_batch',
        tool_calls: parsed.tool_calls.map((toolCall) => {
          const toolRecord = this.getRecord(toolCall);
          const toolName = this.getSummaryPlannerToolName(toolRecord?.tool_name);
          const args = this.getRecord(toolRecord?.args);
          if (!toolName || !args) {
            throw new Error('Provider returned an invalid planner tool batch action.');
          }
          return { tool_name: toolName, args };
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
    parsed: Record<string, unknown>,
    allowedToolNames: Set<string>
  ): RepoSearchPlannerAction {
    const action = this.getAction(parsed);
    if (action === 'tool') {
      const toolAction = this.parseRepoSearchToolAction(parsed, allowedToolNames, 'tool');
      if (!toolAction) {
        throw new Error('Provider returned an invalid planner tool action.');
      }
      return toolAction;
    }

    if (action === 'tool_batch') {
      if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      const toolCalls = parsed.tool_calls.map((toolCall) => {
        const toolRecord = this.getRecord(toolCall);
        if (!toolRecord) {
          throw new Error('Provider returned an invalid planner tool batch action.');
        }
        const toolAction = this.parseRepoSearchToolAction(toolRecord, allowedToolNames, 'tool_batch');
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
      if (!output) {
        throw new Error('Provider returned an invalid planner finish action.');
      }
      const confidence = Number(parsed.confidence);
      return Number.isFinite(confidence)
        ? { action: 'finish', output, confidence } satisfies RepoSearchFinishAction
        : { action: 'finish', output } satisfies RepoSearchFinishAction;
    }

    throw new Error('Provider returned an unknown planner action.');
  }

  private static parseRepoSearchToolAction(
    parsed: Record<string, unknown>,
    allowedToolNames: Set<string>,
    source: 'tool' | 'tool_batch'
  ): RepoSearchToolAction | null {
    const rawToolName = this.getRepoSearchToolName(parsed);
    const args = this.getRecord(parsed.args);
    if (!rawToolName || !args) {
      return null;
    }
    const normalizedToolCall = this.normalizeRepoSearchToolCall(rawToolName, args, allowedToolNames);
    if (!normalizedToolCall && source === 'tool') {
      return null;
    }
    return normalizedToolCall;
  }

  private static normalizeRepoSearchToolCall(
    rawToolName: string,
    rawArgs: Record<string, unknown>,
    allowedToolNames: Set<string>
  ): RepoSearchToolAction | null {
    let toolName = rawToolName;
    if (toolName === LEGACY_REPO_SEARCH_TOOL_ALIAS) {
      const command = this.getCommandArgValue(rawArgs);
      if (!command) {
        return null;
      }
      const inferredToolName = this.getRepoSearchToolNameForCommand(command);
      if (!inferredToolName) {
        return null;
      }
      toolName = inferredToolName;
    }

    if (!allowedToolNames.has(toolName)) {
      return null;
    }

    if (this.isRepoSearchCommandToolName(toolName)) {
      const command = this.getCommandArgValue(rawArgs);
      if (!command) {
        return null;
      }
      const expectedCommandToken = this.getRepoSearchCommandTokenForToolName(toolName);
      const actualCommandToken = getFirstCommandToken(command);
      if (!expectedCommandToken || actualCommandToken !== expectedCommandToken) {
        return null;
      }
      return { action: 'tool', tool_name: toolName, args: { command } };
    }

    if (toolName === 'repo_read_file') {
      return typeof rawArgs.path === 'string' && rawArgs.path.trim()
        ? {
          action: 'tool',
          tool_name: toolName,
          args: {
            path: rawArgs.path,
            ...(rawArgs.startLine === undefined ? {} : { startLine: rawArgs.startLine }),
            ...(rawArgs.endLine === undefined ? {} : { endLine: rawArgs.endLine }),
          },
        }
        : null;
    }

    if (toolName === 'repo_list_files') {
      return {
        action: 'tool',
        tool_name: toolName,
        args: {
          ...(typeof rawArgs.path === 'string' ? { path: rawArgs.path } : {}),
          ...(typeof rawArgs.glob === 'string' ? { glob: rawArgs.glob } : {}),
          ...(typeof rawArgs.recurse === 'boolean' ? { recurse: rawArgs.recurse } : {}),
        },
      };
    }

    return { action: 'tool', tool_name: toolName, args: rawArgs };
  }

  private static validateFinishValidation(parsed: Record<string, unknown>): FinishValidationResult {
    const verdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
    if (verdict !== 'pass' && verdict !== 'fail') {
      throw new Error('Provider returned an invalid finish validation payload.');
    }
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    if (!reason) {
      throw new Error('Provider returned an invalid finish validation payload.');
    }
    return { verdict: verdict as 'pass' | 'fail', reason };
  }

  private static getClassification(value: unknown): SummaryClassification | null {
    const classification = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return SUMMARY_CLASSIFICATIONS.has(classification)
      ? classification as SummaryClassification
      : null;
  }

  private static getAction(parsed: Record<string, unknown>): string {
    return typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
  }

  private static getSummaryPlannerToolName(value: unknown): PlannerToolName | null {
    const toolName = typeof value === 'string' ? value.trim() : '';
    return SUMMARY_PLANNER_TOOL_NAMES.has(toolName)
      ? toolName as PlannerToolName
      : null;
  }

  private static getRepoSearchToolName(parsed: Record<string, unknown>): string {
    return String(
      parsed.tool_name ?? parsed.toolName ?? parsed.tool ?? parsed.name ?? '',
    ).trim().toLowerCase();
  }

  private static getAllowedToolNames(options: RepoSearchParserOptions): Set<string> {
    return new Set<string>(
      options.allowedToolNames.map((toolName) => String(toolName || '').trim().toLowerCase()).filter(Boolean)
    );
  }

  private static getCommandArgValue(args: Record<string, unknown>): string {
    const commandValue = typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string'
        ? args.cmd
        : '';
    return commandValue.trim();
  }

  private static getRepoSearchToolNameForCommand(command: string): string | null {
    const commandToken = getFirstCommandToken(String(command || '').trim());
    return commandToken ? this.commandTokenToToolName(commandToken) : null;
  }

  private static getRepoSearchCommandTokenForToolName(toolName: string): string | null {
    const prefix = 'repo_';
    return toolName.startsWith(prefix)
      ? toolName.slice(prefix.length).replace(/_/gu, '-')
      : null;
  }

  private static isRepoSearchCommandToolName(toolName: string): boolean {
    return toolName.startsWith('repo_') && toolName !== 'repo_read_file' && toolName !== 'repo_list_files';
  }

  private static commandTokenToToolName(commandToken: string): string {
    return `repo_${String(commandToken || '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_')}`;
  }
}
