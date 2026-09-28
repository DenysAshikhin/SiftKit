import { countRenders } from './render-tracker.js';
import { render } from './react-test-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBlocks, MarkdownContent } from '../src/components/MarkdownContent';

/** Blocks drop only the insignificant newline text nodes a whole-document render puts between block elements. */
function withoutInterBlockNewlines(html: string): string {
  return html.replaceAll('>\n<', '><');
}

test('renders GitHub-flavored markdown', () => {
  const html = renderToStaticMarkup(<MarkdownContent content={'**bold**\n\n| a |\n| - |\n| 1 |'} />);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<table>/);
});

const CORPUS = {
  'headings, paragraphs, table, fence with blank lines': '# Plan\n\nRun this:\n\n```bash\nnpm test\n\nnpm run lint\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nDone **now**.',
  'loose unordered list': '- one\n\n- two\n\n- three\n\nAfter the list.',
  'loose ordered list with start number': '3. three\n\n4. four\n\nAfter.',
  'nested list with indented continuation and fence': '1. Step\n\n   ```sh\n   cmd\n\n   more\n   ```\n\n   detail\n\n2. Next\n   - nested\n\n     para\n\nEnd.',
  'blockquotes separated by a blank line': '> first\n> still\n\n> second\n\nText',
  'indented code block': 'Para\n\n    code line\n\n    more code\n\nAfter',
  'setext heading and thematic breaks': 'Title\n=====\n\n---\n\n***\n\n* * *\n\nText',
  'tilde fence and unclosed backtick fence': '~~~\na\n\nb\n~~~\n\nTail\n\n```\nopen\n\nstill open',
  'reference link defined in a later block': 'See [docs][d].\n\nMore\n\n[d]: https://example.com',
  'footnote defined in a later block': 'Claim[^1].\n\nMore\n\n[^1]: Source.',
  'html comment and pre spanning blank lines': 'Intro\n\n<!--\n\nhidden\n-->\n\n<pre>\na\n\nb\n</pre>\n\nAfter',
  'gfm task list, strikethrough, autolink': '- [x] done\n\n- [ ] todo\n\n~~old~~ https://example.com\n\nEnd',
} satisfies Record<string, string>;

for (const [name, content] of Object.entries(CORPUS)) {
  test(`block rendering matches whole-document rendering: ${name}`, () => {
    assert.equal(withoutInterBlockNewlines(renderToStaticMarkup(<MarkdownBlocks content={content} />)),
      withoutInterBlockNewlines(renderToStaticMarkup(<MarkdownContent content={content} />)));
  });
}

function Harness({ content, tick }: { content: string; tick: number }) {
  return <div data-tick={tick}><MarkdownContent content={content} /></div>;
}

function BlocksHarness({ content }: { content: string }) {
  return <MarkdownBlocks content={content} />;
}

test('a parent re-render with unchanged content does not re-render the markdown', async () => {
  const view = render(<Harness content="**x**" tick={0} />);
  try {
    assert.equal(await countRenders(MarkdownContent, async () => {
      await act(async () => view.rerender(<Harness content="**x**" tick={1} />));
    }), 0);
    assert.equal(await countRenders(MarkdownContent, async () => {
      await act(async () => view.rerender(<Harness content="**y**" tick={2} />));
    }), 1);
  } finally {
    view.unmount();
  }
});

test('a growing answer re-renders only its last block', async () => {
  const head = '# Title\n\nFirst paragraph.\n\n```ts\nconst a = 1;\n```\n\n';
  const view = render(<BlocksHarness content={`${head}Tail`} />);
  try {
    assert.equal(await countRenders(MarkdownContent, async () => {
      await act(async () => view.rerender(<BlocksHarness content={`${head}Tail grows`} />));
    }), 1);
    assert.equal(view.container.querySelector('h1')?.textContent, 'Title');
  } finally {
    view.unmount();
  }
});
