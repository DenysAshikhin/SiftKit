import type { PlannerToolDefinition } from './json-schema.js';
import { buildPlannerToolActionExample } from './json-schema.js';

const PLANNER_BATCH_EXAMPLE_TOOL_LIMIT = 2;
const PLANNER_BATCH_INSTRUCTION =
  'Batch independent tool calls with action "tool_batch" and a non-empty "calls" array of {"toolName":"<tool>","args":{...}} entries.';

export function buildPlannerToolInstructions(
  toolDefinitions: readonly PlannerToolDefinition[],
): string[] {
  if (toolDefinitions.length === 0) {
    return [];
  }
  const toolNames = toolDefinitions.map((tool) => tool.function.name);
  const batchCalls = toolDefinitions
    .slice(0, PLANNER_BATCH_EXAMPLE_TOOL_LIMIT)
    .map((tool) => ({ toolName: tool.function.name, args: tool.exampleArgs }));
  return [
    `Tool: {"action":"tool","toolName":"<tool>","args":{...}}. Allowed tools: ${toolNames.join(', ')}.`,
    ...toolDefinitions.map((tool) => `Example ${tool.function.name}: ${buildPlannerToolActionExample(tool)}`),
    PLANNER_BATCH_INSTRUCTION,
    `Batch example: ${JSON.stringify({ action: 'tool_batch', calls: batchCalls })}`,
  ];
}
