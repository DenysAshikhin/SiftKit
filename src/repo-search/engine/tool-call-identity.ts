import type { JsonObject } from '../../lib/json-types.ts';
import {
  isRepoSearchNativeToolName,
  normalizeToolName,
} from '../planner-protocol.ts';
import type { AgentLoopToolAction } from '../../agent-loop/types.ts';

/** Stable transcript identity derived before approval decisions are made. */
export function buildBatchToolCallId(turn: number, batchIndex: number): string {
  return `t${turn}_c${batchIndex}`;
}

export type ResolvedToolActionIdentity = {
  normalizedToolName: string;
  isNativeTool: boolean;
  rawArgs: JsonObject;
};

/** Decision-independent identity of a proposed call, resolved before validation. */
export function resolveToolActionIdentity(toolAction: AgentLoopToolAction): ResolvedToolActionIdentity {
  const normalizedToolName = normalizeToolName(toolAction.toolName);
  const isNativeTool = isRepoSearchNativeToolName(normalizedToolName);
  return {
    normalizedToolName,
    isNativeTool,
    rawArgs: toolAction.args,
  };
}

