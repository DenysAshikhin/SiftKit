import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContextUsage } from '../src/status-server/chat.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import type { ChatSession } from '../src/state/chat-sessions.js';
import { mockModelPreset } from './helpers/mock-config.js';

test('context usage sums the stored token fields rather than re-estimating the text', () => {
  const session: ChatSession = {
    id: 'ctx', title: 'ctx', modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default' }),
    planRepoRoot: 'C:/repo',
    createdAtUtc: '2026-09-04T00:00:00.000Z', updatedAtUtc: '2026-09-04T00:00:00.000Z',
    messages: [
      {
        id: 'm1', role: 'assistant', kind: 'assistant_thinking',
        // Deliberately short text with a large stored count: if the builder re-estimates
        // from text this assertion fails.
        content: 'hi',
        inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 5000,
        inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
        createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
      },
    ],
  };
  const usage = buildContextUsage(getDefaultConfigObject(), session);
  assert.ok(usage.thinkingUsedTokens >= 5000);
});