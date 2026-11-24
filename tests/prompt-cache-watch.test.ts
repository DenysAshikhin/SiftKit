import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describePromptCacheBreak,
  formatPromptCacheBreakDetail,
  PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS,
  PromptCacheWatch,
  summarizePromptCacheBreak,
} from '../src/repo-search/engine/prompt-cache-watch.ts';

const observe = (watch: PromptCacheWatch, turn: number, promptTokens: number, promptEvalTokens: number | null) =>
  watch.observe({ turn, promptTokens, promptEvalTokens, promptCacheTokens: null });

test('the first response is not checked, and growth plus the tolerance is the most a cached turn prefills', () => {
  const watch = new PromptCacheWatch();
  assert.equal(observe(watch, 1, 10_000, 10_000), null);
  assert.equal(observe(watch, 2, 11_000, 1_000 + PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS), null);
  assert.deepEqual(observe(watch, 3, 12_000, 1_000 + PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS + 1), {
    turn: 3, promptTokens: 12_000, previousPromptTokens: 11_000, promptEvalTokens: 1_000 + PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS + 1, promptCacheTokens: null,
  });
});

test('the first response after a compaction is not checked, and the next one is', () => {
  const watch = new PromptCacheWatch();
  observe(watch, 1, 50_000, 50_000);
  watch.noteCompaction();
  assert.equal(observe(watch, 2, 20_000, 20_000), null);
  assert.equal(observe(watch, 3, 21_000, 21_000)?.turn, 3);
});

// Real case (run e85529c8, turn 189): 7,281 re-prefilled where the prompt grew 5,354 was warned like the real 165k break.
test('a re-prefill of a few pages beyond the growth is not reported', () => {
  const watch = new PromptCacheWatch();
  observe(watch, 1, 100_347, 100_347);
  assert.equal(observe(watch, 2, 105_701, 7_281), null);
  assert.equal(PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS, 8_192);
});

test('an unreported prefill is not checked but still sets the comparison point', () => {
  const watch = new PromptCacheWatch();
  observe(watch, 1, 10_000, 10_000);
  assert.equal(observe(watch, 2, 20_000, null), null);
  assert.equal(observe(watch, 3, 20_100, 600), null);
  assert.equal(observe(watch, 4, 20_200, 20_200)?.previousPromptTokens, 20_100);
});

test('a break reads the same in the run warning, the engine-event summary, and its detail', () => {
  const cacheBreak = { turn: 14, promptTokens: 190_000, previousPromptTokens: 186_790, promptEvalTokens: 182_301, promptCacheTokens: 7_699 };
  assert.equal(describePromptCacheBreak(cacheBreak), 'Prompt cache broke on turn 14: re-prefilled 182,301 tokens where the prompt grew 3,210.');
  assert.equal(summarizePromptCacheBreak(cacheBreak), 'Turn 14 re-prefilled 182,301 tokens; the prompt grew 3,210');
  assert.equal(formatPromptCacheBreakDetail(cacheBreak), [
    'turn: 14', 'prompt tokens: 190,000', 'previous prompt tokens: 186,790', 're-prefilled tokens: 182,301', 'cached tokens: 7,699',
  ].join('\n'));
});
