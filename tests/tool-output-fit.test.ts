import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolOutputFitter } from '../src/tool-output-fit.js';

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
  assert.match(result.visibleText, /lines truncated due to per-tool context limit\./u);
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
  });

  assert.equal(result.truncationReason, 'per-tool context limit');
  assert.ok(result.visibleText.startsWith('HDR'), 'header must be preserved');
  assert.ok(
    result.visibleText.length <= 100,
    `visibleText length ${result.visibleText.length} must be <= 50% of maxTokens (100)`,
  );
});
