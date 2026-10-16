import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

import {
  buildWindowsFolderOrFileDialogScript,
  getManagedFilePickerDialogOptions,
  MODEL_FOLDER_PLACEHOLDER,
  pickManagedFilePath,
} from '../src/status-server/file-picker.ts';

test('getManagedFilePickerDialogOptions opens a directory picker for the model preset path', () => {
  const options = getManagedFilePickerDialogOptions(
    'model-preset-path',
    'D:\\models\\current',
  );

  assert.deepEqual(options, { kind: 'folder', title: 'Select EXL3 model directory', initialPath: 'D:\\models\\current' });
});

test('pickManagedFilePath returns the selected model directory from the dialog runner', async () => {
  const selected = createManagedTempDir('siftkit-picker-');
  let receivedInitialPath: string | null = null;
  try {
    const result = await pickManagedFilePath(
      'model-preset-path',
      'D:\\models\\current',
      async (options) => {
        receivedInitialPath = options.initialPath;
        assert.equal(options.kind, 'folder');
        return selected;
      },
    );

    assert.equal(receivedInitialPath, 'D:\\models\\current');
    assert.deepEqual(result, { cancelled: false, path: selected });
  } finally {
    rmSync(selected, { recursive: true, force: true });
  }
});

test('pickManagedFilePath resolves a file or placeholder picked inside a model folder to that folder', async () => {
  const modelDirectory = createManagedTempDir('siftkit-picker-');
  writeFileSync(join(modelDirectory, 'config.json'), '{}');
  try {
    const pick = (selected: string) => pickManagedFilePath('model-preset-path', null, async () => selected);

    assert.equal((await pick(modelDirectory)).path, modelDirectory);
    assert.equal((await pick(join(modelDirectory, 'config.json'))).path, modelDirectory);
    assert.equal((await pick(join(modelDirectory, MODEL_FOLDER_PLACEHOLDER))).path, modelDirectory);
  } finally {
    rmSync(modelDirectory, { recursive: true, force: true });
  }
});

test('the model folder dialog is an Explorer dialog that accepts a folder or any file in it', () => {
  const script = buildWindowsFolderOrFileDialogScript({ kind: 'folder', title: 'Select EXL3 model directory', initialPath: 'D:\\models\\current' });

  assert.match(script, /OpenFileDialog/u);
  assert.doesNotMatch(script, /FolderBrowserDialog/u);
  assert.match(script, /\$dialog\.ValidateNames = \$false/u);
  assert.match(script, /\$dialog\.CheckFileExists = \$false/u);
  assert.match(script, new RegExp(`\\$dialog\\.FileName = '${MODEL_FOLDER_PLACEHOLDER}'`, 'u'));
  assert.match(script, /\$initialDirectory = 'D:\\models\\current'/u);
});

test('getManagedFilePickerDialogOptions configures preset autoload file picker filters', () => {
  const options = getManagedFilePickerDialogOptions(
    'preset-autoload-file',
    'C:\\Users\\denys\\Documents\\GitHub\\AGENTS.md',
  );

  assert.deepEqual(options, {
    kind: 'file',
    title: 'Select autoload file',
    filter: 'Markdown (*.md)|*.md|Text (*.txt)|*.txt|All files (*.*)|*.*',
    initialPath: 'C:\\Users\\denys\\Documents\\GitHub\\AGENTS.md',
  });
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
