import fs from 'node:fs';
import path from 'node:path';

import { buildIgnorePolicy } from '../../src/repo-search/command-safety.ts';
import type { JsonObject } from '../../src/lib/json-types.ts';
import type { RepoToolContext } from '../../src/repo-search/engine/repo-tools.ts';
import { resolveImageTokenBudget } from '../../src/llm-protocol/image-token-budget.ts';
import { RepoExecutableToolCallSchema, type RepoExecutableToolCall } from '../../src/repo-search/repo-tool-arguments.ts';
import { makeMockWebTools } from './mock-web-tools.ts';
import { makeTestPreset } from './model-presets.ts';
import { createManagedTempDir } from './temp-dirs.ts';

export function nativeCall(toolName: string, args: JsonObject): RepoExecutableToolCall {
  return RepoExecutableToolCallSchema.parse({ toolName, args });
}

export function makeRepo(): string {
  const root = createManagedTempDir('siftkit-repo-tools-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'src', 'nested'));
  // node_modules is on the baseline ignore list used by buildIgnorePolicy.
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'line1\nalpha\nline3\nalpha\nline5\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'nested', 'b.ts'), 'alpha nested\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'notes.md'), 'alpha in markdown\n', 'utf8');
  fs.writeFileSync(path.join(root, '.dotfile'), 'dot\n', 'utf8');
  fs.writeFileSync(path.join(root, 'node_modules', 'hidden.ts'), 'alpha hidden\n', 'utf8');
  return root;
}

export function makeContext(root: string): RepoToolContext {
  return {
    repoRoot: root,
    ignorePolicy: buildIgnorePolicy(root),
    webTools: makeMockWebTools(),
    expandReads: true,
    agentRunId: 'test-run',
    agentServerUrl: 'http://127.0.0.1:4765/status',
    visionEnabled: false,
    visionImageRetention: 8,
    visionMaxImagePixels: 0,
    imageTokenBudget: resolveImageTokenBudget(makeTestPreset()),
    liveImagePathKeys: new Set<string>(),
  };
}
