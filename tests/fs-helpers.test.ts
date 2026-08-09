import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { saveContentAtomically } from '../src/lib/fs.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('saveContentAtomically overwrites an existing file and leaves no temp files behind', () => {
  const tempRoot = createManagedTempDir('siftkit-fs-atomic-overwrite-');
  const target = path.join(tempRoot, 'file.json');

  saveContentAtomically(target, 'first');
  saveContentAtomically(target, 'second');

  assert.equal(fs.readFileSync(target, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(tempRoot), ['file.json']);
});
