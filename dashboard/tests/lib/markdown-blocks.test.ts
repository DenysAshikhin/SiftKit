import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdownBlocks, streamTailStart } from '../../src/lib/markdown-blocks';

test('splits at blank lines before unindented non-list lines and preserves every character', () => {
  const markdown = '# Title\n\nFirst paragraph\nstill first.\n\n- a\n- b\n\nLast';
  const blocks = splitMarkdownBlocks(markdown);
  assert.deepEqual(blocks, ['# Title\n', 'First paragraph\nstill first.\n\n- a\n- b\n', 'Last']);
  assert.equal(blocks.join('\n'), markdown);
});

test('keeps fenced code with blank lines in one block, for backtick and tilde fences', () => {
  const markdown = 'Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n~~~\nx\n\ny\n~~~\n\nAfter';
  assert.deepEqual(splitMarkdownBlocks(markdown), ['Intro\n', '```ts\nconst a = 1;\n\nconst b = 2;\n```\n', '~~~\nx\n\ny\n~~~\n', 'After']);
});

test('a shorter or different fence does not close the open fence', () => {
  const markdown = '````\n```\n\nstill code\n````\n\nAfter';
  assert.deepEqual(splitMarkdownBlocks(markdown), ['````\n```\n\nstill code\n````\n', 'After']);
});

test('an unclosed fence keeps the streamed remainder in the last block', () => {
  assert.deepEqual(splitMarkdownBlocks('Intro\n\n```\ncode\n\nmore'), ['Intro\n', '```\ncode\n\nmore']);
});

test('indented continuations stay with their list item', () => {
  const markdown = '1. Step\n\n   ```bash\n   cmd\n   ```\n\n   detail\n2. Next';
  assert.deepEqual(splitMarkdownBlocks(markdown), [markdown]);
});

test('empty text and leading blank lines yield no empty leading block', () => {
  assert.deepEqual(splitMarkdownBlocks(''), ['']);
  assert.deepEqual(splitMarkdownBlocks('\n\nText'), ['\n\nText']);
});

test('never splits before a list marker, so loose lists stay one list', () => {
  const markdown = '- a\n\n- b\n\n1. one\n\n2. two\n\n* * *\n\nAfter';
  assert.deepEqual(splitMarkdownBlocks(markdown), ['- a\n\n- b\n\n1. one\n\n2. two\n\n* * *\n', 'After']);
});

test('text with cross-block constructs stays one block', () => {
  for (const markdown of [
    'See [docs][d].\n\nMore\n\n[d]: https://example.com',
    'Claim[^1].\n\nMore\n\n[^1]: Source.',
    'Intro\n\n<!--\n\nhidden\n-->\n\nAfter',
    'Intro\n\n<pre>\na\n\nb\n</pre>\n\nAfter',
  ]) {
    assert.deepEqual(splitMarkdownBlocks(markdown), [markdown]);
  }
});

test('a streamed prefix tail starts at its last block, right after the separating newline', () => {
  const markdown = 'First **one**\n\nSecond\n\nThi';
  const { start, inFence } = streamTailStart(markdown);
  assert.equal(markdown.slice(start), 'Thi');
  assert.deepEqual(splitMarkdownBlocks(markdown.slice(0, start - 1)), ['First **one**\n', 'Second\n']);
  assert.equal(inFence, false);
});

test('a single-block prefix has its whole text in the tail', () => {
  assert.deepEqual(streamTailStart(''), { start: 0, inFence: false });
  assert.deepEqual(streamTailStart('Only para\nstill it\n\n'), { start: 0, inFence: false });
});

test('an open fence stays in the tail and is reported; a closed one does not', () => {
  const open = 'Intro\n\n```ts\nconst a = 1;\n\nconst b';
  assert.deepEqual(streamTailStart(open), { start: 'Intro\n\n'.length, inFence: true });
  const closed = `${open} = 2;\n\`\`\`\n\nAfter`;
  const { start, inFence } = streamTailStart(closed);
  assert.equal(closed.slice(start), 'After');
  assert.equal(inFence, false);
});

test('a prefix with cross-block constructs keeps everything in the tail', () => {
  assert.deepEqual(streamTailStart('See [docs][d].\n\n[d]: https://example.com\n\nMore'), { start: 0, inFence: false });
});
