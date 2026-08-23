import type { JsonObject } from '../../lib/json-types.js';
import {
  buildAssistantToolCallMessage,
  type AssistantToolCallMessage,
} from '../../tool-call-messages.js';
import {
  buildEffectiveTranscriptAction,
  buildRepoToolRequestedCommand,
} from './repo-tools.js';
import {
  isRepoSearchCommandToolName,
  isRepoSearchNativeToolName,
  normalizeRepoSearchCommandForToolName,
  normalizeToolName,
  type ToolAction,
} from '../planner-protocol.js';

/** Stable transcript identity derived before approval decisions are made. */
export function buildBatchToolCallId(turn: number, batchIndex: number): string {
  return `t${turn}_c${batchIndex}`;
}

export type ResolvedToolActionIdentity = {
  normalizedToolName: string;
  isCommandTool: boolean;
  isNativeTool: boolean;
  command: string;
  rawArgs: JsonObject;
};

/** Decision-independent identity shared by pending-message construction and validation. */
export function resolveToolActionIdentity(toolAction: ToolAction): ResolvedToolActionIdentity {
  const normalizedToolName = normalizeToolName(toolAction.tool_name);
  const isCommandTool = isRepoSearchCommandToolName(normalizedToolName);
  const isNativeTool = isRepoSearchNativeToolName(normalizedToolName);
  const command = isCommandTool
    ? normalizeRepoSearchCommandForToolName(
        normalizedToolName,
        typeof toolAction.args.command === 'string' ? toolAction.args.command : '',
      )
    : buildRepoToolRequestedCommand(normalizedToolName, toolAction.args);
  return {
    normalizedToolName,
    isCommandTool,
    isNativeTool,
    command,
    rawArgs: toolAction.args,
  };
}

/** The assistant message this batch will append if every call is approved. */
export function buildPendingAssistantMessage(options: {
  turn: number;
  thinkingText: string;
  toolActions: ToolAction[];
}): AssistantToolCallMessage {
  return buildAssistantToolCallMessage(
    options.toolActions.map((toolAction, index) => {
      const identity = resolveToolActionIdentity(toolAction);
      return {
        action: buildEffectiveTranscriptAction({
          toolName: identity.normalizedToolName,
          rawArgs: identity.rawArgs,
          isNativeTool: identity.isNativeTool,
          commandToRun: identity.command,
        }),
        toolCallId: buildBatchToolCallId(options.turn, index),
        toolContent: '',
      };
    }),
    options.thinkingText,
  );
}
