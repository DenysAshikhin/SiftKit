import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import type {
  AssistantEvidenceDeletionPreview,
  AssistantEvidenceDto,
  AssistantProjectionDto,
  AssistantTopicForgetPreview,
} from '@siftkit/contracts';
import {
  AssistantMemoryDetail,
  type AssistantMemorySelection,
} from '../src/components/AssistantMemoryDetail.js';
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

const ASSERTION_SELECTION: AssistantMemorySelection = {
  kind: 'assertion',
  value: {
    assertion: {
      id: 'assertion-1', subjectNodeId: 'node-1', predicate: 'USES',
      objectText: 'VS Code', scopeText: '', status: 'active',
      basis: 'passive_observation', confidence: 0.5, sensitivity: 'personal',
      pinned: false, userDemoted: false, validFromUtc: null, validToUtc: null,
      lastObservedAtUtc: '2026-08-10T14:03:11.000Z',
    },
    evidenceIds: ['evidence-1'],
    mutationIds: [],
  },
  evidence: [EVIDENCE],
};

const PROJECTION: AssistantProjectionDto = {
  id: 'projection-1',
  tier: 2,
  topicKey: 'finance',
  title: 'Finance workflows',
  content: 'Owner reconciles invoices weekly.',
  graphVersion: 9,
  tokenCount: 42,
  sensitivity: 'personal',
};

type DetailProps = React.ComponentProps<typeof AssistantMemoryDetail>;

function detailProps(overrides: Partial<DetailProps> = {}): DetailProps {
  return {
    selected: ASSERTION_SELECTION,
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

  render(<AssistantMemoryDetail {...detailProps({ onFetchEvidencePixels: fetchPixels })} />);

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

const EVIDENCE_PREVIEW: AssistantEvidenceDeletionPreview = {
  previewToken: 'pre_ev',
  graphVersion: 9,
  targetEvidenceId: 'evidence-1',
  dependentAssertionIds: ['assertion-1', 'assertion-2'],
  affectedProjectionIds: ['projection-1'],
};

const TOPIC_PREVIEW: AssistantTopicForgetPreview = {
  previewToken: 'pre_topic',
  graphVersion: 9,
  topicKey: 'finance',
  assertionIds: ['assertion-1', 'assertion-2', 'assertion-3'],
  affectedProjectionIds: ['projection-1', 'projection-2'],
};

test('evidence deletion previews its cascade before the confirm spends the token', () => {
  const previewed: string[] = [];
  const confirmed: (readonly [string, string])[] = [];
  const props = detailProps({
    onPreviewDeleteEvidence: async (id) => { previewed.push(id); },
    onConfirmDeleteEvidence: async (id, previewToken) => { confirmed.push([id, previewToken]); },
  });

  const view = render(<AssistantMemoryDetail {...props} />);
  assert.equal(screen.queryByRole('button', { name: 'Confirm evidence deletion' }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Delete evidence' }));
  assert.deepEqual(previewed, ['evidence-1']);
  assert.deepEqual(confirmed, []);

  view.rerender(
    <AssistantMemoryDetail {...props} evidenceDeletionPreview={EVIDENCE_PREVIEW} />,
  );
  const cascade = screen.getByRole('alert');
  assert.match(cascade.textContent ?? '', /2 dependent assertions/u);
  assert.match(cascade.textContent ?? '', /1 projections/u);

  fireEvent.click(screen.getByRole('button', { name: 'Confirm evidence deletion' }));
  assert.deepEqual(confirmed, [['evidence-1', 'pre_ev']]);
});

test('forget topic previews from the projection detail and carries the block policy choice', () => {
  const previewed: string[] = [];
  const confirmed: (readonly [string, string, boolean])[] = [];
  const props = detailProps({
    selected: { kind: 'projection', value: PROJECTION },
    onPreviewForgetTopic: async (topicKey) => { previewed.push(topicKey); },
    onConfirmForgetTopic: async (topicKey, previewToken, addPolicy) => {
      confirmed.push([topicKey, previewToken, addPolicy]);
    },
  });

  const view = render(<AssistantMemoryDetail {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Forget topic' }));
  assert.deepEqual(previewed, ['finance']);

  view.rerender(<AssistantMemoryDetail {...props} topicForgetPreview={TOPIC_PREVIEW} />);
  const cascade = screen.getByRole('alert');
  assert.match(cascade.textContent ?? '', /3 assertions/u);
  assert.match(cascade.textContent ?? '', /2 projections/u);

  fireEvent.click(screen.getByRole('button', { name: 'Confirm forget topic' }));
  assert.deepEqual(confirmed, [['finance', 'pre_topic', false]]);

  fireEvent.click(screen.getByRole('checkbox', {
    name: 'Also block this topic from being inferred again',
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm forget topic' }));
  assert.deepEqual(confirmed[1], ['finance', 'pre_topic', true]);
});
