import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import type { AssistantEvidenceDto } from '@siftkit/contracts';
import { AssistantMemoryDetail } from '../src/components/AssistantMemoryDetail.js';
import { fireEvent, render, screen } from './react-test-environment.js';

const EVIDENCE: AssistantEvidenceDto = {
  id: 'evidence-1',
  sourceType: 'screenshot',
  sourceRef: 'app:code',
  capturedAtUtc: '2026-08-10T14:03:11.000Z',
  sensitivity: 'sensitive',
  status: 'active',
  metadata: {},
  contentAvailable: true,
  contentRevealed: false,
};

function detailProps(fetchPixels: (id: string) => Promise<Blob>) {
  return {
    selected: {
      kind: 'assertion' as const,
      value: {
        assertion: {
          id: 'assertion-1', subjectNodeId: 'node-1', predicate: 'USES',
          objectText: 'VS Code', scopeText: '', status: 'active',
          basis: 'passive_observation', confidence: 0.5, sensitivity: 'personal' as const,
          pinned: false, userDemoted: false, validFromUtc: null, validToUtc: null,
          lastObservedAtUtc: '2026-08-10T14:03:11.000Z',
        },
        evidenceIds: ['evidence-1'],
        mutationIds: [],
      },
      evidence: [EVIDENCE],
    },
    deletionPreview: null,
    onConfirm: async () => {},
    onCorrect: async () => {},
    onPin: async () => {},
    onDemote: async () => {},
    onPreviewForget: async () => {},
    onConfirmForget: async () => {},
    onFetchEvidencePixels: fetchPixels,
  };
}

test('pixels render only after explicit confirmation and the object URL is revoked on close', { concurrency: false }, async () => {
  const created: string[] = [];
  const revoked: string[] = [];
  Object.defineProperty(window.URL, 'createObjectURL', {
    configurable: true,
    value: () => {
      const url = `blob:preview-${created.length + 1}`;
      created.push(url);
      return url;
    },
  });
  Object.defineProperty(window.URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => { revoked.push(url); },
  });
  let confirmAnswer = false;
  Object.defineProperty(window, 'confirm', {
    configurable: true,
    value: () => confirmAnswer,
  });
  const fetched: string[] = [];
  const fetchPixels = async (id: string): Promise<Blob> => {
    fetched.push(id);
    return new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' });
  };

  render(<AssistantMemoryDetail {...detailProps(fetchPixels)} />);

  const reveal = screen.getByRole('button', { name: /Reveal pixels/u });
  await act(async () => {
    fireEvent.click(reveal);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
  assert.equal(fetched.length, 0, 'a declined confirmation never fetches');
  assert.equal(screen.queryByRole('img'), null);

  confirmAnswer = true;
  await act(async () => {
    fireEvent.click(reveal);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
  assert.deepEqual(fetched, ['evidence-1']);
  const image = screen.getByRole('img');
  assert.equal(image.getAttribute('src'), 'blob:preview-1');

  fireEvent.click(screen.getByRole('button', { name: /Hide pixels/u }));
  assert.deepEqual(revoked, ['blob:preview-1'], 'closing revokes the object URL');
  assert.equal(screen.queryByRole('img'), null);
});
