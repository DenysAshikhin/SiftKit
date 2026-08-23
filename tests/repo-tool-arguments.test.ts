import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_RUN_TIMEOUT_MS } from '../src/lib/powershell.js';
import {
  RepoNativeToolCallSchema,
  RUN_OUTPUT_MODES,
  RunOutputModeSchema,
} from '../src/repo-search/repo-tool-arguments.js';
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from '../src/repo-search/engine/runtime-profile.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';

test('canonical schema accepts and normalizes every native repo-tool call', () => {
  const cases = [
    {
      input: { toolName: 'read', args: { path: '  src\tests  ', offset: 1, limit: 20 } },
      output: { toolName: 'read', args: { path: String.raw`src\tests`, offset: 1, limit: 20 } },
    },
    {
      input: { toolName: 'grep', args: {
        pattern: '  needle  ',
        path: '  src  ',
        glob: '  **/*.ts  ',
        ignoreCase: false,
        literal: true,
        context: 0,
        limit: 10,
      } },
      output: { toolName: 'grep', args: {
        pattern: 'needle', path: 'src', glob: '**/*.ts', ignoreCase: false, literal: true, context: 0, limit: 10,
      } },
    },
    {
      input: { toolName: 'find', args: { pattern: '  **/*.ts  ', path: '  src  ', limit: 10 } },
      output: { toolName: 'find', args: { pattern: '**/*.ts', path: 'src', limit: 10 } },
    },
    {
      input: { toolName: 'ls', args: { path: '  .  ', limit: 10 } },
      output: { toolName: 'ls', args: { path: '.', limit: 10 } },
    },
    {
      input: { toolName: 'write', args: { path: '  out.txt  ', content: '\n' } },
      output: { toolName: 'write', args: { path: 'out.txt', content: '\n' } },
    },
    {
      input: {
        toolName: 'edit',
        args: { path: '  out.txt  ', edits: [{ oldText: ' before\n', newText: '\tafter\n' }] },
      },
      output: {
        toolName: 'edit',
        args: { path: 'out.txt', edits: [{ oldText: ' before\n', newText: '\tafter\n' }] },
      },
    },
    {
      input: { toolName: 'run', args: { command: '  npm test  ', timeoutMs: 60, outputMode: 'full' } },
      output: { toolName: 'run', args: { command: 'npm test', timeoutMs: 60, outputMode: 'full' } },
    },
    {
      input: { toolName: 'web_search', args: { query: '  current docs  ', timeFilter: 'month' } },
      output: { toolName: 'web_search', args: { query: 'current docs', timeFilter: 'month' } },
    },
    {
      input: { toolName: 'web_fetch', args: { url: '  https://example.com  ' } },
      output: { toolName: 'web_fetch', args: { url: 'https://example.com' } },
    },
  ];

  for (const fixture of cases) {
    assert.deepEqual(RepoNativeToolCallSchema.parse(fixture.input), fixture.output);
  }
  assert.deepEqual(RUN_OUTPUT_MODES, ['auto', 'full']);
  assert.equal(RunOutputModeSchema.parse('auto'), 'auto');
  assert.equal(RunOutputModeSchema.parse('full'), 'full');
});

test('canonical schema repairs path controls and recoverable command controls only', () => {
  assert.deepEqual(
    RepoNativeToolCallSchema.parse({ toolName: 'read', args: { path: 'dashboard\tests\react-env.ts' } }),
    { toolName: 'read', args: { path: String.raw`dashboard\tests\react-env.ts` } },
  );
  assert.deepEqual(
    RepoNativeToolCallSchema.parse({
      toolName: 'run',
      args: { command: 'Select-String dashboard\tests\test.ts\nWrite-Output done' },
    }),
    {
      toolName: 'run',
      args: { command: String.raw`Select-String dashboard\tests\test.ts` + '\nWrite-Output done' },
    },
  );
});

test('canonical schema preserves write and edit payloads verbatim', () => {
  const content = '\n\twrite payload\n';
  const oldText = '\n\told payload\n';
  const newText = '\n\tnew payload\n';

  assert.deepEqual(
    RepoNativeToolCallSchema.parse({ toolName: 'write', args: { path: 'out.txt', content } }),
    { toolName: 'write', args: { path: 'out.txt', content } },
  );
  assert.deepEqual(
    RepoNativeToolCallSchema.parse({
      toolName: 'edit',
      args: { path: 'out.txt', edits: [{ oldText, newText }] },
    }),
    { toolName: 'edit', args: { path: 'out.txt', edits: [{ oldText, newText }] } },
  );
});

test('canonical schema rejects malformed native arguments at the model boundary', () => {
  const calls = [
    { toolName: 'read', args: {} },
    { toolName: 'read', args: { path: 'x', offset: 0 } },
    { toolName: 'grep', args: { pattern: '   ' } },
    { toolName: 'grep', args: { pattern: 'x', ignoreCase: 'yes' } },
    { toolName: 'find', args: { pattern: '', limit: 1 } },
    { toolName: 'ls', args: { path: '   ' } },
    { toolName: 'write', args: { path: 'x', content: '' } },
    { toolName: 'edit', args: { path: 'x', edits: [] } },
    { toolName: 'edit', args: { path: 'x', edits: [{ oldText: '', newText: '' }] } },
    { toolName: 'run', args: { command: 'npm test', timeout: 60 } },
    { toolName: 'run', args: { command: 'npm test', timeoutMs: 0 } },
    { toolName: 'run', args: { command: 'npm test', timeoutMs: MAX_RUN_TIMEOUT_MS + 1 } },
    { toolName: 'run', args: { command: 'npm test', outputMode: 'verbose' } },
    { toolName: 'web_search', args: { query: 'x', timeFilter: 'decade' } },
    { toolName: 'web_fetch', args: { url: '   ' } },
    { toolName: 'unknown', args: {} },
    { toolName: 'read', args: { path: 'x', extra: true } },
  ];

  for (const call of calls) {
    assert.equal(RepoNativeToolCallSchema.safeParse(call).success, false, call.toolName);
  }
});

test('run planner metadata uses canonical modes and line limit', () => {
  const definition = resolveRepoSearchPlannerToolDefinitions(['run'])[0];
  if (!definition) {
    throw new Error('Expected the run tool definition.');
  }
  const parameters = definition.function.parameters;
  if (!parameters) {
    throw new Error('Expected run tool parameters.');
  }
  const outputMode = parameters.properties?.outputMode;
  if (!outputMode) {
    throw new Error('Expected run outputMode metadata.');
  }

  assert.deepEqual(outputMode.enum, RUN_OUTPUT_MODES);
  assert.match(
    outputMode.description ?? '',
    new RegExp(`final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines`, 'u'),
  );
});
