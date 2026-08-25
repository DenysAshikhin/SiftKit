import { type JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import {
  buildPlannerActionJsonSchema,
  buildPlannerJsonSchema,
  type PlannerToolDefinition,
} from './json-schema.js';
import { buildPlannerToolInstructions } from './tool-instructions.js';
import {
  FindTextToolArgsSchema,
  JsonFilterToolArgsSchema,
  JsonGetToolArgsSchema,
  ReadLinesToolArgsSchema,
  SummaryNativeToolCallSchema,
  type SummaryNativeToolCall,
} from './summary-tools.js';
import {
  parsePlannerToolAction,
  parsePlannerToolBatchAction,
} from './parser.js';

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

export const SummaryPlannerToolCallSchema = z.discriminatedUnion('toolName', [
  z.strictObject({ action: z.literal('tool'), toolName: z.literal('find_text'), args: FindTextToolArgsSchema }),
  z.strictObject({ action: z.literal('tool'), toolName: z.literal('read_lines'), args: ReadLinesToolArgsSchema }),
  z.strictObject({ action: z.literal('tool'), toolName: z.literal('json_filter'), args: JsonFilterToolArgsSchema }),
  z.strictObject({ action: z.literal('tool'), toolName: z.literal('json_get'), args: JsonGetToolArgsSchema }),
]);

export const SummaryPlannerToolBatchActionSchema = z.strictObject({
  action: z.literal('tool_batch'),
  calls: z.array(SummaryNativeToolCallSchema).min(1),
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
  toolNames: string[];
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
    ...(toolNames.length > 0 ? ['tool', 'tool_batch'] : []),
    finishAction.action,
  ];
  const classification = allowUnsupportedInput
    ? 'summary|command_failure|unsupported_input'
    : 'summary|command_failure';
  const finishJsonSchema = buildPlannerJsonSchema(finishAction.schema);
  return {
    actionNames,
    toolNames,
    finishSchema,
    finishJsonSchema,
    jsonSchema: buildPlannerActionJsonSchema(toolDefinitions, [finishJsonSchema]),
    actionInstructions: [
      ...buildPlannerToolInstructions(toolDefinitions),
      `Allowed finish classifications: ${classification}`,
      `${finishAction.description}: ${finishAction.example}`,
    ].join('\n'),
  };
}

function validateSummaryToolCall(toolName: string, args: JsonObject): SummaryNativeToolCall {
  const result = SummaryNativeToolCallSchema.safeParse({ toolName, args });
  if (!result.success) {
    throw new Error(
      `Provider returned an invalid planner tool action: ${result.error.issues[0]?.message ?? 'schema validation failed'}`,
    );
  }
  return result.data;
}

export type SummaryPlannerParseOptions = {
  toolDefinitions: readonly PlannerToolDefinition[];
  allowUnsupportedInput: boolean;
};

export function parseSummaryPlannerAction(
  parsed: JsonObject,
  options: SummaryPlannerParseOptions,
): SummaryPlannerAction {
  const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
  if (action === 'finish') {
    const finishSchema = options.allowUnsupportedInput
      ? SummaryPlannerFinishActionSchema
      : SupportedSummaryPlannerFinishActionSchema;
    const finish = finishSchema.safeParse(parsed);
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
    const calls = parsePlannerToolBatchAction(parsed, options.toolDefinitions).map(({ toolName, args }, index) => {
      try {
        return validateSummaryToolCall(toolName, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Provider returned an invalid planner tool batch action: call ${index + 1} — ${message}`);
      }
    });
    return SummaryPlannerToolBatchActionSchema.parse({ action: 'tool_batch', calls });
  }
  const direct = parsePlannerToolAction(parsed, options.toolDefinitions);
  if (direct) {
    const nativeCall = validateSummaryToolCall(direct.toolName, direct.args);
    return SummaryPlannerToolCallSchema.parse({
      action: 'tool',
      toolName: nativeCall.toolName,
      args: nativeCall.args,
    });
  }
  throw new Error('Provider returned an unknown planner action.');
}
