import { test } from 'vitest';
import assert from 'node:assert/strict';

import { useAttachmentUrl } from '../src/hooks/useAttachmentUrl.ts';
import { VaultRequestError } from '../src/vault-api.ts';
import { renderHook, waitFor } from './react-test-environment.ts';

const PNG = new Blob([Uint8Array.from([0x89, 0x50])], { type: 'image/png' });

test('an attachment loads into an object URL that is revoked on unmount', async () => {
  const revoked: string[] = [];
  Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: () => 'blob:one' });
  Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: (url: string) => { revoked.push(url); } });
  const hook = renderHook(() => useAttachmentUrl(async () => PNG, 'captures/a.png'));
  assert.deepEqual(hook.result.current, { kind: 'loading' });
  await waitFor(() => assert.deepEqual(hook.result.current, { kind: 'image', url: 'blob:one' }));
  hook.unmount();
  assert.deepEqual(revoked, ['blob:one']);
});

test('a removed file and any other failure are told apart', async () => {
  const removed = renderHook(() => useAttachmentUrl(async () => { throw new VaultRequestError(404, 'not_found', 'gone'); }, 'captures/a.png'));
  await waitFor(() => assert.deepEqual(removed.result.current, { kind: 'removed' }));
  const failed = renderHook(() => useAttachmentUrl(async () => { throw new Error('offline'); }, 'captures/a.png'));
  await waitFor(() => assert.deepEqual(failed.result.current, { kind: 'failed', message: 'offline' }));
});
