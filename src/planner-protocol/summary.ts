import { JsonObjectSchema, type JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import { buildPlannerActionJsonSchema, type PlannerToolDefinition } from './json-schema.js';
import { parsePlannerToolAction, parsePlannerToolBatchAction } from './parser.js';

export const SummaryClassificationSchema = z.enum([
  'summary',
  'command_failure',
  'unsupported_input',
]);
export type SummaryClassification = z.infer<typeof SummaryClassificationSchema>;

const SupportedSummaryClassificationSchema = z.enum(['summary', 'command_failure']);
const NonEmptyOutputSchema = z.string().trim().min(1);

export const SummaryPlannerFinishActionSchema = z.strictObject({
  action: z.literal('finish'),
  classification: SummaryClassificationSchema,
  raw_review_required: z.boolean(),
  output: NonEmptyOutputSchema,
});

const SupportedSummaryPlannerFinishActionSchema = z.strictObject({
  action: z.literal('finish'),
  classification: SupportedSummaryClassificationSchema,
  raw_review_required: z.boolean(),
  output: NonEmptyOutputSchema,
});

export type SummaryPlannerFinishAction = z.infer<typeof SummaryPlannerFinishActionSchema>;

export const DEFAULT_SUMMARY_PLANNER_TOOL_NAMES = ['find_text', 'read_lines', 'json_filter'] as const;
export const SUMMARY_PLANNER_TOOL_NAMES = [...DEFAULT_SUMMARY_PLANNER_TOOL_NAMES, 'json_get'] as const;
export const SummaryPlannerToolNameSchema = z.enum(SUMMARY_PLANNER_TOOL_NAMES);
export type SummaryPlannerToolName = z.infer<typeof SummaryPlannerToolNameSchema>;

export const SummaryPlannerToolCallSchema = z.strictObject({
  action: z.literal('tool'),
  tool_name: SummaryPlannerToolNameSchema,
  args: JsonObjectSchema,
});

export const SummaryPlannerToolBatchActionSchema = z.strictObject({
  action: z.literal('tool_batch'),
  tool_calls: z.array(SummaryPlannerToolCallSchema.omit({ action: true })).min(1),
});

export const NormalizedSummaryPlannerFinishActionSchema = z.strictObject({
  action: z.literal('finish'),
  classification: SummaryClassificationSchema,
  rawReviewRequired: z.boolean(),
  output: NonEmptyOutputSchema,
});

export const SummaryPlannerActionSchema = z.union([
  SummaryPlannerToolCallSchema,
  SummaryPlannerToolBatchActionSchema,
  NormalizedSummaryPlannerFinishActionSchema,
]);

export type SummaryPlannerToolCall = z.infer<typeof SummaryPlannerToolCallSchema>;
export type SummaryPlannerToolBatchAction = z.infer<typeof SummaryPlannerToolBatchActionSchema>;
export type NormalizedSummaryPlannerFinishAction = z.infer<typeof NormalizedSummaryPlannerFinishActionSchema>;
export type SummaryPlannerAction = z.infer<typeof SummaryPlannerActionSchema>;

export function buildSummaryPlannerFinishActionExample(output: string): string {
  return JSON.stringify(SummaryPlannerFinishActionSchema.parse({
    action: 'finish',
    classification: 'summary',
    raw_review_required: false,
    output,
  }));
}

export type SummaryPlannerProtocol = {
  actionNames: string[];
  actionInstructions: string;
  finishSchema: typeof SummaryPlannerFinishActionSchema | typeof SupportedSummaryPlannerFinishActionSchema;
  finishJsonSchema: JsonObject;
  jsonSchema: JsonObject;
};

export function buildSummaryPlannerProtocol(
  toolDefinitions: readonly PlannerToolDefinition[],
  allowUnsupportedInput: boolean,
): SummaryPlannerProtocol {
  const finishSchema = allowUnsupportedInput
    ? SummaryPlannerFinishActionSchema
    : SupportedSummaryPlannerFinishActionSchema;
  const finishAction = {
    action: 'finish',
    schema: finishSchema,
    description: 'Return the final result only when complete',
    example: buildSummaryPlannerFinishActionExample('final answer text'),
  };
  const toolNames = toolDefinitions.map(({ function: definition }) => definition.name);
  const actionNames = [
    ...toolNames,
    ...(toolNames.length > 0 ? ['tool_batch'] : []),
    finishAction.action,
  ];
  const classification = allowUnsupportedInput
    ? 'summary|command_failure|unsupported_input'
    : 'summary|command_failure';
  const directTools = toolNames.length > 0 ? toolNames.join('|') : '(none)';
  const finishJsonSchema = JsonObjectSchema.parse(z.toJSONSchema(finishAction.schema, { io: 'input' }));
  const toolInstructions = toolNames.length > 0 ? [
    `Tool: {"action":"${directTools}", ...tool_arguments}`,
    'Batch independent tool calls with action "tool_batch" and a non-empty "calls" array of direct tool actions.',
  ] : [];
  return {
    actionNames,
    finishSchema,
    finishJsonSchema,
    jsonSchema: buildPlannerActionJsonSchema(toolDefinitions, [finishJsonSchema]),
    actionInstructions: [
      ...toolInstructions,
      `Allowed finish classifications: ${classification}`,
      `${finishAction.description}: ${finishAction.example}`,
    ].join('\n'),
  };
}

export function parseSummaryPlannerAction(
  parsed: JsonObject,
  toolDefinitions: readonly PlannerToolDefinition[],
): SummaryPlannerAction {
  const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
  if (action === 'finish') {
    const finish = SummaryPlannerFinishActionSchema.safeParse(parsed);
    if (!finish.success) {
      throw new Error(`Provider returned an invalid planner finish action: ${finish.error.issues[0]?.message ?? 'schema validation failed'}`);
    }
    return NormalizedSummaryPlannerFinishActionSchema.parse({
      action: 'finish',
      classification: finish.data.classification,
      rawReviewRequired: finish.data.raw_review_required,
      output: finish.data.output,
    });
  }
  if (action === 'tool_batch') {
    const toolCalls = parsePlannerToolBatchAction(parsed, toolDefinitions).map(({ toolName, args }) => ({
      tool_name: SummaryPlannerToolNameSchema.parse(toolName),
      args,
    }));
    return SummaryPlannerToolBatchActionSchema.parse({ action: 'tool_batch', tool_calls: toolCalls });
  }
  const direct = parsePlannerToolAction(parsed, toolDefinitions);
  if (direct) {
    return SummaryPlannerToolCallSchema.parse({
      action: 'tool',
      tool_name: direct.toolName,
      args: direct.args,
    });
  }
  throw new Error('Provider returned an unknown planner action.');
}
