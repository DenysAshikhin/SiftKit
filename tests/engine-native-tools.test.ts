import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
import {
  buildEffectiveTranscriptAction,
  buildNativeRepoToolRequestedCommand,
  buildRepoReadFileCommand,
  executeNativeRepoTool,
  isFailedRepoReadFilePlan,
  planRepoReadFile,
} from '../src/repo-search/engine/native-tools.js';
import { WebResearchTools } from '../src/web-search/web-research-tools.js';

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-native-tools-'));
  fs.mkdirSync(path.join(root, 'src'));
  // node_modules is on the baseline ignore list used by buildIgnorePolicy.
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'line1\nline2\nline3\n', 'utf8');
  fs.writeFileSync(path.join(root, 'node_modules', 'b.ts'), 'hidden\n', 'utf8');
  return root;
}

function makeWebTools(): WebResearchTools {
  return new WebResearchTools({
    EnabledDefault: false,
    Providers: { tavily: { Enabled: false, ApiKey: '' }, firecrawl: { Enabled: false, ApiKey: '' } },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5, FetchMaxPages: 3, TimeoutMs: 15000, FetchMaxCharacters: 12000,
  });
}

test('buildRepoReadFileCommand clamps bounds and serializes endLine only when positive', () => {
  assert.equal(buildRepoReadFileCommand('src/a.ts', 0), 'repo_read_file path="src/a.ts" startLine=1');
  assert.equal(buildRepoReadFileCommand('src/a.ts', 2, 9), 'repo_read_file path="src/a.ts" startLine=2 endLine=9');
});

test('buildNativeRepoToolRequestedCommand covers all native tools', () => {
  assert.equal(
    buildNativeRepoToolRequestedCommand('repo_read_file', { path: 'src/a.ts', startLine: 1, endLine: 2 }),
    'repo_read_file path="src/a.ts" startLine=1 endLine=2',
  );
  assert.equal(buildNativeRepoToolRequestedCommand('web_search', { query: ' q ' }), 'web_search query="q"');
  assert.equal(buildNativeRepoToolRequestedCommand('web_fetch', { url: 'https://x' }), 'web_fetch url="https://x"');
  assert.equal(
    buildNativeRepoToolRequestedCommand('repo_list_files', { path: 'src', glob: '*.ts' }),
    'repo_list_files path="src" glob="*.ts" recurse=true',
  );
});

test('planRepoReadFile rejects escapes, ignored, and missing paths', () => {
  const root = makeRepo();
  const policy = buildIgnorePolicy(root);
  const escape = planRepoReadFile({ path: '../outside.ts', startLine: 1 }, root, policy);
  assert.ok(isFailedRepoReadFilePlan(escape) && /repository root/u.test(escape.reason));
  const ignored = planRepoReadFile({ path: 'node_modules/b.ts', startLine: 1 }, root, policy);
  assert.ok(isFailedRepoReadFilePlan(ignored) && /ignored/u.test(ignored.reason));
  const missing = planRepoReadFile({ path: 'src/nope.ts', startLine: 1 }, root, policy);
  assert.ok(isFailedRepoReadFilePlan(missing) && /readable file/u.test(missing.reason));
});

test('planRepoReadFile returns a numbered window for a valid path', () => {
  const root = makeRepo();
  const plan = planRepoReadFile({ path: 'src/a.ts', startLine: 1, endLine: 2 }, root, buildIgnorePolicy(root));
  assert.ok(!isFailedRepoReadFilePlan(plan));
  assert.equal(plan.displayPath, 'src/a.ts');
  assert.equal(plan.effectiveStartLine, 1);
  assert.equal(plan.effectiveEndLineExclusive, 3);
  assert.equal(plan.hasUnread, true);
});

test('executeNativeRepoTool lists files honoring ignore policy and glob', async () => {
  const root = makeRepo();
  const result = await executeNativeRepoTool(
    'repo_list_files', { path: '.', glob: '*.ts' }, root, buildIgnorePolicy(root), makeWebTools(),
  );
  assert.ok(result.ok);
  assert.equal(result.output, 'src/a.ts');
});

test('buildEffectiveTranscriptAction re-parses executed repo_read_file commands', () => {
  const action = buildEffectiveTranscriptAction({
    toolName: 'repo_read_file',
    rawArgs: { path: 'src/a.ts', startLine: 1, endLine: 99 },
    isNativeTool: true,
    commandToRun: 'repo_read_file path="src/a.ts" startLine=1 endLine=2',
  });
  assert.deepEqual(action, { tool_name: 'repo_read_file', args: { path: 'src/a.ts', startLine: 1, endLine: 2 } });
});
