import { countRenders } from '../render-tracker.js';
import { render } from '../react-test-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { ChatRuntimeHub } from '../../src/lib/chat-runtime-hub';
import { ChatSessionRuntimeStore } from '../../src/lib/chat-session-runtime-store';
import { useChatRuntimeSelector } from '../../src/hooks/useChatRuntimeSelector';

function DraftProbe({ hub }: { hub: ChatRuntimeHub }) {
  const draft = useChatRuntimeSelector(hub, (store) => store.get('s1').draft);
  return <span data-testid="draft">{draft}</span>;
}

function hubWithSession(): ChatRuntimeHub {
  return new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession('s1', ''));
}

test('re-renders when the selected slice changes and shows the new value', async () => {
  const hub = hubWithSession();
  const view = render(<DraftProbe hub={hub} />);
  try {
    const renders = await countRenders(DraftProbe, async () => {
      await act(async () => hub.apply({ kind: 'draft', sessionId: 's1', draft: 'hello' }));
    });
    assert.equal(renders, 1);
    assert.equal(view.getByTestId('draft').textContent, 'hello');
  } finally { view.unmount(); }
});

test('does not re-render when another slice of the store changes', async () => {
  const hub = hubWithSession();
  const view = render(<DraftProbe hub={hub} />);
  try {
    const renders = await countRenders(DraftProbe, async () => {
      await act(async () => hub.apply({ kind: 'plan-inputs', sessionId: 's1', planRepoRootInput: 'C:/x', planMaxTurnsInput: '5' }));
    });
    assert.equal(renders, 0);
  } finally { view.unmount(); }
});
