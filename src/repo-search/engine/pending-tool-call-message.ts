import type { JsonObject } from '../../lib/json-types.js';
import {
  buildAssistantToolCallMessage,
  type AssistantToolCallMessage,
} from '../../tool-call-messages.js';
import {
  isRepoSearchNativeToolName,
  normalizeToolName,
} from '../planner-protocol.js';
import type { AgentLoopToolAction } from '../../agent-loop/types.js';

/** Stable transcript identity derived before approval decisions are made. */
export function buildBatchToolCallId(turn: number, batchIndex: number): string {
  return `t${turn}_c${batchIndex}`;
}

export type ResolvedToolActionIdentity = {
  normalizedToolName: string;
  isNativeTool: boolean;
  rawArgs: JsonObject;
};

/** Decision-independent identity shared by pending-message construction and validation. */
export function resolveToolActionIdentity(toolAction: AgentLoopToolAction): ResolvedToolActionIdentity {
  const normalizedToolName = normalizeToolName(toolAction.toolName);
  const isNativeTool = isRepoSearchNativeToolName(normalizedToolName);
  return {
    normalizedToolName,
    isNativeTool,
    rawArgs: toolAction.args,
  };
}

/** The assistant message this batch will append if every call is approved. */
export function buildPendingAssistantMessage(options: {
  turn: number;
  thinkingText: string;
  content?: string;
  toolActions: readonly AgentLoopToolAction[];
}): AssistantToolCallMessage {
  return buildAssistantToolCallMessage(
    options.toolActions.map((toolAction, index) => {
      const identity = resolveToolActionIdentity(toolAction);
      return {
        action: { toolName: identity.normalizedToolName, args: identity.rawArgs },
        toolCallId: toolAction.callId,
        toolContent: '',
      };
    }),
    options.thinkingText,
    options.content ?? '',
  );
}
