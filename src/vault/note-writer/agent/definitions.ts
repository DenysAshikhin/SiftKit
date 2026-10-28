import type { AgentLoopFinishAction } from '../../../agent-loop/types.ts';
import { JsonObjectSchema, type JsonObject } from '../../../lib/json-types.ts';
import { z } from '../../../lib/zod.ts';
import type { InferenceToolDefinition } from '../../../llm-protocol/types.ts';
import { buildPlannerJsonSchema, type PlannerToolDefinition } from '../../../planner-protocol/json-schema.ts';
import { VaultEditResponseSchema } from '../edit-ops.ts';
import { DayContextArgsSchema, NeighborsArgsSchema, ReadNoteArgsSchema, SearchNotesArgsSchema } from './tools.ts';

function readTool<T extends z.ZodType>(name: string, description: string, schema: T, exampleArgs: JsonObject): PlannerToolDefinition {
  return {
    kind: 'tool', type: 'function', exampleArgs,
    argumentSchema: schema.transform((args) => JsonObjectSchema.parse(args)),
    function: { name, description, parameters: buildPlannerJsonSchema(schema) },
  };
}

export const SUBMIT_EDITS_TOOL: PlannerToolDefinition = {
  kind: 'finish', type: 'function', exampleArgs: { operations: [] },
  argumentSchema: VaultEditResponseSchema.transform((args): AgentLoopFinishAction => ({ kind: 'finish', text: '', rawAction: JsonObjectSchema.parse(args) })),
  function: { name: 'submit_edits', description: 'Submit the final vault edits. This ends the job.', parameters: buildPlannerJsonSchema(VaultEditResponseSchema) },
};

export const VAULT_WRITER_TOOLS: readonly PlannerToolDefinition[] = [
  readTool('search_notes', 'Full-text search over note titles, aliases and bodies. Returns title, folder, types, aliases and a snippet.', SearchNotesArgsSchema, { query: 'neovim', limit: 5 }),
  readTool('read_note', 'Read one note by title or alias: lead, fact values with their ages, open tasks, unverified items, aliases and backlinks. 40 values per page.', ReadNoteArgsSchema, { title: 'Neovim', page: 1 }),
  readTool('neighbors', 'Relations around a note as "A —Label→ B", one or two hops.', NeighborsArgsSchema, { title: 'Neovim', depth: 1 }),
  readTool('day_context', "The day's earlier captures and chats, with what each taught.", DayContextArgsSchema, {}),
  SUBMIT_EDITS_TOOL,
];

export const toInferenceTool = (definition: PlannerToolDefinition): InferenceToolDefinition => ({ type: 'function', function: definition.function });
