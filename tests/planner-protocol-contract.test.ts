import test from 'node:test';
import assert from 'node:assert/strict';

import { isJsonObject, JsonObjectSchema, type JsonObject, type JsonValue } from '../src/lib/json-types.js';
import {
  buildRepoSearchPlannerProtocol,
  parseRepoSearchPlannerAction,
} from '../src/planner-protocol/repo-search.js';
import {
  buildSummaryPlannerProtocol,
  parseSummaryPlannerAction,
} from '../src/planner-protocol/summary.js';
import { lowerResponseFormatForBackend } from '../src/providers/formatron-schema-lowering.js';
import {
  buildLlamaJsonSchemaResponseFormat,
  buildRepoSearchPlannerActionJsonSchema,
  buildSummaryPlannerActionJsonSchema,
} from '../src/providers/structured-output-schema.js';
import { buildPlannerToolActionExample } from '../src/planner-protocol/json-schema.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { buildPlannerToolDefinitions } from '../src/summary/planner/tools.js';

function collectPropertyConstants(value: JsonValue, propertyName: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectPropertyConstants(entry, propertyName));
  }
  if (!isJsonObject(value)) {
    return [];
  }
  const properties = isJsonObject(value.properties) ? value.properties : null;
  const property = properties && isJsonObject(properties[propertyName]) ? properties[propertyName] : null;
  const direct = property && typeof property.const === 'string' ? [property.const] : [];
  return [
    ...direct,
    ...Object.values(value).flatMap((entry) => collectPropertyConstants(entry, propertyName)),
  ];
}

function uniquePropertyConstants(value: JsonValue, propertyName: string): string[] {
  return [...new Set(collectPropertyConstants(value, propertyName))];
}

const REPO_DIRECT_ACTION: JsonObject = {
  action: 'tool',
  toolName: 'git',
  args: { operation: 'status' },
};

const REPO_BATCH_ACTION: JsonObject = {
  action: 'tool_batch',
  calls: [
    { toolName: 'read', args: { path: 'src/app.ts', offset: 1, limit: 80 } },
    { toolName: 'git', args: { operation: 'diff' } },
  ],
};

test('canonical repo and summary tool envelopes accept only nested camelCase fields', () => {
  const repoTools = resolveRepoSearchPlannerToolDefinitions(['read', 'git']);
  assert.deepEqual(parseRepoSearchPlannerAction(REPO_DIRECT_ACTION, repoTools), REPO_DIRECT_ACTION);
  assert.deepEqual(parseRepoSearchPlannerAction(REPO_BATCH_ACTION, repoTools), REPO_BATCH_ACTION);

  const summaryTools = buildPlannerToolDefinitions(['json_filter']);
  const summaryAction: JsonObject = {
    action: 'tool',
    toolName: 'json_filter',
    args: { filters: [{ path: 'status', op: 'eq', value: 'failed' }] },
  };
  assert.deepEqual(parseSummaryPlannerAction(summaryAction, summaryTools), summaryAction);

  const obsoleteShapes: JsonObject[] = [
    { action: 'git', operation: 'status' },
    { action: 'git', args: { operation: 'status' } },
    { action: 'tool', tool_name: 'git', args: { operation: 'status' } },
    { action: 'tool_batch', tool_calls: [{ tool_name: 'git', args: { operation: 'status' } }] },
    { action: 'tool_batch', calls: [{ action: 'git', operation: 'status' }] },
  ];
  for (const obsolete of obsoleteShapes) {
    assert.throws(() => parseRepoSearchPlannerAction(obsolete, repoTools), /invalid|unknown|unavailable/u);
  }
});

test('repo-search progress is present in canonical and ExL3 planner schemas', () => {
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions(['read', 'grep']);
  const protocol = buildRepoSearchPlannerProtocol(toolDefinitions);
  const schema = buildRepoSearchPlannerActionJsonSchema({ toolDefinitions });
  const responseFormat = buildLlamaJsonSchemaResponseFormat({ name: 'repo', schema });
  const lowered = lowerResponseFormatForBackend('exl3', responseFormat);

  assert.deepEqual(uniquePropertyConstants(schema, 'action'), protocol.actionNames);
  assert.deepEqual(uniquePropertyConstants(schema, 'toolName'), protocol.toolNames);
  assert.equal(lowered.type, 'json_schema');
  if (lowered.type !== 'json_schema') {
    throw new Error('Expected an ExL3 JSON Schema response format.');
  }
  assert.deepEqual(uniquePropertyConstants(lowered.json_schema.schema, 'action'), protocol.actionNames);
  assert.deepEqual(uniquePropertyConstants(lowered.json_schema.schema, 'toolName'), protocol.toolNames);
  assert.deepEqual(uniquePropertyConstants(protocol.jsonSchema, 'action'), protocol.actionNames);
  assert.deepEqual(uniquePropertyConstants(protocol.jsonSchema, 'toolName'), protocol.toolNames);
});

test('protocol instructions omit tool and batch actions when no tools are available', () => {
  const repo = buildRepoSearchPlannerProtocol([]);
  const summary = buildSummaryPlannerProtocol([], false);

  assert.deepEqual(repo.actionNames, ['progress', 'finish']);
  assert.deepEqual(repo.toolNames, []);
  assert.doesNotMatch(repo.actionInstructions, /Tool:|tool_batch|grep/u);
  assert.deepEqual(summary.actionNames, ['finish']);
  assert.deepEqual(summary.toolNames, []);
  assert.doesNotMatch(summary.actionInstructions, /Tool:|tool_batch|\(none\)/u);
});

test('summary planner exposes one canonical action set without progress', () => {
  const protocol = buildSummaryPlannerProtocol(buildPlannerToolDefinitions(), false);
  const schema = buildSummaryPlannerActionJsonSchema({
    toolDefinitions: buildPlannerToolDefinitions(),
    allowUnsupportedInput: false,
  });

  assert.deepEqual(protocol.actionNames, ['tool', 'tool_batch', 'finish']);
  assert.deepEqual(protocol.toolNames, ['find_text', 'read_lines', 'json_filter', 'json_get']);
  assert.equal(protocol.actionNames.includes('progress'), false);
  assert.deepEqual(uniquePropertyConstants(schema, 'action'), protocol.actionNames);
  assert.deepEqual(uniquePropertyConstants(schema, 'toolName'), protocol.toolNames);
  assert.equal(protocol.finishSchema.safeParse({
    action: 'finish',
    classification: 'summary',
    raw_review_required: false,
    output: 'final answer',
  }).success, true);
});

test('every repo and summary tool exposes one validated canonical example', () => {
  const repoTools = resolveRepoSearchPlannerToolDefinitions([
    'read',
    'grep',
    'find',
    'ls',
    'write',
    'edit',
    'run',
    'git',
    'web_search',
    'web_fetch',
  ]);
  const summaryTools = buildPlannerToolDefinitions();

  assert.deepEqual(repoTools.map((tool) => tool.function.name), [
    'read',
    'grep',
    'find',
    'ls',
    'write',
    'edit',
    'run',
    'git',
    'web_search',
    'web_fetch',
  ]);
  assert.deepEqual(summaryTools.map((tool) => tool.function.name), [
    'find_text',
    'read_lines',
    'json_filter',
    'json_get',
  ]);

  for (const tool of repoTools) {
    const exampleText = buildPlannerToolActionExample(tool);
    assert.deepEqual(
      parseRepoSearchPlannerAction(JsonObjectSchema.parse(JSON.parse(exampleText)), repoTools),
      { action: 'tool', toolName: tool.function.name, args: tool.exampleArgs },
    );
  }
  for (const tool of summaryTools) {
    const exampleText = buildPlannerToolActionExample(tool);
    assert.deepEqual(
      parseSummaryPlannerAction(JsonObjectSchema.parse(JSON.parse(exampleText)), summaryTools),
      { action: 'tool', toolName: tool.function.name, args: tool.exampleArgs },
    );
  }
});
