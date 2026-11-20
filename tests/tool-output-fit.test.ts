import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolOutputFitter } from '../src/tool-output-fit.ts';

class CharsTokenCounter {
  async countToolOutputTokens(text: string): Promise<number> {
    return text.length;
  }
}

test('ToolOutputFitter returns full text when it already fits under maxTokens', async () => {
  const fitter = new ToolOutputFitter(new CharsTokenCounter());
  const segments = ['aaa', 'bbb', 'ccc'];

  const result = await fitter.fitSegments({
    segments,
    separator: '\n',
    maxTokens: 1000,
    unit: 'lines',
    keep: 'head',
    continueArgument: null,
  });

  assert.equal(result.returnedLineCount, 3);
  assert.equal(result.truncatedLineCount, 0);
  assert.equal(result.truncationReason, null);
  assert.equal(result.visibleText, 'aaa\nbbb\nccc');
});

test('ToolOutputFitter targets 50 percent of maxTokens when truncation is triggered', async () => {
  const fitter = new ToolOutputFitter(new CharsTokenCounter());
  const segments = Array.from({ length: 200 }, () => 'x');

  const result = await fitter.fitSegments({
    segments,
    separator: '\n',
    maxTokens: 300,
    unit: 'lines',
    keep: 'head',
    continueArgument: null,
  });

  assert.equal(result.truncationReason, 'per-tool context limit');
  assert.ok(result.returnedLineCount > 0, 'should return some lines');
  assert.ok(
    result.visibleText.length <= 150,
    `visibleText length ${result.visibleText.length} must be <= 50% of maxTokens (150)`,
  );
  assert.ok(
    result.visibleText.length > 75,
    `visibleText length ${result.visibleText.length} must use a meaningful share of the 50% target (>75)`,
  );
  assert.equal(result.truncatedLineCount, segments.length - result.returnedLineCount);
  assert.match(result.visibleText, new RegExp(`Cut by the per-tool context limit: showing the first ${String(result.returnedLineCount)} of 200 lines\\.$`, 'u'));
});

test('a cut numbered read says which offset continues it', async () => {
  const fitter = new ToolOutputFitter(new CharsTokenCounter());
  const segments = Array.from({ length: 100 }, (_value, index) => `${String(index + 40)}: text`);

  const result = await fitter.fitSegments({ segments, separator: '\n', maxTokens: 600, unit: 'lines', keep: 'head', continueArgument: 'offset' });

  const shown = result.returnedLineCount;
  assert.ok(shown > 0 && shown < 100);
  assert.match(result.visibleText, new RegExp(
    `\\n${String(39 + shown)}: text\\nCut by the per-tool context limit: showing the first ${String(shown)} of 100 lines\\. Continue with offset=${String(40 + shown)}\\.$`, 'u'));
});

test('ToolOutputFitter keeps the tail segments and leads with the notice when keep is "tail"', async () => {
  const fitter = new ToolOutputFitter(new CharsTokenCounter());
  const segments = Array.from({ length: 100 }, (_value, index) => `line-${String(index)}`);

  const result = await fitter.fitSegments({
    segments,
    separator: '\n',
    maxTokens: 200,
    unit: 'lines',
    keep: 'tail',
    continueArgument: null,
  });

  assert.equal(result.truncationReason, 'per-tool context limit');
  assert.match(result.visibleText, /line-99$/u, 'last segment (summary) must be preserved');
  assert.doesNotMatch(result.visibleText, /(^|\n)line-0(\n|$)/u, 'first segment must be dropped');
  assert.match(
    result.visibleText,
    new RegExp(`^Cut by the per-tool context limit: the first ${String(100 - result.returnedLineCount)} of 100 lines are not shown\\.\\nline-`, 'u'),
    'truncation notice must precede the kept tail',
  );
  assert.equal(result.truncatedLineCount, segments.length - result.returnedLineCount);
});

test('ToolOutputFitter still includes header when truncating to 50 percent target', async () => {
  const fitter = new ToolOutputFitter(new CharsTokenCounter());
  const segments = Array.from({ length: 50 }, (_value, index) => `line-${String(index)}`);

  const result = await fitter.fitSegments({
    headerText: 'HDR',
    segments,
    separator: '\n',
    maxTokens: 200,
    unit: 'lines',
    keep: 'head',
    continueArgument: null,
  });

  assert.equal(result.truncationReason, 'per-tool context limit');
  assert.ok(result.visibleText.startsWith('HDR'), 'header must be preserved');
  assert.ok(
    result.visibleText.length <= 100,
    `visibleText length ${result.visibleText.length} must be <= 50% of maxTokens (100)`,
  );
});

test('only output declared as a numbered read names a continuation, with its own argument', async () => {
  const fitter = new ToolOutputFitter(new CharsTokenCounter());
  const segments = Array.from({ length: 100 }, (_value, index) => `${String(index + 1)}: text`);
  const fit = (continueArgument: 'offset' | 'startLine' | null) => fitter.fitSegments({
    segments, separator: '\n', maxTokens: 600, unit: 'lines', keep: 'head', continueArgument,
  });

  assert.match((await fit(null)).visibleText, /showing the first \d+ of 100 lines\.$/u);
  assert.match((await fit('startLine')).visibleText, /showing the first \d+ of 100 lines\. Continue with startLine=\d+\.$/u);
});
