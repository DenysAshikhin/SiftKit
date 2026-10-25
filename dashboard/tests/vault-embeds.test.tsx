import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';

import { NoteMarkdown } from '../src/components/vault/NoteMarkdown.tsx';
import { VaultRequestError } from '../src/vault-api.ts';
import { render, screen } from './react-test-environment.ts';
import { NOOP_ACTIONS } from './vault-fixture.ts';

test('attachment embeds load as object-URL images and a removed file says so', async () => {
  const requested: string[] = [];
  Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: () => 'blob:embed-1' });
  Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  const actions = {
    ...NOOP_ACTIONS,
    attachment: async (target: string) => {
      requested.push(target);
      if (target.endsWith('a.png')) return new Blob([Uint8Array.from([0x89, 0x50])], { type: 'image/png' });
      throw new VaultRequestError(404, 'not_found', 'gone');
    },
  };
  const body = (targets: readonly string[]) => targets.map((target) => `![[${target}]]`).join('\n');

  const single = render(<NoteMarkdown body={body(['attachments/captures/a.png'])} unresolved={new Set()} colors={new Map()} limit={50} full={false} noteId="n" actions={actions} />);
  const image = await screen.findByRole('img');
  assert.equal(image.getAttribute('src'), 'blob:embed-1');
  assert.equal(image.getAttribute('alt'), 'attachments/captures/a.png');
  single.unmount();

  render(<NoteMarkdown body={body(['attachments/captures/a.png', 'attachments/captures/b.png'])} unresolved={new Set()} colors={new Map()} limit={50} full={false} noteId="n" actions={actions} />);
  await screen.findByText('image removed');
  assert.equal(screen.getAllByRole('img').length, 1);
  assert.deepEqual(requested, ['attachments/captures/a.png', 'attachments/captures/a.png', 'attachments/captures/b.png']);
});
