import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildRepoSearchPlannerActionJsonSchema } from '../src/providers/structured-output-schema.js';
import {
  buildPlannerRequestPromptReserveText,
  resolveRepoSearchPlannerToolDefinitions,
} from '../src/repo-search/planner-protocol.js';
import { mockSiftConfig } from './helpers/mock-config.js';

function configForBackend(backend: 'llama' | 'exl3') {
  return mockSiftConfig({
    Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', Backend: backend, IdleAction: 'unload' }] } },
  });
}

// With no tools the schema still exposes both canonical non-tool actions.
const JsonObjectSchema = z.record(z.string(), z.json());
const PlannerRequestBodySchema = z
  .object({
    response_format: z.object({
      json_schema: z.object({ schema: JsonObjectSchema }),
    }),
  })
  .passthrough();

test('zero tool definitions retain only canonical non-tool actions', () => {
  const rawSchema = buildRepoSearchPlannerActionJsonSchema({
    toolDefinitions: [],
  });
  const schemaText = JSON.stringify(rawSchema);
  assert.match(schemaText, /"const":"progress"/u);
  assert.match(schemaText, /"const":"finish"/u);
  assert.doesNotMatch(schemaText, /tool_batch|grep|read/u);
});

test('planner request with empty toolDefinitions emits canonical non-tool actions and no repo tools', () => {
  const body = PlannerRequestBodySchema.parse(
    JSON.parse(
      buildPlannerRequestPromptReserveText({
        config: configForBackend('llama'),
        stage: 'planner_action',
        model: 'mock',
        maxTokens: 256,
        messageRoles: ['system', 'user'],
        thinkingEnabled: false,
        reasoningContentEnabled: false,
        preserveThinking: false,
        toolDefinitions: [],
      }),
    ),
  );
  const schemaText = JSON.stringify(body.response_format.json_schema.schema);
  assert.match(schemaText, /"const":"progress"/u);
  assert.match(schemaText, /"const":"finish"/u);
  assert.doesNotMatch(schemaText, /tool_batch|grep|read/u);
});

test('planner prompt reserve mirrors backend-specific schema lowering', () => {
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions(['grep']);
  const common = {
    stage: 'planner_action',
    model: 'mock',
    maxTokens: 256,
    messageRoles: ['system', 'user'],
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
    toolDefinitions,
  };
  const llamaText = buildPlannerRequestPromptReserveText({
    ...common,
    config: configForBackend('llama'),
  });
  const exl3Text = buildPlannerRequestPromptReserveText({
    ...common,
    config: configForBackend('exl3'),
  });

  assert.match(llamaText, /"minItems":1/u);
  assert.match(llamaText, /"required":\["action","toolName","args"\]/u);
  assert.match(llamaText, /"required":\["pattern"\]/u);
  assert.doesNotMatch(exl3Text, /"minItems"/u);
  assert.match(exl3Text, /"path":\{"anyOf":\[\{/u);
  assert.match(exl3Text, /"description":"Directory or file to search \(default: repository root\)"/u);
  assert.match(exl3Text, /"required":\["action","toolName","args"\]/u);
  assert.match(exl3Text, /"required":\["pattern","path","glob","ignoreCase","literal","context","limit"\]/u);
});
