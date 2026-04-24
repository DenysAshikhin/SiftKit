import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveEffectiveRepoFileListing } from '../dist/status-server/routes/chat.js';

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
