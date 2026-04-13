import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getRuntimeRoot,
  getConfigPath,
} from '../dist/config/index.js';
import {
  readConfig,
  writeConfig,
  getDefaultConfig,
} from '../dist/status-server/config-store.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';

function withTempDir(fn: (dir: string) => void): void {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-runtime-db-'));
  try {
    fn(tempRoot);
  } finally {
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('getRuntimeRoot fails outside a siftkit repo', () => {
  withTempDir((tempRoot) => {
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      assert.throws(
        () => getRuntimeRoot(),
        /siftkit repo/i,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('getConfigPath points to repo-local runtime sqlite file', () => {
  withTempDir((tempRoot) => {
    const previousCwd = process.cwd();
    try {
      fs.writeFileSync(
        path.join(tempRoot, 'package.json'),
        JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
        'utf8',
      );
      process.chdir(tempRoot);
      assert.equal(
        getConfigPath(),
        path.join(tempRoot, '.siftkit', 'runtime.sqlite'),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('writeConfig persists config to sqlite and never creates config.json', () => {
  withTempDir((tempRoot) => {
    const previousCwd = process.cwd();
    try {
      fs.writeFileSync(
        path.join(tempRoot, 'package.json'),
        JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
        'utf8',
      );
      process.chdir(tempRoot);

      const config = getDefaultConfig();
      config.PolicyMode = 'aggressive';
      writeConfig(getConfigPath(), config);

      const loaded = readConfig(getConfigPath());
      assert.equal(loaded.PolicyMode, 'aggressive');
      assert.equal(
        fs.existsSync(path.join(tempRoot, '.siftkit', 'config.json')),
        false,
      );
      assert.equal(
        fs.existsSync(path.join(tempRoot, '.siftkit', 'runtime.sqlite')),
        true,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});
