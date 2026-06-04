import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveEffectiveRepoFileListing,
  resolveEffectiveAgentsMd,
  resolveRepoSearchAutoAppendOverrides,
} from '../dist/status-server/routes/chat.js';

test('resolveEffectiveRepoFileListing disables initial repo file scan from global config', () => {
  assert.equal(
    resolveEffectiveRepoFileListing({ IncludeRepoFileListing: false }, { includeRepoFileListing: true }),
    false,
  );
});

test('resolveEffectiveRepoFileListing keeps preset-level disablement', () => {
  assert.equal(
    resolveEffectiveRepoFileListing({ IncludeRepoFileListing: true }, { includeRepoFileListing: false }),
    false,
  );
});

test('resolveEffectiveRepoFileListing defaults to enabled', () => {
  assert.equal(
    resolveEffectiveRepoFileListing({}, null),
    true,
  );
});

test('resolveEffectiveAgentsMd disables agents.md from global config', () => {
  assert.equal(
    resolveEffectiveAgentsMd({ IncludeAgentsMd: false }, { includeAgentsMd: true }),
    false,
  );
});

test('resolveEffectiveAgentsMd keeps preset-level disablement', () => {
  assert.equal(
    resolveEffectiveAgentsMd({ IncludeAgentsMd: true }, { includeAgentsMd: false }),
    false,
  );
});

test('resolveEffectiveAgentsMd defaults to enabled', () => {
  assert.equal(
    resolveEffectiveAgentsMd({}, null),
    true,
  );
});

test('repo-search auto-append request overrides can fully enable disabled defaults', () => {
  assert.deepEqual(
    resolveRepoSearchAutoAppendOverrides(
      { IncludeAgentsMd: false, IncludeRepoFileListing: false },
      { includeAgentsMd: false, includeRepoFileListing: false },
      { includeAgentsMd: true, includeRepoFileListing: true },
    ),
    { includeAgentsMd: true, includeRepoFileListing: true },
  );
});

test('repo-search auto-append request overrides can fully disable enabled defaults', () => {
  assert.deepEqual(
    resolveRepoSearchAutoAppendOverrides(
      { IncludeAgentsMd: true, IncludeRepoFileListing: true },
      { includeAgentsMd: true, includeRepoFileListing: true },
      { includeAgentsMd: false, includeRepoFileListing: false },
    ),
    { includeAgentsMd: false, includeRepoFileListing: false },
  );
});
