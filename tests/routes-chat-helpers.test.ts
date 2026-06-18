import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withEffectiveWebTools,
  resolveEffectiveRepoFileListing,
  resolveEffectiveAgentsMd,
  resolveRepoSearchAutoAppendOverrides,
} from '../src/status-server/routes/chat.js';
import type { PresetToolName } from '../src/presets.js';

test('withEffectiveWebTools returns input unchanged when disabled', () => {
  const tools: PresetToolName[] = ['find_text'];
  assert.deepEqual(withEffectiveWebTools(tools, false), ['find_text']);
});

test('withEffectiveWebTools adds web tools without duplicates when enabled', () => {
  const result = withEffectiveWebTools(['web_search'], true);
  assert.deepEqual([...(result ?? [])].sort(), ['web_fetch', 'web_search']);
});

test('withEffectiveWebTools returns undefined input unchanged', () => {
  assert.equal(withEffectiveWebTools(undefined, true), undefined);
});

test('resolveEffectiveRepoFileListing is true unless config or preset disables it', () => {
  assert.equal(resolveEffectiveRepoFileListing({ IncludeRepoFileListing: true }, null), true);
  assert.equal(resolveEffectiveRepoFileListing({ IncludeRepoFileListing: false }, null), false);
  assert.equal(resolveEffectiveRepoFileListing({ IncludeRepoFileListing: true }, { includeRepoFileListing: false }), false);
});

test('resolveEffectiveAgentsMd is true unless config or preset disables it', () => {
  assert.equal(resolveEffectiveAgentsMd({ IncludeAgentsMd: true }, null), true);
  assert.equal(resolveEffectiveAgentsMd({ IncludeAgentsMd: false }, null), false);
  assert.equal(resolveEffectiveAgentsMd({ IncludeAgentsMd: true }, { includeAgentsMd: false }), false);
});

test('resolveRepoSearchAutoAppendOverrides prefers explicit boolean overrides', () => {
  const config = { IncludeAgentsMd: true, IncludeRepoFileListing: true };
  assert.deepEqual(
    resolveRepoSearchAutoAppendOverrides(config, null, { includeAgentsMd: false, includeRepoFileListing: false }),
    { includeAgentsMd: false, includeRepoFileListing: false },
  );
});

test('resolveRepoSearchAutoAppendOverrides falls back to effective defaults when override absent', () => {
  const config = { IncludeAgentsMd: true, IncludeRepoFileListing: true };
  assert.deepEqual(
    resolveRepoSearchAutoAppendOverrides(config, null, {}),
    { includeAgentsMd: true, includeRepoFileListing: true },
  );
});
