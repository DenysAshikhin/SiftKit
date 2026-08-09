import test from 'node:test';
import assert from 'node:assert/strict';

import { assessImageVramHeadroom } from '@siftkit/contracts';

const PEAK = 223_477_760; // the installed model at its 2.1 MP ceiling

test('comfortable headroom produces no finding', () => {
  assert.equal(assessImageVramHeadroom({ freeBytes: PEAK * 4, peakEncodeBytes: PEAK }), null);
});

test('headroom under 2x the peak warns', () => {
  const finding = assessImageVramHeadroom({ freeBytes: Math.round(PEAK * 1.5), peakEncodeBytes: PEAK });

  assert.equal(finding?.level, 'warning');
  assert.match(finding?.message ?? '', /about 213 MB/u);
  assert.match(finding?.message ?? '', /Max image size/u);
});

test('headroom below the peak is an error', () => {
  const finding = assessImageVramHeadroom({ freeBytes: Math.round(PEAK * 0.5), peakEncodeBytes: PEAK });

  assert.equal(finding?.level, 'error');
  assert.match(finding?.message ?? '', /is likely to fail/u);
});

test('exactly at the peak is an error, not a warning — there is no slack left', () => {
  assert.equal(assessImageVramHeadroom({ freeBytes: PEAK, peakEncodeBytes: PEAK })?.level, 'error');
});

test('unknown free VRAM produces no finding at all', () => {
  assert.equal(assessImageVramHeadroom({ freeBytes: null, peakEncodeBytes: PEAK }), null);
});

test('the message never blames the MP setting for model-load memory', () => {
  const finding = assessImageVramHeadroom({ freeBytes: 1, peakEncodeBytes: PEAK });
  assert.doesNotMatch(finding?.message ?? '', /load the model|startup|weights/iu);
});
