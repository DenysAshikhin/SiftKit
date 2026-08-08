import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { saveContentAtomicallyAsync } from '../src/lib/fs.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('saveContentAtomicallyAsync creates missing directories and writes the content', async () => {
  const tempRoot = createManagedTempDir('siftkit-fs-async-');
  const target = path.join(tempRoot, 'nested', 'deeper', 'file.json');

  await saveContentAtomicallyAsync(target, '{"a":1}\n');

  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}\n');
});

test('saveContentAtomicallyAsync overwrites an existing file and leaves no temp files behind', async () => {
  const tempRoot = createManagedTempDir('siftkit-fs-async-overwrite-');
  const target = path.join(tempRoot, 'file.json');

  await saveContentAtomicallyAsync(target, 'first');
  await saveContentAtomicallyAsync(target, 'second');

  assert.equal(fs.readFileSync(target, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(tempRoot), ['file.json']);
});
