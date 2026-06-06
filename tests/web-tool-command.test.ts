import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  formatWebFetchCommand,
  formatWebSearchCommand,
  parseWebToolCommand,
} from '../src/web-search/web-tool-command.js';

test('web tool command parser round-trips JSON-escaped values', () => {
  const searchCommand = formatWebSearchCommand('foo "bar" OSRS');
  const fetchCommand = formatWebFetchCommand('https://example.test/a?quote=%22#section');

  assert.equal(searchCommand, 'web_search query="foo \\"bar\\" OSRS"');
  assert.deepEqual(parseWebToolCommand(searchCommand), {
    toolName: 'web_search',
    value: 'foo "bar" OSRS',
  });
  assert.deepEqual(parseWebToolCommand(fetchCommand), {
    toolName: 'web_fetch',
    value: 'https://example.test/a?quote=%22#section',
  });
});

test('web tool command parser rejects malformed commands without partial captures', () => {
  assert.equal(parseWebToolCommand('web_search query="foo'), null);
  assert.equal(parseWebToolCommand('web_search query="foo" extra'), null);
  assert.equal(parseWebToolCommand('web_fetch url=https://example.test'), null);
  assert.equal(parseWebToolCommand('repo_rg pattern="web_search"'), null);
});
