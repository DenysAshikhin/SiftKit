import './react-test-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { DurableChatQuestionSchema, type ChatQuestionReply } from '@siftkit/contracts';
import { fireEvent, render, screen } from './react-test-environment.js';
import { ChatQuestionCard } from '../src/components/ChatQuestionCard';

function question(overrides: { choices?: string[]; expiresAtUtc?: string; actionable?: boolean } = {}) {
  return DurableChatQuestionSchema.parse({
    questionId: '4f9c1f9a-0000-4000-8000-00000000000d', toolCallId: 'call', question: 'Which database?',
    choices: overrides.choices ?? ['PostgreSQL', 'SQLite'], requestedAtUtc: '2026-09-22T00:00:00.000Z',
    expiresAtUtc: overrides.expiresAtUtc ?? '2999-01-01T00:00:00.000Z', outcome: null, decidedAtUtc: null,
    actionable: overrides.actionable ?? true,
  });
}

test('a choice answers with the optional discuss note', async () => {
  const replies: ChatQuestionReply[] = [];
  const view = render(<ChatQuestionCard question={question()} onAnswer={(reply) => { replies.push(reply); }} onCancel={() => {}} />);
  try {
    await act(async () => { fireEvent.change(screen.getByLabelText('Discuss'), { target: { value: '  local only ' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'SQLite' })); });
    assert.deepEqual(replies, [{ choiceIndex: 1, note: 'local only' }]);
  } finally { view.unmount(); }
});

test('Reply needs text and sends it without a choice', async () => {
  const replies: ChatQuestionReply[] = [];
  const view = render(<ChatQuestionCard question={question({ choices: [] })} onAnswer={(reply) => { replies.push(reply); }} onCancel={() => {}} />);
  try {
    const reply = screen.getByRole('button', { name: 'Reply' });
    assert.equal(reply.hasAttribute('disabled'), true);
    await act(async () => { fireEvent.change(screen.getByLabelText('Discuss'), { target: { value: 'do X' } }); });
    await act(async () => { fireEvent.click(reply); });
    assert.deepEqual(replies, [{ choiceIndex: null, note: 'do X' }]);
  } finally { view.unmount(); }
});

test('Cancel calls onCancel, and an expired or inactive question disables every action', async () => {
  let cancelled = 0;
  const live = render(<ChatQuestionCard question={question()} onAnswer={() => {}} onCancel={() => { cancelled += 1; }} />);
  try {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    assert.equal(cancelled, 1);
  } finally { live.unmount(); }
  const expired = render(<ChatQuestionCard question={question({ expiresAtUtc: '2000-01-01T00:00:00.000Z' })} onAnswer={() => {}} onCancel={() => {}} />);
  try {
    for (const name of ['PostgreSQL', 'SQLite', 'Cancel']) assert.equal(screen.getByRole('button', { name }).hasAttribute('disabled'), true);
    assert.match(expired.container.textContent ?? '', /Question expired/u);
  } finally { expired.unmount(); }
  const inactive = render(<ChatQuestionCard question={question({ actionable: false })} onAnswer={() => {}} onCancel={() => {}} />);
  try {
    assert.equal(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled'), true);
  } finally { inactive.unmount(); }
});
