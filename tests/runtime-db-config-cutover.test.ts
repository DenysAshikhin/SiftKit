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

function removeDirectoryWithRetries(targetPath: string, attempts = 40, delayMs = 50): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
      if (code !== 'EPERM' && code !== 'EBUSY') {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

function withTempDir(fn: (dir: string) => void): void {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-runtime-db-'));
  try {
    fn(tempRoot);
  } finally {
    closeRuntimeDatabase();
    removeDirectoryWithRetries(tempRoot);
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

test('readConfig backfills blank managed llama placeholder rows without restoring paths', () => {
  withTempDir((tempRoot) => {
    const databasePath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE runtime_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO runtime_schema (id, version) VALUES (1, 8);

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
        server_kv_cache_quant TEXT,
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
        operation_mode_allowed_tools_json TEXT NOT NULL,
        presets_json TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
    `);

    database.prepare(`
      INSERT INTO app_config (
        id, version, backend, policy_mode, raw_log_retention, prompt_prefix, runtime_model,
        llama_base_url, llama_num_ctx, llama_model_path, llama_temperature, llama_top_p, llama_top_k, llama_min_p,
        llama_presence_penalty, llama_repetition_penalty, llama_max_tokens, llama_threads, llama_flash_attention,
        llama_parallel_slots, llama_reasoning, thresholds_min_characters_for_summary, thresholds_min_lines_for_summary,
        interactive_enabled, interactive_wrapped_commands_json, interactive_idle_timeout_ms,
        interactive_max_transcript_characters, interactive_transcript_retention, server_executable_path, server_base_url,
        server_bind_host, server_port, server_model_path, server_num_ctx, server_gpu_layers, server_threads,
        server_flash_attention, server_parallel_slots, server_batch_size, server_ubatch_size, server_cache_ram, server_kv_cache_quant,
        server_max_tokens, server_temperature, server_top_p, server_top_k, server_min_p, server_presence_penalty,
        server_repetition_penalty, server_reasoning, server_reasoning_budget, server_startup_timeout_ms,
        server_healthcheck_timeout_ms, server_healthcheck_interval_ms, server_verbose_logging,
        operation_mode_allowed_tools_json, presets_json, updated_at_utc
      ) VALUES (
        1, '0.1.0', 'llama.cpp', 'conservative', 1, 'prompt', 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        'http://127.0.0.1:8097', 128000, NULL, 0.7, 0.8, 20, 0.0,
        1.5, 1.0, 15000, -1, 1,
        1, 'off', 500, 16,
        1, '["git"]', 900000,
        60000, 1, NULL, NULL,
        NULL, 0, NULL, 0, 0, 0,
        0, 0, 0, 0, 0, NULL,
        0, NULL, NULL, 0, NULL, NULL,
        NULL, NULL, NULL, 600000,
        2000, 1000, 1,
        '{"summary":["find_text"]}', '[]', @updated_at_utc
      )
    `).run({
      updated_at_utc: new Date().toISOString(),
    });
    database.close();

    const config = readConfig(databasePath);

    assert.equal(config.Server?.LlamaCpp?.ExecutablePath, null);
    assert.equal(config.Server?.LlamaCpp?.ModelPath, null);
    assert.equal(config.Server?.LlamaCpp?.BaseUrl, 'http://127.0.0.1:8097');
    assert.equal(config.Server?.LlamaCpp?.BindHost, '127.0.0.1');
    assert.equal(config.Server?.LlamaCpp?.Port, 8097);
    assert.equal(config.Server?.LlamaCpp?.NumCtx, 150000);
    assert.equal(config.Server?.LlamaCpp?.BatchSize, 512);
    assert.equal(config.Server?.LlamaCpp?.UBatchSize, 512);
    assert.equal(config.Server?.LlamaCpp?.CacheRam, 8192);
    assert.equal(config.Server?.LlamaCpp?.KvCacheQuantization, 'f16');
    assert.equal(config.Server?.LlamaCpp?.MaxTokens, 15000);
    assert.equal(config.Server?.LlamaCpp?.TopP, 0.8);
    assert.equal(config.Server?.LlamaCpp?.Reasoning, 'off');
    assert.equal(config.Server?.LlamaCpp?.ReasoningBudgetMessage, 'Thinking budget exhausted. You have to provide the answer now.');
    assert.equal(config.Server?.LlamaCpp?.VerboseLogging, false);
  });
});

test('writeConfig persists managed llama presets and restores the selected preset into the active launcher config', () => {
  withTempDir((tempRoot) => {
    const databasePath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const config = getDefaultConfig();
    config.Server ??= {};
    config.Server.LlamaCpp ??= {};
    config.Server.LlamaCpp.Presets = [
      {
        ...config.Server.LlamaCpp,
        id: 'default',
        label: 'Default',
      },
      {
        ...config.Server.LlamaCpp,
        id: 'qwen-27b',
        label: 'Qwen 27B',
        ModelPath: 'D:\\models\\Qwen3.5-27B-Q4_K_M.gguf',
        Port: 8098,
        Threads: 0,
        ReasoningBudgetMessage: 'Budget hit. Answer now.',
      },
    ];
    config.Server.LlamaCpp.ActivePresetId = 'qwen-27b';

    writeConfig(databasePath, config);

    const loaded = readConfig(databasePath);
    assert.equal(loaded.Server?.LlamaCpp?.ActivePresetId, 'qwen-27b');
    assert.equal(Array.isArray(loaded.Server?.LlamaCpp?.Presets), true);
    assert.equal(loaded.Server?.LlamaCpp?.Presets?.length, 2);
    assert.equal(loaded.Server?.LlamaCpp?.ModelPath, 'D:\\models\\Qwen3.5-27B-Q4_K_M.gguf');
    assert.equal(loaded.Server?.LlamaCpp?.Port, 8098);
    assert.equal(loaded.Server?.LlamaCpp?.Threads, 0);
    assert.equal(loaded.Server?.LlamaCpp?.ReasoningBudgetMessage, 'Budget hit. Answer now.');
  });
});
