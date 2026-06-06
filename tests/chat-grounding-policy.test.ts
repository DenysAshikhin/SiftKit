import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGroundingPolicy } from '../src/repo-search/chat-grounding-policy.ts';

test('ChatGroundingPolicy rejects finish before any web search when enabled', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  const decision = policy.evaluateFinish();

  assert.equal(decision.kind, 'reject');
  assert.match(decision.kind === 'reject' ? decision.message : '', /web_search/);
  assert.equal(policy.getStatus(), 'ungrounded');
});

test('ChatGroundingPolicy allows finish before any web search when disabled', () => {
  const policy = new ChatGroundingPolicy({ enabled: false });

  assert.deepEqual(policy.evaluateFinish(), { kind: 'allow' });
  assert.equal(policy.getStatus(), 'ungrounded');
});

test('ChatGroundingPolicy rejects finish after search without fetch', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs iron ore"',
    exitCode: 0,
    output: '1. Iron ore - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Iron_ore\nSnippet: Iron ore can be mined...',
  });

  const decision = policy.evaluateFinish();

  assert.equal(decision.kind, 'reject');
  assert.match(decision.kind === 'reject' ? decision.message : '', /web_fetch/);
  assert.match(decision.kind === 'reject' ? decision.message : '', /Do not answer from search snippets/);
  assert.equal(policy.getStatus(), 'snippet_only');
});

test('ChatGroundingPolicy allows finish after successful fetch', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs mining guild"',
    exitCode: 0,
    output: '1. Mining Guild - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Mining_Guild',
  });
  policy.recordToolResult({
    toolName: 'web_fetch',
    command: 'web_fetch url="https://oldschool.runescape.wiki/w/Mining_Guild"',
    exitCode: 0,
    output: 'Title: Mining Guild\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\n\nThe Mining Guild requires 60 Mining.',
  });

  assert.deepEqual(policy.evaluateFinish(), { kind: 'allow' });
  assert.equal(policy.getStatus(), 'fetched');
});

test('ChatGroundingPolicy ignores failed or empty fetches', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs blast furnace"',
    exitCode: 0,
    output: '1. Blast Furnace - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Blast_Furnace',
  });
  policy.recordToolResult({
    toolName: 'web_fetch',
    command: 'web_fetch url="https://oldschool.runescape.wiki/w/Blast_Furnace"',
    exitCode: 1,
    output: 'network failure',
  });

  const decision = policy.evaluateFinish();

  assert.equal(decision.kind, 'reject');
  assert.equal(policy.getStatus(), 'snippet_only');
});

test('ChatGroundingPolicy caps steering rejections and then allows an insufficient-evidence answer', () => {
  const policy = new ChatGroundingPolicy({ enabled: true, maxFinishRejections: 2 });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="rare current fact"',
    exitCode: 0,
    output: '1. Result\nURL: https://example.com',
  });

  assert.equal(policy.evaluateFinish().kind, 'reject');
  assert.equal(policy.evaluateFinish().kind, 'reject');

  const thirdDecision = policy.evaluateFinish();

  assert.equal(thirdDecision.kind, 'allow');
  assert.equal(policy.getStatus(), 'snippet_only');
});

test('ChatGroundingPolicy rejects repeated search queries and fetch URLs', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  assert.equal(policy.evaluateToolCall('web_search', { query: 'foo "bar" OSRS' }).kind, 'allow');
  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="foo \\"bar\\" OSRS"',
    exitCode: 0,
    output: 'URL: https://oldschool.runescape.wiki/w/Iron_bar',
  });

  const repeatedSearch = policy.evaluateToolCall('web_search', { query: '  FOO   "bar" osrs ' });
  assert.equal(repeatedSearch.kind, 'reject');
  assert.match(repeatedSearch.kind === 'reject' ? repeatedSearch.message : '', /already searched/u);

  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'allow');
  policy.recordToolResult({
    toolName: 'web_fetch',
    command: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"',
    exitCode: 0,
    output: 'Iron bar page text',
  });

  const repeatedFetch = policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar#Uses' });
  assert.equal(repeatedFetch.kind, 'reject');
  assert.match(repeatedFetch.kind === 'reject' ? repeatedFetch.message : '', /already fetched/u);
});

test('ChatGroundingPolicy seeds duplicate checks from retained tool calls', () => {
  const policy = new ChatGroundingPolicy({
    enabled: true,
    retainedWebToolCalls: [
      { toolName: 'web_search', value: 'OSRS iron bars' },
      { toolName: 'web_fetch', value: 'https://oldschool.runescape.wiki/w/Iron_bar' },
    ],
  });

  assert.equal(policy.evaluateToolCall('web_search', { query: 'osrs iron bars' }).kind, 'reject');
  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'reject');
});

test('ChatGroundingPolicy allows retry after failed web search or fetch', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  assert.equal(policy.evaluateToolCall('web_search', { query: 'OSRS iron bars' }).kind, 'allow');
  policy.recordToolResult({ toolName: 'web_search', command: 'web_search query="OSRS iron bars"', exitCode: 1, output: '' });
  assert.equal(policy.evaluateToolCall('web_search', { query: 'OSRS iron bars' }).kind, 'allow');

  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'allow');
  policy.recordToolResult({ toolName: 'web_fetch', command: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"', exitCode: 1, output: '' });
  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'allow');
});

test('ChatGroundingPolicy extracts returned result URLs for fetch steering', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs mining guild"',
    exitCode: 0,
    output: [
      '1. SEO Guide',
      'URL: https://example-guide.test/mining-guild',
      'Snippet: Generated guide text.',
      '',
      '2. Mining Guild - OSRS Wiki',
      'URL: https://oldschool.runescape.wiki/w/Mining_Guild',
      'Snippet: The Mining Guild requires 60 Mining.',
    ].join('\n'),
  });

  assert.deepEqual(policy.getFetchCandidateUrls(), [
    'https://oldschool.runescape.wiki/w/Mining_Guild',
    'https://example-guide.test/mining-guild',
  ]);
});

test('ChatGroundingPolicy includes the best fetch URL in finish rejection steering', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs mining guild"',
    exitCode: 0,
    output: [
      '1. SEO Guide',
      'URL: https://example-guide.test/mining-guild',
      '',
      '2. Mining Guild - OSRS Wiki',
      'URL: https://oldschool.runescape.wiki/w/Mining_Guild',
    ].join('\n'),
  });

  const decision = policy.evaluateFinish();

  assert.equal(decision.kind, 'reject');
  assert.match(
    decision.kind === 'reject' ? decision.message : '',
    /web_fetch url="https:\/\/oldschool\.runescape\.wiki\/w\/Mining_Guild"/,
  );
});
