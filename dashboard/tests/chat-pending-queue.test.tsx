import './react-test-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { ChatMessageQueueStateSchema } from '@siftkit/contracts';
import { ChatPendingQueue, type ChatPendingQueueActions } from '../src/components/ChatPendingQueue';
import { render, screen, fireEvent } from './react-test-environment.js';

const ID = '4f9c1f9a-0000-4000-8000-000000000001';
const queue = ChatMessageQueueStateSchema.parse({
  sessionId: 's1', revision: 2, paused: false, force: null,
  messages: [{ id: ID, preview: 'short preview', contentChars: 500, imageCount: 1, revision: 1, state: 'pending', position: 7, createdAtUtc: '2026-09-09T00:00:00Z' }],
});

test('queue previews are ranked as pending, edit fetches full text, and conflicts retain the edit', async () => {
  let forces = 0;
  const actions: ChatPendingQueueActions = {
    onForceQueue: async () => { forces++; },
    onLoadQueueMessage: async (id) => ({ message: { id, content: 'full text to edit', revision: 1, imageCount: 1 } }),
    onEditQueueMessage: async () => { throw new Error('not_pending'); },
    onRemoveQueueMessage: async () => {},
  };
  const view = render(<ChatPendingQueue queue={queue} {...actions} />);
  assert.match(view.container.textContent ?? '', /1\. short preview/u);
  assert.equal(view.container.textContent?.includes('full text to edit'), false);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit' })); });
  assert.equal(screen.getByDisplayValue('full text to edit').tagName, 'TEXTAREA');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  assert.match(screen.getByRole('alert').textContent ?? '', /not_pending/u);
  assert.ok(screen.getByDisplayValue('full text to edit'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Force now' })); });
  assert.equal(forces, 1);
  const force = { id: ID, operationId: ID, messageIds: [ID], successorOperationId: ID, phase: 'stopping' as const, failureDetail: null };
  view.rerender(<ChatPendingQueue queue={{ ...queue, force }} {...actions} />);
  assert.equal(screen.getByRole('button', { name: 'Stopping…' }).hasAttribute('disabled'), true);
  assert.equal(screen.getByRole('button', { name: 'Remove' }).hasAttribute('disabled'), true);
  view.rerender(<ChatPendingQueue queue={{ ...queue, force: { ...force, phase: 'sending' } }} {...actions} />);
  assert.ok(screen.getByRole('button', { name: 'Sending…' }));
});
