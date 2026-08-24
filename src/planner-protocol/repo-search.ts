import { JsonObjectSchema, type JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import { buildPlannerActionJsonSchema, type PlannerToolDefinition } from './json-schema.js';
import { parsePlannerToolAction, parsePlannerToolBatchAction } from './parser.js';
import { RepoNativeToolCallSchema } from '../repo-search/repo-tool-arguments.js';

const NonEmptyOutputSchema = z.string().trim().min(1);

export const RepoSearchProgressActionSchema = z.strictObject({
  action: z.literal('progress'),
  output: NonEmptyOutputSchema,
});

export const RepoSearchFinishActionSchema = z.strictObject({
  action: z.literal('finish'),
  output: NonEmptyOutputSchema,
});

export const RepoSearchNonToolActionSchema = z.union([
  RepoSearchProgressActionSchema,
  RepoSearchFinishActionSchema,
]);

export type RepoSearchProgressAction = z.infer<typeof RepoSearchProgressActionSchema>;
export type RepoSearchFinishAction = z.infer<typeof RepoSearchFinishActionSchema>;

export const RepoSearchToolActionSchema = z.strictObject({
  action: z.literal('tool'),
  tool_name: z.string().trim().min(1),
  args: JsonObjectSchema,
});

export const RepoSearchToolBatchActionSchema = z.strictObject({
  action: z.literal('tool_batch'),
  tool_calls: z.array(RepoSearchToolActionSchema.omit({ action: true })).min(1),
});

export const RepoSearchPlannerActionSchema = z.union([
  RepoSearchToolActionSchema,
  RepoSearchToolBatchActionSchema,
  RepoSearchProgressActionSchema,
  RepoSearchFinishActionSchema,
]);

export type RepoSearchToolAction = z.infer<typeof RepoSearchToolActionSchema>;
export type RepoSearchToolBatchAction = z.infer<typeof RepoSearchToolBatchActionSchema>;
export type RepoSearchPlannerAction = z.infer<typeof RepoSearchPlannerActionSchema>;

/** Tools offered to non-interactive repository search. */
export const EXPOSED_REPO_TOOL_NAMES = ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch'] as const;

/** Full repository tool surface for human-approved runs. */
export const INTERACTIVE_REPO_TOOL_NAMES = [...EXPOSED_REPO_TOOL_NAMES, 'write', 'edit', 'run'] as const;

export type RepoSearchPlannerProtocol = {
  actionNames: string[];
  actionInstructions: string;
  jsonSchema: JsonObject;
};

const REPO_SEARCH_NON_TOOL_ACTIONS = [
  {
    action: 'progress',
    schema: RepoSearchProgressActionSchema,
    description: 'Record a non-terminal one-line status; the run continues with the next action',
    example: '{"action":"progress","output":"scanning scripts next"}',
  },
  {
    action: 'finish',
    schema: RepoSearchFinishActionSchema,
    description: 'Return the final result only when the task is complete',
    example: buildRepoSearchFinishActionExample('<concise final result>'),
  },
] as const;

const TOOL_BATCH_INSTRUCTION =
  'Batch independent tool calls with action "tool_batch" and a non-empty "calls" array of direct tool actions.';

export function buildRepoSearchFinishActionExample(output: string): string {
  return JSON.stringify(RepoSearchFinishActionSchema.parse({ action: 'finish', output }));
}

function toJsonSchema(schema: typeof RepoSearchProgressActionSchema | typeof RepoSearchFinishActionSchema): JsonObject {
  return JsonObjectSchema.parse(z.toJSONSchema(schema, { io: 'input' }));
}

export function getRepoSearchNonToolActionJsonSchemas(): JsonObject[] {
  return REPO_SEARCH_NON_TOOL_ACTIONS.map(({ schema }) => toJsonSchema(schema));
}

export function buildRepoSearchActionInstructions(toolNames: readonly string[]): string {
  const directTools = toolNames.length > 0 ? toolNames.join(', ') : '(none)';
  const toolInstructions = toolNames.length > 0 ? [
    `Tool: {"action":"<tool>", ...args}. Allowed tools: ${directTools}.`,
    TOOL_BATCH_INSTRUCTION,
  ] : [];
  return [
    ...toolInstructions,
    ...REPO_SEARCH_NON_TOOL_ACTIONS.map(({ description, example }) => `${description}: ${example}`),
  ].join('\n');
}

export function buildRepoSearchPlannerProtocol(
  toolDefinitions: readonly PlannerToolDefinition[],
): RepoSearchPlannerProtocol {
  const toolNames = toolDefinitions.map(({ function: definition }) => definition.name);
  const nonToolActionJsonSchemas = getRepoSearchNonToolActionJsonSchemas();
  return {
    actionNames: [
      ...toolNames,
      ...(toolNames.length > 0 ? ['tool_batch'] : []),
      ...REPO_SEARCH_NON_TOOL_ACTIONS.map(({ action }) => action),
    ],
    actionInstructions: buildRepoSearchActionInstructions(toolNames),
    jsonSchema: buildPlannerActionJsonSchema(toolDefinitions, nonToolActionJsonSchemas),
  };
}

export function parseRepoSearchPlannerAction(
  parsed: JsonObject,
  toolDefinitions: readonly PlannerToolDefinition[],
): RepoSearchPlannerAction {
  const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
  if (action === 'progress' || action === 'finish') {
    const result = action === 'progress'
      ? RepoSearchProgressActionSchema.safeParse(parsed)
      : RepoSearchFinishActionSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Provider returned an invalid planner ${action} action: ${result.error.issues[0]?.message ?? 'schema validation failed'}`);
    }
    return result.data;
  }

  const normalizeTool = (toolName: string, args: JsonObject): RepoSearchToolAction => {
    const nativeCall = RepoNativeToolCallSchema.safeParse({ toolName, args });
    if (!nativeCall.success) {
      const issue = nativeCall.error.issues[0];
      const issuePath = issue?.path.map(String).join('.') || 'args';
      const issueMessage = issue?.message.replace(/[.\s]+$/u, '') || 'schema validation failed';
      throw new Error(`"${toolName}" has invalid "${issuePath}": ${issueMessage}`);
    }
    return RepoSearchToolActionSchema.parse({
      action: 'tool',
      tool_name: nativeCall.data.toolName,
      args: nativeCall.data.args,
    });
  };

  if (action === 'tool_batch') {
    const toolCalls = parsePlannerToolBatchAction(parsed, toolDefinitions).map(({ toolName, args }, index) => {
      try {
        return normalizeTool(toolName, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Provider returned an invalid planner tool batch action: call ${index + 1} — ${message}`);
      }
    });
    return RepoSearchToolBatchActionSchema.parse({
      action: 'tool_batch',
      tool_calls: toolCalls.map(({ tool_name, args }) => ({ tool_name, args })),
    });
  }

  const direct = parsePlannerToolAction(parsed, toolDefinitions);
  if (direct) {
    try {
      return normalizeTool(direct.toolName, direct.args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Provider returned an invalid planner tool action: ${message}`);
    }
  }

  const validActions = buildRepoSearchPlannerProtocol(toolDefinitions).actionNames.slice().sort().join(', ');
  throw new Error(`Provider returned an unknown planner action "${action}"; valid actions: ${validActions}`);
}
