import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getManagedFilePickerDialogOptions,
  pickManagedFilePath,
} from '../dist/status-server/file-picker.js';

test('getManagedFilePickerDialogOptions configures executable picker filters', () => {
  const options = getManagedFilePickerDialogOptions(
    'managed-llama-executable',
    'C:\\llama\\llama-server.exe',
  );

  assert.equal(options.title, 'Select llama.cpp executable');
  assert.equal(options.filter, 'llama-server.exe|llama-server.exe|All files (*.*)|*.*');
  assert.equal(options.initialPath, 'C:\\llama\\llama-server.exe');
});

test('pickManagedFilePath returns selected model path from the dialog runner', async () => {
  let receivedInitialPath: string | null = null;
  const result = await pickManagedFilePath(
    'managed-llama-model',
    'D:\\models\\current.gguf',
    async (options) => {
      receivedInitialPath = options.initialPath;
      assert.equal(options.title, 'Select GGUF model');
      assert.equal(options.filter, 'GGUF models (*.gguf)|*.gguf|All files (*.*)|*.*');
      return 'D:\\models\\selected.gguf';
    },
  );

  assert.equal(receivedInitialPath, 'D:\\models\\current.gguf');
  assert.deepEqual(result, {
    cancelled: false,
    path: 'D:\\models\\selected.gguf',
  });
});

test('pickManagedFilePath reports cancelled selections', async () => {
  const result = await pickManagedFilePath(
    'managed-llama-executable',
    null,
    async () => null,
  );

  assert.deepEqual(result, {
    cancelled: true,
    path: null,
  });
});
