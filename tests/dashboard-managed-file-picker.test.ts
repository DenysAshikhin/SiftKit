import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getManagedFilePickerDialogOptions,
  pickManagedFilePath,
} from '../src/status-server/file-picker.js';

test('getManagedFilePickerDialogOptions opens a directory picker for the model preset path', () => {
  const options = getManagedFilePickerDialogOptions(
    'model-preset-path',
    'D:\\models\\current',
  );

  assert.equal(options.title, 'Select EXL3 model directory');
  assert.equal(options.filter, null);
  assert.equal(options.initialPath, 'D:\\models\\current');
});

test('pickManagedFilePath returns the selected model directory from the dialog runner', async () => {
  let receivedInitialPath: string | null = null;
  const result = await pickManagedFilePath(
    'model-preset-path',
    'D:\\models\\current',
    async (options) => {
      receivedInitialPath = options.initialPath;
      assert.equal(options.title, 'Select EXL3 model directory');
      assert.equal(options.filter, null);
      return 'D:\\models\\selected';
    },
  );

  assert.equal(receivedInitialPath, 'D:\\models\\current');
  assert.deepEqual(result, {
    cancelled: false,
    path: 'D:\\models\\selected',
  });
});

test('getManagedFilePickerDialogOptions configures preset autoload file picker filters', () => {
  const options = getManagedFilePickerDialogOptions(
    'preset-autoload-file',
    'C:\\Users\\denys\\Documents\\GitHub\\AGENTS.md',
  );

  assert.equal(options.title, 'Select autoload file');
  assert.equal(options.filter, 'Markdown (*.md)|*.md|Text (*.txt)|*.txt|All files (*.*)|*.*');
  assert.equal(options.initialPath, 'C:\\Users\\denys\\Documents\\GitHub\\AGENTS.md');
});

test('pickManagedFilePath returns the selected autoload file path', async () => {
  const result = await pickManagedFilePath(
    'preset-autoload-file',
    null,
    async () => 'C:\\repo\\AGENTS.md',
  );

  assert.deepEqual(result, {
    cancelled: false,
    path: 'C:\\repo\\AGENTS.md',
  });
});

test('pickManagedFilePath reports cancelled selections', async () => {
  const result = await pickManagedFilePath(
    'model-preset-path',
    null,
    async () => null,
  );

  assert.deepEqual(result, {
    cancelled: true,
    path: null,
  });
});
