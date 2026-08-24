import test from 'node:test';
import assert from 'node:assert/strict';

import { isJsonObject, type JsonValue } from '../src/lib/json-types.js';
import { buildRepoSearchPlannerProtocol } from '../src/planner-protocol/repo-search.js';
import { buildSummaryPlannerProtocol } from '../src/planner-protocol/summary.js';
import { lowerResponseFormatForBackend } from '../src/providers/formatron-schema-lowering.js';
import {
  buildLlamaJsonSchemaResponseFormat,
  buildRepoSearchPlannerActionJsonSchema,
  buildSummaryPlannerActionJsonSchema,
} from '../src/providers/structured-output-schema.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { buildPlannerToolDefinitions } from '../src/summary/planner/tools.js';

function collectActionConstants(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectActionConstants);
  }
  if (!isJsonObject(value)) {
    return [];
  }
  const direct = typeof value.const === 'string' ? [value.const] : [];
  return [...direct, ...Object.values(value).flatMap(collectActionConstants)];
}

function uniqueActionConstants(value: JsonValue): string[] {
  return [...new Set(collectActionConstants(value))];
}

test('repo-search progress is present in canonical and ExL3 planner schemas', () => {
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions(['read', 'grep']);
  const protocol = buildRepoSearchPlannerProtocol(toolDefinitions);
  const schema = buildRepoSearchPlannerActionJsonSchema({ toolDefinitions });
  const responseFormat = buildLlamaJsonSchemaResponseFormat({ name: 'repo', schema });
  const lowered = lowerResponseFormatForBackend('exl3', responseFormat);

  assert.deepEqual(uniqueActionConstants(schema), protocol.actionNames);
  assert.equal(lowered.type, 'json_schema');
  if (lowered.type !== 'json_schema') {
    throw new Error('Expected an ExL3 JSON Schema response format.');
  }
  assert.deepEqual(uniqueActionConstants(lowered.json_schema.schema), protocol.actionNames);
  assert.deepEqual(uniqueActionConstants(protocol.jsonSchema), protocol.actionNames);
});

test('protocol instructions omit tool and batch actions when no tools are available', () => {
  const repo = buildRepoSearchPlannerProtocol([]);
  const summary = buildSummaryPlannerProtocol([], false);

  assert.deepEqual(repo.actionNames, ['progress', 'finish']);
  assert.doesNotMatch(repo.actionInstructions, /Tool:|tool_batch|grep/u);
  assert.deepEqual(summary.actionNames, ['finish']);
  assert.doesNotMatch(summary.actionInstructions, /Tool:|tool_batch|\(none\)/u);
});

test('summary planner exposes one canonical action set without progress', () => {
  const protocol = buildSummaryPlannerProtocol(buildPlannerToolDefinitions(), false);
  const schema = buildSummaryPlannerActionJsonSchema({
    toolDefinitions: buildPlannerToolDefinitions(),
    allowUnsupportedInput: false,
  });

  assert.deepEqual(protocol.actionNames, [
    'find_text',
    'read_lines',
    'json_filter',
    'json_get',
    'tool_batch',
    'finish',
  ]);
  assert.equal(protocol.actionNames.includes('progress'), false);
  assert.deepEqual(uniqueActionConstants(schema), protocol.actionNames);
  assert.equal(protocol.finishSchema.safeParse({
    action: 'finish',
    classification: 'summary',
    raw_review_required: false,
    output: 'final answer',
  }).success, true);
});
