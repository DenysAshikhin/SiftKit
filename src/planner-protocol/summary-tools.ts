import { JsonObjectSchema, JsonValueSchema, type JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import { buildPlannerJsonSchema, type PlannerToolDefinition } from './json-schema.js';

const NonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, 'Expected non-blank text.');
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const FindTextToolArgsSchema = z.strictObject({
  query: NonBlankTextSchema.describe('The literal text or regex pattern to search for.'),
  mode: z.enum(['literal', 'regex']).describe('Whether query is treated as literal text or regex.'),
  maxHits: PositiveIntegerSchema.describe('Maximum number of matching locations to return.').optional(),
  contextLines: NonNegativeIntegerSchema.max(3)
    .describe('Number of surrounding lines to include before and after each hit.')
    .optional(),
});

export const ReadLinesToolArgsSchema = z.strictObject({
  startLine: PositiveIntegerSchema.describe('Inclusive 1-based start line.'),
  endLine: PositiveIntegerSchema.describe('Inclusive 1-based end line.'),
}).refine((args) => args.startLine <= args.endLine, 'startLine must not exceed endLine.');

const JSON_FILTER_BOUND_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;
export const JsonFilterBoundOpSchema = z.enum(JSON_FILTER_BOUND_OPS);

export const JsonFilterEntrySchema = z.strictObject({
  path: NonBlankTextSchema,
  op: z.enum([...JSON_FILTER_BOUND_OPS, 'contains', 'exists']),
  value: JsonValueSchema.optional(),
});

export const JsonFilterToolArgsSchema = z.strictObject({
  collectionPath: NonBlankTextSchema
    .describe('Optional dot-path to the array collection. Omit for a root array.')
    .optional(),
  filters: z.array(JsonFilterEntrySchema)
    .min(1)
    .describe('Field predicates applied to each item in the collection.'),
  select: z.array(NonBlankTextSchema)
    .describe('Optional list of dot-path fields to project from each matched item.')
    .optional(),
  limit: PositiveIntegerSchema.describe('Maximum number of matched items to return.').optional(),
});

export const JsonGetToolArgsSchema = z.strictObject({
  path: NonBlankTextSchema.describe('Dot-path to the target value. Array indexes are allowed.'),
});

export const SUMMARY_PLANNER_TOOL_NAMES = [
  'find_text',
  'read_lines',
  'json_filter',
  'json_get',
] as const;

export const DEFAULT_SUMMARY_PLANNER_TOOL_NAMES = [
  'find_text',
  'read_lines',
  'json_filter',
] as const;

export const SummaryPlannerToolNameSchema = z.enum(SUMMARY_PLANNER_TOOL_NAMES);
export type SummaryPlannerToolName = z.infer<typeof SummaryPlannerToolNameSchema>;

export const SUMMARY_TOOL_ARGUMENT_SCHEMAS = {
  find_text: FindTextToolArgsSchema,
  read_lines: ReadLinesToolArgsSchema,
  json_filter: JsonFilterToolArgsSchema,
  json_get: JsonGetToolArgsSchema,
} as const;

export const SummaryNativeToolCallSchema = z.discriminatedUnion('toolName', [
  z.strictObject({ toolName: z.literal('find_text'), args: FindTextToolArgsSchema }),
  z.strictObject({ toolName: z.literal('read_lines'), args: ReadLinesToolArgsSchema }),
  z.strictObject({ toolName: z.literal('json_filter'), args: JsonFilterToolArgsSchema }),
  z.strictObject({ toolName: z.literal('json_get'), args: JsonGetToolArgsSchema }),
]);

export type SummaryNativeToolCall = z.infer<typeof SummaryNativeToolCallSchema>;
export type FindTextToolArgs = z.infer<typeof FindTextToolArgsSchema>;
export type ReadLinesToolArgs = z.infer<typeof ReadLinesToolArgsSchema>;
export type JsonFilterToolArgs = z.infer<typeof JsonFilterToolArgsSchema>;
export type JsonFilterEntry = z.infer<typeof JsonFilterEntrySchema>;
export type JsonGetToolArgs = z.infer<typeof JsonGetToolArgsSchema>;

const SUMMARY_TOOL_METADATA = {
  find_text: {
    description: 'Search the input text for a literal string or regex and return matching lines with optional surrounding context. Regex patterns must be valid JavaScript regex source without surrounding slashes; do not escape ordinary quotes unless the regex itself requires it. Example: {"query":"Lumbridge","mode":"literal","maxHits":5,"contextLines":1}',
    exampleArgs: { query: 'ERROR', mode: 'literal', maxHits: 20, contextLines: 2 },
  },
  read_lines: {
    description: 'Read a specific 1-based line range from the input text. Prefer larger contiguous windows after a find_text anchor; avoid many tiny adjacent slices unless verifying one exact line or symbol. Example: {"startLine":1340,"endLine":1405}',
    exampleArgs: { startLine: 1, endLine: 120 },
  },
  json_filter: {
    description: 'Parse JSON, filter array items by field conditions, and project only the selected fields. Use collectionPath when the root JSON value is an object with an array under a child key; for example use {"collectionPath":"states","filters":[{"path":"timestamp","op":"gte","value":"2026-03-30T18:40:00Z"},{"path":"timestamp","op":"lte","value":"2026-03-30T18:50:00Z"}],"select":["timestamp","lifecycle_state","bridge_state","scenario_id","step_id","state_json"],"limit":100} for a root object with a states array. Use separate filters for gte/lte bounds; each filter value should be a single scalar value, not an object containing multiple operators. Do not use "value":{"gte":3200,"lte":3215}. Example: {"filters":[{"path":"from.worldX","op":"gte","value":3200},{"path":"from.worldX","op":"lte","value":3215}],"select":["id","label","from","to","bidirectional"],"limit":20}',
    exampleArgs: {
      filters: [{ path: 'status', op: 'eq', value: 'failed' }],
      select: ['name', 'status'],
      limit: 20,
    },
  },
  json_get: {
    description: 'Parse JSON and return the value at one dot-path. Use this for nested object drill-down when you need one exact field rather than filtering an array. Dot paths may include array indexes. Example: {"path":"states.0.state_json"}',
    exampleArgs: { path: 'results.0' },
  },
} as const satisfies Record<SummaryPlannerToolName, { description: string; exampleArgs: JsonObject }>;

function buildSummaryToolDefinition(toolName: SummaryPlannerToolName): PlannerToolDefinition {
  const argsSchema = SUMMARY_TOOL_ARGUMENT_SCHEMAS[toolName];
  const metadata = SUMMARY_TOOL_METADATA[toolName];
  return {
    type: 'function',
    exampleArgs: JsonObjectSchema.parse(argsSchema.parse(metadata.exampleArgs)),
    function: {
      name: toolName,
      description: metadata.description,
      parameters: buildPlannerJsonSchema(argsSchema),
    },
  };
}

const SUMMARY_TOOL_REGISTRY = {
  find_text: buildSummaryToolDefinition('find_text'),
  read_lines: buildSummaryToolDefinition('read_lines'),
  json_filter: buildSummaryToolDefinition('json_filter'),
  json_get: buildSummaryToolDefinition('json_get'),
} as const satisfies Record<SummaryPlannerToolName, PlannerToolDefinition>;

export function buildSummaryPlannerToolDefinitions(
  allowedTools: readonly SummaryPlannerToolName[] = SUMMARY_PLANNER_TOOL_NAMES,
): PlannerToolDefinition[] {
  const allowed = new Set<SummaryPlannerToolName>(allowedTools);
  return SUMMARY_PLANNER_TOOL_NAMES
    .filter((toolName) => allowed.has(toolName))
    .map((toolName) => SUMMARY_TOOL_REGISTRY[toolName]);
}
