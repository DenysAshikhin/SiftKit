import './react-test-environment.ts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from './react-test-environment.ts';
import { ChatTab } from '../src/tabs/ChatTab.tsx';
import { ChatRuntimeHub } from '../src/lib/chat-runtime-hub.ts';
import { ChatMessageQueueStateSchema } from '@siftkit/contracts';
import { buildProps, buildDefaultStore, SESSION_A, orchestratorProps } from './chat-tab-fixture.ts';

const modelPresets = [{ id: 'model-a', label: 'GLM Flash' }, { id: 'model-b', label: 'Qwen Coder' }];

test('orchestrator mode keeps worker model assignment in its operation presets', () => {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<ChatTab {...orchestratorProps()} />);
  assert.equal(container.querySelector('select[aria-label="Model"]') === null, true);
});

test('chat exposes the resolved default and saves a model choice or inheritance', async () => {
  const onUpdateSessionModel = vi.fn(async (_id: string | null) => {});
  render(<ChatTab {...buildProps({ modelPresets, selectedSession: { ...SESSION_A, defaultModelPreset: { id: 'model-b', label: 'Qwen Coder' } }, onUpdateSessionModel })} />);
  const select = screen.getByRole('combobox', { name: 'Model' });
  assert.match(select.textContent ?? '', /Use preset default · Qwen Coder/u);
  fireEvent.change(select, { target: { value: 'model-a' } });
  await waitFor(() => assert.deepEqual(onUpdateSessionModel.mock.calls, [['model-a']]));
  fireEvent.change(select, { target: { value: '' } });
  await waitFor(() => assert.deepEqual(onUpdateSessionModel.mock.calls, [['model-a'], [null]]));
});

test('saved chat model is selected and cannot change during an active run', () => {
  const store = buildDefaultStore(SESSION_A.id).apply({
    kind: 'attach', sessionId: SESSION_A.id, operationKind: 'repo-agent',
    operationId: '4f9c1f9a-0000-4000-8000-000000000000',
  });
  const view = render(<ChatTab {...buildProps({ modelPresets,
    selectedSession: { ...SESSION_A, modelPresetOverrideId: 'model-a' }, runtimeHub: new ChatRuntimeHub(store),
  })} />);
  const select = view.container.querySelector('select[aria-label="Model"]');
  assert.ok(select instanceof window.HTMLSelectElement);
  assert.equal(select.value, 'model-a');
  assert.equal(select.disabled, true);
});

test('saving a model choice disables submission and further preference changes', () => {
  const onSendMessage = vi.fn(async () => {});
  render(<ChatTab {...buildProps({ modelPresets, sessionPreferencesSaving: true, onSendMessage })} />);
  const send = screen.getByRole('button', { name: 'Send' });
  assert.ok(send instanceof window.HTMLButtonElement);
  assert.equal(send.disabled, true);
  const model = screen.getByRole('combobox', { name: 'Model' });
  const preset = screen.getByRole('combobox', { name: 'Preset' });
  assert.ok(model instanceof window.HTMLSelectElement && preset instanceof window.HTMLSelectElement);
  assert.equal(model.disabled, true);
  assert.equal(preset.disabled, true);
  for (const name of ['web search', 'per-step thinking', 'Delete']) {
    const button = screen.getByRole('button', { name });
    assert.ok(button instanceof window.HTMLButtonElement);
    assert.equal(button.disabled, true, `${name} must wait for the preference save`);
  }
  fireEvent.click(send);
  assert.equal(onSendMessage.mock.calls.length, 0);
});

test('a pending preference save disables repository edits, retry and transcript deletion', () => {
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'queue', sessionId: SESSION_A.id, queue: ChatMessageQueueStateSchema.parse({
      sessionId: SESSION_A.id, revision: 1, paused: false, force: null,
      messages: [{ id: '4f9c1f9a-0000-4000-8000-000000000001', preview: 'Queued task', contentChars: 11,
        imageCount: 0, revision: 1, state: 'pending', position: 0, createdAtUtc: '2026-09-09T00:00:00Z' }],
    }) })
    .apply({ kind: 'plan-inputs', sessionId: SESSION_A.id, planRepoRootInput: 'C:/repo', planMaxTurnsInput: '' })
    .apply({ kind: 'control-error', sessionId: SESSION_A.id, message: 'Previous run failed.' });
  render(<ChatTab {...buildProps({ sessionPreferencesSaving: true, chatMode: 'plan', isDirectChatMode: false,
    isRepoToolMode: true, runtimeHub: new ChatRuntimeHub(store) })} />);
  const root = screen.getByPlaceholderText('Repo folder path…');
  assert.ok(root instanceof window.HTMLInputElement);
  assert.equal(root.disabled, true);
  for (const name of ['Directory', 'Retry', 'Delete message', 'Force now', 'Edit', 'Remove']) {
    const button = screen.getByRole('button', { name });
    assert.ok(button instanceof window.HTMLButtonElement);
    assert.equal(button.disabled, true);
  }
});
