import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REMOVED_BACKEND_REQUEST_OVERRIDES_KEY } from './helpers/legacy-backend-fixtures.js';

// Every inference request derives its sampling and reasoning from the
// single active ModelRuntimePreset. These patterns are the shapes that previously
// bypassed it; re-introducing one silently splits the source of truth again.

const SRC_ROOT = join(process.cwd(), 'src');

const BANNED_PER_FILE = [
  {
    file: 'src/repo-search/planner-protocol.ts',
    pattern: /temperature:\s*0\.1|topP:\s*0\.95|top_p:\s*0\.95|getDefaultConfigObject/u,
    reason: 'planner samplers must come from the active preset, not a synthetic config',
  },
  {
    file: 'src/status-server/routes/inference-passthrough.ts',
    pattern: /setNumberDefault/u,
    reason: 'passthrough must force preset samplers, not fill them in as defaults',
  },
  {
    file: 'src/state/chat-sessions.ts',
    pattern: /contextWindowTokens/u,
    reason: 'a chat session carries the whole preset snapshot, not a lone context size',
  },
] as const;

const BANNED_IN_SRC = [
  {
    pattern: new RegExp(REMOVED_BACKEND_REQUEST_OVERRIDES_KEY, 'u'),
    reason: 'per-request backend overrides are active-preset config overlays now',
  },
] as const;

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(entryPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

for (const { file, pattern, reason } of BANNED_PER_FILE) {
  test(`${file} does not bypass the active preset`, () => {
    assert.equal(pattern.test(readFileSync(join(process.cwd(), file), 'utf8')), false, reason);
  });
}

for (const { pattern, reason } of BANNED_IN_SRC) {
  test(`src/ is free of ${pattern.source}`, () => {
    const offenders = listTypeScriptFiles(SRC_ROOT)
      .filter((filePath) => pattern.test(readFileSync(filePath, 'utf8')))
      .map((filePath) => relative(process.cwd(), filePath));
    assert.deepEqual(offenders, [], reason);
  });
}
