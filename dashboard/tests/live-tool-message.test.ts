import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveToolMessageId } from '../src/lib/live-tool-message';

test('buildLiveToolMessageId derives stable ids from toolCallId', () => {
  assert.equal(buildLiveToolMessageId('tc_0'), 'live-tool-tc_0');
  assert.equal(buildLiveToolMessageId('tc_0'), 'live-tool-tc_0');
  assert.equal(buildLiveToolMessageId('call_42'), 'live-tool-call_42');
});

test('buildLiveToolMessageId throws when toolCallId is missing', () => {
  assert.throws(() => buildLiveToolMessageId(''), /toolCallId required/u);
});
