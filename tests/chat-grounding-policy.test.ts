import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGroundingPolicy } from '../src/repo-search/chat-grounding-policy.ts';

test('ChatGroundingPolicy allows finish before any web search', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

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

test('ChatGroundingPolicy builds duplicate web search steering', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs iron bar"',
    exitCode: 0,
    output: '1. Iron bar - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Iron_bar',
  });

  assert.match(policy.buildDuplicateSearchMessage(), /web_fetch/);
  assert.match(policy.buildDuplicateSearchMessage(), /different web_search/);
});
