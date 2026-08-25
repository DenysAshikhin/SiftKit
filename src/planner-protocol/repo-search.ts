import { type JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import { RepoNativeToolCallSchema } from '../repo-search/repo-tool-arguments.js';
import {
  buildPlannerActionJsonSchema,
  buildPlannerJsonSchema,
  type PlannerToolDefinition,
} from './json-schema.js';
import { buildPlannerToolInstructions } from './tool-instructions.js';
import {
  parsePlannerToolAction,
  parsePlannerToolBatchAction,
  PlannerToolActionEnvelopeSchema,
  PlannerToolBatchEnvelopeSchema,
} from './parser.js';

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

export const RepoSearchToolActionSchema = PlannerToolActionEnvelopeSchema;
export const RepoSearchToolBatchActionSchema = PlannerToolBatchEnvelopeSchema;

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
  toolNames: string[];
  actionInstructions: string;
  jsonSchema: JsonObject;
};

const REPO_SEARCH_NON_TOOL_ACTIONS = [
  {
    action: 'progress',
    schema: RepoSearchProgressActionSchema,
    description: 'Progress is optional. Use it sparingly, only for a meaningful phase change or a checkpoint after substantial work. Do not narrate routine next steps.',
    example: '{"action":"progress","output":"RED test confirmed; implementing the minimum fix now"}',
  },
  {
    action: 'finish',
    schema: RepoSearchFinishActionSchema,
    description: 'Return the final result only when the task is complete',
    example: buildRepoSearchFinishActionExample('<concise final result>'),
  },
] as const;

export function buildRepoSearchFinishActionExample(output: string): string {
  return JSON.stringify(RepoSearchFinishActionSchema.parse({ action: 'finish', output }));
}

export function getRepoSearchNonToolActionJsonSchemas(): JsonObject[] {
  return REPO_SEARCH_NON_TOOL_ACTIONS.map(({ schema }) => buildPlannerJsonSchema(schema));
}

export function buildRepoSearchActionInstructions(toolDefinitions: readonly PlannerToolDefinition[]): string {
  return [
    ...buildPlannerToolInstructions(toolDefinitions),
    ...REPO_SEARCH_NON_TOOL_ACTIONS.map(({ description, example }) => `${description}: ${example}`),
  ].join('\n');
}

function getRepoSearchPlannerActionNames(
  toolDefinitions: readonly PlannerToolDefinition[],
): string[] {
  return [
    ...(toolDefinitions.length > 0 ? ['tool', 'tool_batch'] : []),
    ...REPO_SEARCH_NON_TOOL_ACTIONS.map(({ action }) => action),
  ];
}

export function buildRepoSearchPlannerProtocol(
  toolDefinitions: readonly PlannerToolDefinition[],
): RepoSearchPlannerProtocol {
  const nonToolActionJsonSchemas = getRepoSearchNonToolActionJsonSchemas();
  return {
    actionNames: getRepoSearchPlannerActionNames(toolDefinitions),
    toolNames: toolDefinitions.map(({ function: definition }) => definition.name),
    actionInstructions: buildRepoSearchActionInstructions(toolDefinitions),
    jsonSchema: buildPlannerActionJsonSchema(toolDefinitions, nonToolActionJsonSchemas),
  };
}

function validateRepoToolAction(toolName: string, args: JsonObject): RepoSearchToolAction {
  const nativeCall = RepoNativeToolCallSchema.safeParse({ toolName, args });
  if (!nativeCall.success) {
    const issue = nativeCall.error.issues[0];
    const issuePath = issue?.path.map(String).join('.') || 'args';
    const issueMessage = issue?.message.replace(/[.\s]+$/u, '') || 'schema validation failed';
    throw new Error(`"${toolName}" has invalid "${issuePath}": ${issueMessage}`);
  }
  return RepoSearchToolActionSchema.parse({
    action: 'tool',
    toolName: nativeCall.data.toolName,
    args: nativeCall.data.args,
  });
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

  if (action === 'tool_batch') {
    const calls = parsePlannerToolBatchAction(parsed, toolDefinitions).map(({ toolName, args }, index) => {
      try {
        const validated = validateRepoToolAction(toolName, args);
        return { toolName: validated.toolName, args: validated.args };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Provider returned an invalid planner tool batch action: call ${index + 1} — ${message}`);
      }
    });
    return RepoSearchToolBatchActionSchema.parse({ action: 'tool_batch', calls });
  }

  const direct = parsePlannerToolAction(parsed, toolDefinitions);
  if (direct) {
    try {
      return validateRepoToolAction(direct.toolName, direct.args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Provider returned an invalid planner tool action: ${message}`);
    }
  }

  const validActions = getRepoSearchPlannerActionNames(toolDefinitions).slice().sort().join(', ');
  throw new Error(`Provider returned an unknown planner action "${action}"; valid actions: ${validActions}`);
}
