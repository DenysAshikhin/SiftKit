import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  closeRuntimeDatabase,
  getRuntimeDatabase,
} from '../src/state/runtime-db.js';

const SessionIdentityRowSchema = z.object({ model_preset_id: z.string() });
const MessageRowSchema = z.object({ content: z.string() });

type SeedSession = {
  id: string;
  model: string | null;
};

type SeedPreset = {
  id: string;
  Model: string | null;
};

function seedV32Database(
  presets: SeedPreset[],
  activePresetId: string,
  sessions: SeedSession[],
): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-v33-'));
  const dbPath = path.join(tempRoot, 'runtime.sqlite');
  const database = new Database(dbPath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 32);
    CREATE TABLE app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      server_llama_presets_json TEXT NOT NULL,
      server_llama_active_preset_id TEXT
    );
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT,
      context_window_tokens INTEGER NOT NULL,
      thinking_enabled INTEGER NOT NULL CHECK (thinking_enabled IN (0, 1)),
      web_search_enabled INTEGER NOT NULL DEFAULT 1 CHECK (web_search_enabled IN (0, 1)),
      preset_id TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('chat', 'plan', 'repo-search')),
      plan_repo_root TEXT NOT NULL,
      condensed_summary TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
    CREATE TABLE chat_messages (
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);
  database.prepare(`
    INSERT INTO app_config (id, server_llama_presets_json, server_llama_active_preset_id)
    VALUES (1, ?, ?)
  `).run(JSON.stringify(presets), activePresetId);
  const insertSession = database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model, context_window_tokens, thinking_enabled, web_search_enabled,
      preset_id, mode, plan_repo_root, condensed_summary, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, 30000, 1, 1, 'chat', 'chat', '.', '', '2026-01-01', '2026-01-01')
  `);
  for (const session of sessions) {
    insertSession.run(session.id, session.id, session.model);
  }
  if (sessions.length > 0) {
    database.prepare('INSERT INTO chat_messages (session_id, id, content) VALUES (?, ?, ?)')
      .run(sessions[0]?.id, 'message-1', 'preserved');
  }
  database.close();
  return dbPath;
}

function removeSeedDatabase(dbPath: string): void {
  closeRuntimeDatabase();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
}

function readSessionIdentity(dbPath: string, sessionId: string): string {
  const database = new Database(dbPath, { readonly: true });
  try {
    return SessionIdentityRowSchema.parse(
      database.prepare('SELECT model_preset_id FROM chat_sessions WHERE id = ?').get(sessionId),
    ).model_preset_id;
  } finally {
    database.close();
  }
}

test('v33 migration assigns the unique preset matching a stored session model', () => {
  const dbPath = seedV32Database(
    [
      { id: 'active', Model: 'current-model' },
      { id: 'historical', Model: 'historical-model' },
    ],
    'active',
    [{ id: 'historical-session', model: 'historical-model' }],
  );

  try {
    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    assert.equal(readSessionIdentity(dbPath, 'historical-session'), 'historical');
    const database = new Database(dbPath, { readonly: true });
    try {
      assert.equal(
        MessageRowSchema.parse(database.prepare('SELECT content FROM chat_messages').get()).content,
        'preserved',
      );
    } finally {
      database.close();
    }
  } finally {
    removeSeedDatabase(dbPath);
  }
});

test('v33 migration assigns model-less sessions to the active preset', () => {
  const dbPath = seedV32Database(
    [{ id: 'active', Model: 'current-model' }],
    'active',
    [{ id: 'model-less-session', model: null }],
  );

  try {
    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    assert.equal(readSessionIdentity(dbPath, 'model-less-session'), 'active');
  } finally {
    removeSeedDatabase(dbPath);
  }
});

test('v33 migration rejects ambiguous stored model matches', () => {
  const dbPath = seedV32Database(
    [
      { id: 'preset-a', Model: 'shared-model' },
      { id: 'preset-b', Model: 'shared-model' },
    ],
    'preset-a',
    [{ id: 'ambiguous-session', model: 'shared-model' }],
  );

  try {
    assert.throws(
      () => getRuntimeDatabase(dbPath),
      /Cannot migrate chat session ambiguous-session: model "shared-model" matches 2 model presets\./u,
    );
  } finally {
    removeSeedDatabase(dbPath);
  }
});

test('v33 migration rejects unmatched stored models', () => {
  const dbPath = seedV32Database(
    [{ id: 'active', Model: 'current-model' }],
    'active',
    [{ id: 'unmatched-session', model: 'missing-model' }],
  );

  try {
    assert.throws(
      () => getRuntimeDatabase(dbPath),
      /Cannot migrate chat session unmatched-session: model "missing-model" matches 0 model presets\./u,
    );
  } finally {
    removeSeedDatabase(dbPath);
  }
});
