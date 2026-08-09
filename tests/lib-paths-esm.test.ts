import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { moduleDirname, moduleFilename, isMainModule } from '../src/lib/paths.js';

// Use the stable source-tree location so this test has the same identity when it
// runs from the generated ESM test tree.
const moduleUrl = pathToFileURL(join(process.cwd(), 'tests', 'lib-paths-esm.test.js')).href;
const modulePath = fileURLToPath(moduleUrl);

test('moduleFilename resolves a module url to its filesystem path', () => {
  assert.equal(moduleFilename(moduleUrl), modulePath);
});

test('moduleDirname resolves a module url to its containing directory', () => {
  assert.equal(moduleDirname(moduleUrl), dirname(modulePath));
});

function withEntryPath(entryPath: string | undefined, run: () => void): void {
  const previous = process.argv[1];
  if (entryPath === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = entryPath;
  }
  try {
    run();
  } finally {
    process.argv[1] = previous;
  }
}

test('isMainModule is true when the module is the process entry point', () => {
  withEntryPath(modulePath, () => {
    assert.equal(isMainModule(moduleUrl), true);
  });
});

test('isMainModule is false when a different module is the entry point', () => {
  const other = fileURLToPath(new URL('./does-not-run.js', moduleUrl));
  withEntryPath(other, () => {
    assert.equal(isMainModule(moduleUrl), false);
  });
});

test('isMainModule is false when there is no process entry point', () => {
  withEntryPath(undefined, () => {
    assert.equal(isMainModule(moduleUrl), false);
  });
});
