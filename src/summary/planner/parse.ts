import { getErrorMessage } from '../../lib/errors.js';
import { stripCodeFence } from '../../lib/text-format.js';
import type {
  PlannerAction,
  SummaryClassification,
} from '../types.js';
import { getRecord } from './json-filter.js';
import { getPlannerToolName } from './tools.js';

export function parsePlannerAction(text: string): PlannerAction {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(text)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Provider returned an invalid planner payload: ${getErrorMessage(error)}`);
  }

  const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
  if (action === 'tool') {
    const toolName = getPlannerToolName(parsed.tool_name);
    const args = getRecord(parsed.args);
    if (!toolName || !args) {
      throw new Error('Provider returned an invalid planner tool action.');
    }
    return {
      action: 'tool',
      tool_name: toolName,
      args,
    };
  }

  if (action === 'tool_batch') {
    if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) {
      throw new Error('Provider returned an invalid planner tool batch action.');
    }
    const toolCalls = parsed.tool_calls.map((toolCall) => {
      const toolRecord = getRecord(toolCall);
      const toolName = getPlannerToolName(toolRecord?.tool_name);
      const args = getRecord(toolRecord?.args);
      if (!toolName || !args) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      return {
        tool_name: toolName,
        args,
      };
    });
    return {
      action: 'tool_batch',
      tool_calls: toolCalls,
    };
  }

  if (action === 'finish') {
    const classification = typeof parsed.classification === 'string'
      ? parsed.classification.trim().toLowerCase()
      : '';
    const output = typeof parsed.output === 'string' ? parsed.output.trim() : '';
    if (!['summary', 'command_failure', 'unsupported_input'].includes(classification) || !output) {
      throw new Error('Provider returned an invalid planner finish action.');
    }
    return {
      action: 'finish',
      classification: classification as SummaryClassification,
      rawReviewRequired: Boolean(parsed.raw_review_required ?? parsed.rawReviewRequired ?? false),
      output,
    };
  }

  throw new Error('Provider returned an unknown planner action.');
}

export function recoverPlannerToolCallCandidate(text: string): PlannerAction | null {
  try {
    const parsed = JSON.parse(stripCodeFence(text)) as Record<string, unknown>;
    const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
    if (action === 'tool') {
      const toolName = getPlannerToolName(parsed.tool_name);
      const args = getRecord(parsed.args);
      return toolName && args
        ? {
          action: 'tool',
          tool_name: toolName,
          args,
        }
        : null;
    }
    if (action === 'tool_batch' && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      const firstToolCall = getRecord(parsed.tool_calls[0]);
      const toolName = getPlannerToolName(firstToolCall?.tool_name);
      const args = getRecord(firstToolCall?.args);
      return toolName && args
        ? {
          action: 'tool',
          tool_name: toolName,
          args,
        }
        : null;
    }
  } catch {
    return null;
  }
  return null;
}
