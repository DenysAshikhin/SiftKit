import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import test, { after, beforeEach } from 'node:test';

import { PresetSystemContextBuilder } from '../src/preset-system-context.js';

const TEST_ROOT = resolve('tests/.tmp/preset-system-context');
const REPO_ROOT = join(TEST_ROOT, 'repo');

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(join(REPO_ROOT, 'docs'), { recursive: true });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

test('builder loads enabled sources in stable order', () => {
  const absolutePolicyPath = join(TEST_ROOT, 'shared-policy.md');
  writeFileSync(join(REPO_ROOT, 'AGENTS.md'), 'Keep changes focused.', 'utf8');
  writeFileSync(join(REPO_ROOT, 'src.ts'), 'export const value = 1;', 'utf8');
  writeFileSync(join(REPO_ROOT, 'docs/local.md'), 'Local policy.', 'utf8');
  writeFileSync(absolutePolicyPath, 'Shared policy.', 'utf8');

  const context = new PresetSystemContextBuilder(REPO_ROOT).build({
    includeAgentsMd: true,
    includeRepoFileListing: true,
    autoloadFiles: ['docs/local.md', absolutePolicyPath],
  });

  const agentsIndex = context.content.indexOf('--- AGENTS.md (project-specific instructions) ---');
  const listingIndex = context.content.indexOf('--- Repository file listing (respects ignore policy) ---');
  const localIndex = context.content.indexOf('--- Autoloaded file: docs/local.md ---');
  const absoluteIndex = context.content.indexOf(`--- Autoloaded file: ${absolutePolicyPath} ---`);
  assert.equal(agentsIndex >= 0, true);
  assert.equal(agentsIndex < listingIndex && listingIndex < localIndex && localIndex < absoluteIndex, true);
  assert.match(context.content, /Keep changes focused\./u);
  assert.match(context.content, /src\.ts/u);
  assert.deepEqual(context.loadedFiles, ['docs/local.md', absolutePolicyPath]);
  assert.deepEqual(context.warnings, []);
  assert.equal(context.hasAgentsMd, true);
  assert.equal(context.hasRepoFileListing, true);
});

test('builder skips each invalid configured file with a specific warning', () => {
  mkdirSync(join(REPO_ROOT, 'directory'));
  writeFileSync(join(REPO_ROOT, 'empty.md'), ' \r\n ', 'utf8');

  const context = new PresetSystemContextBuilder(REPO_ROOT).build({
    includeAgentsMd: false,
    includeRepoFileListing: false,
    autoloadFiles: ['missing.md', 'empty.md', 'directory'],
  });

  assert.equal(context.content, '');
  assert.deepEqual(context.loadedFiles, []);
  assert.equal(context.warnings.length, 3);
  assert.match(context.warnings.join('\n'), /missing\.md.*does not exist/u);
  assert.match(context.warnings.join('\n'), /empty\.md.*empty/u);
  assert.match(context.warnings.join('\n'), /directory.*not a file/u);
  assert.equal(context.hasAgentsMd, false);
  assert.equal(context.hasRepoFileListing, false);
});

test('builder skips unreadable configured paths without aborting later files', () => {
  writeFileSync(join(REPO_ROOT, 'after.md'), 'Still loaded.', 'utf8');

  const context = new PresetSystemContextBuilder(REPO_ROOT).build({
    includeAgentsMd: false,
    includeRepoFileListing: false,
    autoloadFiles: ['invalid\0path', 'after.md'],
  });

  assert.equal(context.warnings.length, 1);
  assert.match(context.warnings[0] ?? '', /invalid.*could not be read/u);
  assert.deepEqual(context.loadedFiles, ['after.md']);
  assert.match(context.content, /Still loaded\./u);
});

test('builder omits disabled or unavailable built-in sources', () => {
  writeFileSync(join(REPO_ROOT, 'AGENTS.md'), 'Disabled policy.', 'utf8');
  writeFileSync(join(REPO_ROOT, 'src.ts'), 'export const value = 1;', 'utf8');

  const disabled = new PresetSystemContextBuilder(REPO_ROOT).build({
    includeAgentsMd: false,
    includeRepoFileListing: false,
    autoloadFiles: [],
  });
  assert.deepEqual(disabled, {
    content: '',
    warnings: [],
    hasAgentsMd: false,
    hasRepoFileListing: false,
    loadedFiles: [],
  });

  rmSync(join(REPO_ROOT, 'AGENTS.md'));
  rmSync(join(REPO_ROOT, 'src.ts'));
  const unavailable = new PresetSystemContextBuilder(REPO_ROOT).build({
    includeAgentsMd: true,
    includeRepoFileListing: true,
    autoloadFiles: [],
  });
  assert.equal(unavailable.content, '');
  assert.equal(unavailable.hasAgentsMd, false);
  assert.equal(unavailable.hasRepoFileListing, false);
});
