import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import type { AssistantNodeDetail } from '@siftkit/contracts';
import {
  AssistantMemoryDetail,
  type AssistantMemorySelection,
} from '../src/components/AssistantMemoryDetail.js';
import { fireEvent, render, screen } from './react-test-environment.js';

function nodeSelection(overrides: Partial<AssistantNodeDetail> = {}): AssistantMemorySelection {
  return {
    kind: 'node',
    value: {
      id: 'node-demyus',
      type: 'person',
      displayName: 'demyus',
      sensitivity: 'personal',
      canonicalKey: null,
      description: null,
      properties: {},
      aliases: ['demyus'],
      isOwner: false,
      status: 'active',
      ...overrides,
    },
    neighborhood: {
      rootNodeId: 'node-demyus', nodeIds: ['node-demyus'], assertionIds: [], truncatedBy: [],
    },
  };
}

type DetailProps = React.ComponentProps<typeof AssistantMemoryDetail>;

function detailProps(overrides: Partial<DetailProps> = {}): DetailProps {
  return {
    selected: nodeSelection(),
    deletionPreview: null,
    evidenceDeletionPreview: null,
    topicForgetPreview: null,
    onConfirm: async () => {},
    onCorrect: async () => {},
    onPin: async () => {},
    onDemote: async () => {},
    onPreviewForget: async () => {},
    onConfirmForget: async () => {},
    onPreviewDeleteEvidence: async () => {},
    onConfirmDeleteEvidence: async () => {},
    onPreviewForgetTopic: async () => {},
    onConfirmForgetTopic: async () => {},
    onFetchEvidencePixels: async () => new Blob(),
    onClaimOwner: async () => {},
    ...overrides,
  };
}

function stubConfirm(answer: boolean): void {
  Object.defineProperty(window, 'confirm', { configurable: true, value: () => answer });
}

test('a duplicate person node offers "This is me"', { concurrency: false }, async () => {
  const claimed: Array<{ id: string; reason: string }> = [];
  stubConfirm(true);
  render(<AssistantMemoryDetail {...detailProps({
    onClaimOwner: async (id, reason) => { claimed.push({ id, reason }); },
  })} />);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /This is me/u }));
  });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.id, 'node-demyus');
  assert.ok((claimed[0]?.reason ?? '').length > 0);
});

test('declining the confirmation merges nothing', { concurrency: false }, async () => {
  let calls = 0;
  stubConfirm(false);
  render(<AssistantMemoryDetail {...detailProps({
    onClaimOwner: async () => { calls += 1; },
  })} />);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /This is me/u }));
  });

  assert.equal(calls, 0);
});

test('the owner node does not offer to be claimed', { concurrency: false }, () => {
  stubConfirm(true);
  render(<AssistantMemoryDetail {...detailProps({
    selected: nodeSelection({ isOwner: true, canonicalKey: 'person:owner', displayName: 'the user' }),
  })} />);

  assert.equal(screen.queryByRole('button', { name: /This is me/u }), null);
});

test('a node that is not a person does not offer to be claimed', { concurrency: false }, () => {
  stubConfirm(true);
  render(<AssistantMemoryDetail {...detailProps({
    selected: nodeSelection({ type: 'software', displayName: 'Tauri' }),
  })} />);

  assert.equal(screen.queryByRole('button', { name: /This is me/u }), null);
});

test('an already merged node does not offer to be claimed again', { concurrency: false }, () => {
  stubConfirm(true);
  render(<AssistantMemoryDetail {...detailProps({
    selected: nodeSelection({ status: 'merged' }),
  })} />);

  assert.equal(screen.queryByRole('button', { name: /This is me/u }), null);
});
