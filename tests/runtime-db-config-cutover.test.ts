import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

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

test('getRuntimeRoot falls back to cwd outside a siftkit repo', () => {
  withTempDir((tempRoot) => {
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      assert.equal(
        getRuntimeRoot(),
        path.join(tempRoot, '.siftkit'),
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

test('writeConfig tolerates legacy schema v7 managed llama verbose args columns', () => {
  withTempDir((tempRoot) => {
    const databasePath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE runtime_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO runtime_schema (id, version) VALUES (1, 7);

      CREATE TABLE app_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version TEXT NOT NULL,
        backend TEXT NOT NULL,
        policy_mode TEXT NOT NULL,
        raw_log_retention INTEGER NOT NULL CHECK (raw_log_retention IN (0, 1)),
        prompt_prefix TEXT,
        runtime_model TEXT,
        llama_base_url TEXT,
        llama_num_ctx INTEGER,
        llama_model_path TEXT,
        llama_temperature REAL,
        llama_top_p REAL,
        llama_top_k INTEGER,
        llama_min_p REAL,
        llama_presence_penalty REAL,
        llama_repetition_penalty REAL,
        llama_max_tokens INTEGER,
        llama_threads INTEGER,
        llama_flash_attention INTEGER CHECK (llama_flash_attention IN (0, 1) OR llama_flash_attention IS NULL),
        llama_parallel_slots INTEGER,
        llama_reasoning TEXT,
        thresholds_min_characters_for_summary INTEGER NOT NULL,
        thresholds_min_lines_for_summary INTEGER NOT NULL,
        interactive_enabled INTEGER NOT NULL CHECK (interactive_enabled IN (0, 1)),
        interactive_wrapped_commands_json TEXT NOT NULL,
        interactive_idle_timeout_ms INTEGER NOT NULL,
        interactive_max_transcript_characters INTEGER NOT NULL,
        interactive_transcript_retention INTEGER NOT NULL CHECK (interactive_transcript_retention IN (0, 1)),
        server_startup_script TEXT,
        server_shutdown_script TEXT,
        server_executable_path TEXT,
        server_base_url TEXT,
        server_bind_host TEXT,
        server_port INTEGER,
        server_model_path TEXT,
        server_num_ctx INTEGER,
        server_gpu_layers INTEGER,
        server_threads INTEGER,
        server_flash_attention INTEGER CHECK (server_flash_attention IN (0, 1) OR server_flash_attention IS NULL),
        server_parallel_slots INTEGER,
        server_batch_size INTEGER,
        server_ubatch_size INTEGER,
        server_cache_ram INTEGER,
        server_max_tokens INTEGER,
        server_temperature REAL,
        server_top_p REAL,
        server_top_k INTEGER,
        server_min_p REAL,
        server_presence_penalty REAL,
        server_repetition_penalty REAL,
        server_reasoning TEXT,
        server_reasoning_budget INTEGER,
        server_startup_timeout_ms INTEGER,
        server_healthcheck_timeout_ms INTEGER,
        server_healthcheck_interval_ms INTEGER,
        server_verbose_logging INTEGER CHECK (server_verbose_logging IN (0, 1) OR server_verbose_logging IS NULL),
        server_verbose_args_json TEXT NOT NULL,
        operation_mode_allowed_tools_json TEXT NOT NULL,
        presets_json TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );

    `);
    legacy.close();

    const config = getDefaultConfig();
    config.Server ??= {};
    config.Server.LlamaCpp ??= {};
    config.Server.LlamaCpp.ExecutablePath = null;
    config.Server.LlamaCpp.ModelPath = null;

    assert.doesNotThrow(() => {
      writeConfig(databasePath, config);
    });

    const loaded = readConfig(databasePath);
    assert.equal(loaded.Server?.LlamaCpp?.ExecutablePath, null);
    assert.equal(loaded.Server?.LlamaCpp?.ModelPath, null);
  });
});
