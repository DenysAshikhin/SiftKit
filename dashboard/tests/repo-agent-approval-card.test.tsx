import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { DurableChatApprovalSchema } from '@siftkit/contracts';
import { render, fireEvent } from './react-test-environment.js';
import { RepoAgentApprovalCard } from '../src/components/RepoAgentApprovalCard';

const approval = DurableChatApprovalSchema.parse({ runId: '4f9c1f9a-0000-4000-8000-000000000001',
  approvalId: '4f9c1f9a-0000-4000-8000-000000000002', toolCallId: 'native-call', toolName: 'run', command: 'work',
  reviewPayload: null, mode: 'interactive', requestedAtUtc: '2026-09-10T12:00:00.000Z', expiresAtUtc: '2026-09-10T12:10:00.000Z',
  outcome: null, decidedAtUtc: null, actionable: true });

test('refresh displays the original approval deadline and disables actions at expiry', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-09-10T12:09:59.000Z') });
  let decisions = 0;
  const view = render(<RepoAgentApprovalCard approval={approval} onDecide={() => { decisions++; }} />);
  try {
    assert.equal(view.container.querySelector('time')?.getAttribute('dateTime'), approval.expiresAtUtc);
    const approve = view.getByRole('button', { name: 'Approve' });
    assert.equal(approve.hasAttribute('disabled'), false);
    act(() => t.mock.timers.tick(1000));
    assert.equal(approve.hasAttribute('disabled'), true);
    fireEvent.click(approve);
    assert.equal(decisions, 0);
    assert.match(view.container.textContent ?? '', /expired/i);
  } finally { view.unmount(); }
});

test('a dead execution binding cannot authorize an approval', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(approval.requestedAtUtc) });
  let decisions = 0;
  const view = render(<RepoAgentApprovalCard approval={{ ...approval, actionable: false }} onDecide={() => { decisions++; }} />);
  try {
    for (const button of view.getAllByRole('button')) {
      assert.ok(button.hasAttribute('disabled'));
      fireEvent.click(button);
    }
    assert.equal(decisions, 0);
  } finally { view.unmount(); }
});
