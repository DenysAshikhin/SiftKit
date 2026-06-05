import assert from 'node:assert/strict';
import test from 'node:test';

import { getToolRunningLabel } from '../../src/lib/tool-status';

test('getToolRunningLabel labels a web_search as fetching results', () => {
  assert.equal(getToolRunningLabel('web_search query="osrs iron bar"'), 'Fetching search results…');
});

test('getToolRunningLabel labels a web_fetch with the page host', () => {
  assert.equal(getToolRunningLabel('web_fetch url="https://example.com/iron"'), 'Loading example.com…');
});

test('getToolRunningLabel falls back to a generic page label when the url is unparseable', () => {
  assert.equal(getToolRunningLabel('web_fetch url="not a url"'), 'Loading page…');
  assert.equal(getToolRunningLabel('web_fetch'), 'Loading page…');
});

test('getToolRunningLabel returns an ellipsis for non-web tools', () => {
  assert.equal(getToolRunningLabel('rg --json "foo"'), '…');
});
