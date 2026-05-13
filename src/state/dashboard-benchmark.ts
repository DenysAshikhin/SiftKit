import { randomUUID } from 'node:crypto';
import { getRuntimeDatabase, type RuntimeDatabase } from './runtime-db.js';
import type { Dict } from '../lib/types.js';

export type BenchmarkTaskKind = 'repo-search' | 'summary';
export type BenchmarkSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type BenchmarkRestoreStatus = 'pending' | 'completed' | 'failed';
export type BenchmarkAttemptStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type BenchmarkLogStreamKind = 'orchestrator' | 'attempt_stdout' | 'attempt_stderr' | 'managed_llama';

export type BenchmarkQuestionPresetRecord = {
  id: string;
  title: string;
  taskKind: BenchmarkTaskKind;
  prompt: string;
  enabled: boolean;
  seededKey: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type BenchmarkSessionRecord = {
  id: string;
  status: BenchmarkSessionStatus;
  questionPresetCount: number;
  caseCount: number;
  repetitions: number;
  currentCaseIndex: number | null;
  currentPromptIndex: number | null;
  currentRepeatIndex: number | null;
  restoreStatus: BenchmarkRestoreStatus;
  restoreError: string | null;
  originalConfigJson: string;
  startedAtUtc: string;
  completedAtUtc: string | null;
  updatedAtUtc: string;
};

export type BenchmarkCaseRecord = {
  id: string;
  sessionId: string;
  caseIndex: number;
  label: string;
  managedPresetId: string;
  managedPresetLabel: string;
  managedPreset: Dict;
  specOverride: Dict;
  createdAtUtc: string;
};

export type BenchmarkAttemptRecord = {
  id: string;
  sessionId: string;
  caseId: string;
  questionPresetId: string;
  taskKind: BenchmarkTaskKind;
  promptTitle: string;
  prompt: string;
  caseLabel: string;
  managedPresetId: string;
  managedPresetLabel: string;
  caseIndex: number;
  promptIndex: number;
  repeatIndex: number;
  status: BenchmarkAttemptStatus;
  outputText: string | null;
  error: string | null;
  runId: string | null;
  managedRunId: string | null;
  durationMs: number | null;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  acceptanceRate: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  outputQualityScore: number | null;
  toolUseQualityScore: number | null;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAtUtc: string | null;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  updatedAtUtc: string;
};

export type BenchmarkSessionDetail = {
  session: BenchmarkSessionRecord;
  cases: BenchmarkCaseRecord[];
  attempts: BenchmarkAttemptRecord[];
};

export type BenchmarkManagedPresetInput = {
  id: string;
  label: string;
} & Dict;

export type BenchmarkSpecOverrideInput = {
  label?: string;
  SpeculativeEnabled?: boolean;
  SpeculativeType?: string;
  SpeculativeNgramSizeN?: number;
  SpeculativeNgramSizeM?: number;
  SpeculativeNgramMinHits?: number;
  SpeculativeDraftMax?: number;
  SpeculativeDraftMin?: number;
};

export type BenchmarkSessionPlan = {
  session: BenchmarkSessionRecord;
  cases: BenchmarkCaseRecord[];
  attempts: BenchmarkAttemptRecord[];
};

export const DEFAULT_BENCHMARK_QUESTION_PRESETS: Array<{
  seededKey: string;
  title: string;
  taskKind: BenchmarkTaskKind;
  prompt: string;
}> = [
  {
    seededKey: 'spec-log-delta-source',
    title: 'Trace speculative log deltas',
    taskKind: 'repo-search',
    prompt: 'trace the managed-llama log-delta source for speculativeAcceptedTokens and speculativeGeneratedTokens; return exact file:line anchors from log parse through benchmark output',
  },
  {
    seededKey: 'repo-search-telemetry-path',
    title: 'Trace repo-search telemetry',
    taskKind: 'repo-search',
    prompt: 'trace the repo-search completion telemetry path end to end: starting at executeRepoSearchRequest, find where promptCacheTokens, promptEvalTokens, outputTokens, thinkingTokens, and requestDurationMs are computed, persisted to run_logs, and exposed through /dashboard/runs; return exact file:line anchors grouped by stage',
  },
  {
    seededKey: 'canonical-spec-metrics-flow',
    title: 'Trace canonical spec metrics',
    taskKind: 'repo-search',
    prompt: 'trace the canonical speculative metrics flow end to end: find where managed llama logs are parsed, where speculativeAcceptedTokens and speculativeGeneratedTokens are written to run_logs, and where dashboard metrics or idle summaries read those persisted fields; return exact file:line anchors grouped by parse, persist, and read stages',
  },
  {
    seededKey: 'dynamic-output-token-cap',
    title: 'Trace dynamic output token cap',
    taskKind: 'repo-search',
    prompt: 'trace the dynamic output token cap path end to end: find where remaining context tokens are computed, where max_tokens is derived for repo-search planner and terminal synthesis, and where summary/chat requests reuse the same cap; return exact file:line anchors grouped by repo-search, shared provider, and chat paths',
  },
  {
    seededKey: 'benchmark-metric-write-path',
    title: 'Trace benchmark metric writes',
    taskKind: 'repo-search',
    prompt: 'find where benchmark acceptanceRate and generationTokensPerSecond are computed and written to summary.csv/results.json; return exact file:line anchors and the exact source expressions used for each metric',
  },
  {
    seededKey: 'spec-benchmark-restart-lifecycle',
    title: 'Trace restart lifecycle',
    taskKind: 'repo-search',
    prompt: 'trace the spec benchmark restart lifecycle end to end: find where each case config is applied, where /status/restart is called, where health/readiness is awaited, and where managed llama run baselines are captured; return exact file:line anchors grouped by config, restart, health, and baseline capture',
  },
  {
    seededKey: 'spec-metrics-log-delta-verification',
    title: 'Verify spec metrics source',
    taskKind: 'repo-search',
    prompt: 'verify that speculativeAcceptedTokens and speculativeGeneratedTokens in the spec benchmark come only from managed-llama log deltas; return exact file:line anchors for parse, delta, and output paths',
  },
  {
    seededKey: 'repo-search-budget-tool-output-limit',
    title: 'Trace repo-search budgets',
    taskKind: 'repo-search',
    prompt: 'trace the repo-search prompt-budget and tool-output-limit path end to end: find where remaining token allowance is computed, where per tool call allowance is enforced, and where the "requested output would consume" failure text is emitted; return exact file:line anchors grouped by budget calculation, enforcement, and error reporting',
  },
  {
    seededKey: 'managed-llama-degraded-lifecycle',
    title: 'Trace managed llama lifecycle',
    taskKind: 'repo-search',
    prompt: 'trace the managed llama restart/degraded-mode lifecycle end to end: find where llama_stop and llama_start are invoked, where startup warning/error markers trigger degraded mode, and where status/config endpoints surface server unavailable behavior; return exact file:line anchors grouped by stop/start, degraded mode, and HTTP surface',
  },
];

const TASK_KINDS = new Set<BenchmarkTaskKind>(['repo-search', 'summary']);
const SESSION_STATUSES = new Set<BenchmarkSessionStatus>(['running', 'completed', 'failed', 'cancelled']);
const RESTORE_STATUSES = new Set<BenchmarkRestoreStatus>(['pending', 'completed', 'failed']);
const ATTEMPT_STATUSES = new Set<BenchmarkAttemptStatus>(['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped']);
const LOG_STREAMS = new Set<BenchmarkLogStreamKind>(['orchestrator', 'attempt_stdout', 'attempt_stderr', 'managed_llama']);
const SPEC_OVERRIDE_KEYS = [
  'SpeculativeEnabled',
  'SpeculativeType',
  'SpeculativeNgramSizeN',
  'SpeculativeNgramSizeM',
  'SpeculativeNgramMinHits',
  'SpeculativeDraftMax',
  'SpeculativeDraftMin',
] as const;

function getDatabase(databasePath?: string): RuntimeDatabase {
  return getRuntimeDatabase(databasePath);
}

function nowUtc(): string {
  return new Date().toISOString();
}

function readRequiredText(value: unknown, fieldName: string): string {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`Expected ${fieldName}.`);
  }
  return text;
}

function normalizeTaskKind(value: unknown): BenchmarkTaskKind {
  const taskKind = String(value || '').trim() as BenchmarkTaskKind;
  if (!TASK_KINDS.has(taskKind)) {
    throw new Error('Expected taskKind to be repo-search or summary.');
  }
  return taskKind;
}

function normalizeSessionStatus(value: unknown): BenchmarkSessionStatus {
  const status = String(value || '').trim() as BenchmarkSessionStatus;
  return SESSION_STATUSES.has(status) ? status : 'running';
}

function normalizeRestoreStatus(value: unknown): BenchmarkRestoreStatus {
  const status = String(value || '').trim() as BenchmarkRestoreStatus;
  return RESTORE_STATUSES.has(status) ? status : 'pending';
}

function normalizeAttemptStatus(value: unknown): BenchmarkAttemptStatus {
  const status = String(value || '').trim() as BenchmarkAttemptStatus;
  return ATTEMPT_STATUSES.has(status) ? status : 'pending';
}

function normalizeLogStream(value: unknown): BenchmarkLogStreamKind {
  const stream = String(value || '').trim() as BenchmarkLogStreamKind;
  if (!LOG_STREAMS.has(stream)) {
    throw new Error('Expected valid benchmark log stream kind.');
  }
  return stream;
}

function readNullableNumber(value: unknown): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

function readNullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseJsonDict(value: unknown): Dict {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Dict : {};
  } catch {
    return {};
  }
}

function normalizeQuestionPreset(row: Record<string, unknown> | undefined): BenchmarkQuestionPresetRecord | null {
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    title: String(row.title || ''),
    taskKind: normalizeTaskKind(row.task_kind),
    prompt: String(row.prompt || ''),
    enabled: Number(row.enabled) === 1,
    seededKey: readNullableText(row.seeded_key),
    createdAtUtc: String(row.created_at_utc || ''),
    updatedAtUtc: String(row.updated_at_utc || ''),
  };
}

function normalizeSession(row: Record<string, unknown> | undefined): BenchmarkSessionRecord | null {
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    status: normalizeSessionStatus(row.status),
    questionPresetCount: Number(row.question_preset_count || 0),
    caseCount: Number(row.case_count || 0),
    repetitions: Number(row.repetitions || 0),
    currentCaseIndex: readNullableNumber(row.current_case_index),
    currentPromptIndex: readNullableNumber(row.current_prompt_index),
    currentRepeatIndex: readNullableNumber(row.current_repeat_index),
    restoreStatus: normalizeRestoreStatus(row.restore_status),
    restoreError: readNullableText(row.restore_error),
    originalConfigJson: String(row.original_config_json || '{}'),
    startedAtUtc: String(row.started_at_utc || ''),
    completedAtUtc: readNullableText(row.completed_at_utc),
    updatedAtUtc: String(row.updated_at_utc || ''),
  };
}

function normalizeCase(row: Record<string, unknown> | undefined): BenchmarkCaseRecord | null {
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    sessionId: String(row.session_id || ''),
    caseIndex: Number(row.case_index || 0),
    label: String(row.label || ''),
    managedPresetId: String(row.managed_preset_id || ''),
    managedPresetLabel: String(row.managed_preset_label || ''),
    managedPreset: parseJsonDict(row.managed_preset_json),
    specOverride: parseJsonDict(row.spec_override_json),
    createdAtUtc: String(row.created_at_utc || ''),
  };
}

function normalizeAttempt(row: Record<string, unknown> | undefined): BenchmarkAttemptRecord | null {
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    sessionId: String(row.session_id || ''),
    caseId: String(row.case_id || ''),
    questionPresetId: String(row.question_preset_id || ''),
    taskKind: normalizeTaskKind(row.task_kind),
    promptTitle: String(row.prompt_title || ''),
    prompt: String(row.prompt || ''),
    caseLabel: String(row.case_label || ''),
    managedPresetId: String(row.managed_preset_id || ''),
    managedPresetLabel: String(row.managed_preset_label || ''),
    caseIndex: Number(row.case_index || 0),
    promptIndex: Number(row.prompt_index || 0),
    repeatIndex: Number(row.repeat_index || 0),
    status: normalizeAttemptStatus(row.status),
    outputText: readNullableText(row.output_text),
    error: readNullableText(row.error),
    runId: readNullableText(row.run_id),
    managedRunId: readNullableText(row.managed_run_id),
    durationMs: readNullableNumber(row.duration_ms),
    promptTokensPerSecond: readNullableNumber(row.prompt_tokens_per_second),
    generationTokensPerSecond: readNullableNumber(row.generation_tokens_per_second),
    acceptanceRate: readNullableNumber(row.acceptance_rate),
    outputTokens: readNullableNumber(row.output_tokens),
    thinkingTokens: readNullableNumber(row.thinking_tokens),
    speculativeAcceptedTokens: readNullableNumber(row.speculative_accepted_tokens),
    speculativeGeneratedTokens: readNullableNumber(row.speculative_generated_tokens),
    outputQualityScore: readNullableNumber(row.output_quality_score),
    toolUseQualityScore: readNullableNumber(row.tool_use_quality_score),
    reviewNotes: readNullableText(row.review_notes),
    reviewedBy: readNullableText(row.reviewed_by),
    reviewedAtUtc: readNullableText(row.reviewed_at_utc),
    startedAtUtc: readNullableText(row.started_at_utc),
    completedAtUtc: readNullableText(row.completed_at_utc),
    updatedAtUtc: String(row.updated_at_utc || ''),
  };
}

export function seedBenchmarkQuestionPresets(options: { databasePath?: string } = {}): BenchmarkQuestionPresetRecord[] {
  const database = getDatabase(options.databasePath);
  const created: BenchmarkQuestionPresetRecord[] = [];
  const insert = database.prepare(`
    INSERT OR IGNORE INTO benchmark_question_presets (
      id, title, task_kind, prompt, enabled, seeded_key, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `);
  for (const preset of DEFAULT_BENCHMARK_QUESTION_PRESETS) {
    const timestamp = nowUtc();
    const id = `seed-${preset.seededKey}`;
    const result = insert.run(id, preset.title, preset.taskKind, preset.prompt, preset.seededKey, timestamp, timestamp);
    if (Number(result.changes) > 0) {
      const row = readBenchmarkQuestionPreset(id, options.databasePath);
      if (row) created.push(row);
    }
  }
  return created;
}

export function createBenchmarkQuestionPreset(options: {
  title: string;
  taskKind: BenchmarkTaskKind;
  prompt: string;
  enabled?: boolean;
  databasePath?: string;
}): BenchmarkQuestionPresetRecord {
  const database = getDatabase(options.databasePath);
  const timestamp = nowUtc();
  const id = randomUUID();
  database.prepare(`
    INSERT INTO benchmark_question_presets (
      id, title, task_kind, prompt, enabled, seeded_key, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    readRequiredText(options.title, 'title'),
    normalizeTaskKind(options.taskKind),
    readRequiredText(options.prompt, 'prompt'),
    options.enabled === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  const created = readBenchmarkQuestionPreset(id, options.databasePath);
  if (!created) {
    throw new Error('Failed to create benchmark question preset.');
  }
  return created;
}

export function readBenchmarkQuestionPreset(id: string, databasePath?: string): BenchmarkQuestionPresetRecord | null {
  const presetId = String(id || '').trim();
  if (!presetId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const row = database.prepare(`
    SELECT id, title, task_kind, prompt, enabled, seeded_key, created_at_utc, updated_at_utc
    FROM benchmark_question_presets
    WHERE id = ?
  `).get(presetId) as Record<string, unknown> | undefined;
  return normalizeQuestionPreset(row);
}

export function listBenchmarkQuestionPresets(options: {
  databasePath?: string;
  taskKind?: BenchmarkTaskKind | '';
  includeDisabled?: boolean;
} = {}): BenchmarkQuestionPresetRecord[] {
  const database = getDatabase(options.databasePath);
  const filters: string[] = [];
  const params: unknown[] = [];
  if (options.taskKind) {
    filters.push('task_kind = ?');
    params.push(normalizeTaskKind(options.taskKind));
  }
  if (!options.includeDisabled) {
    filters.push('enabled = 1');
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = database.prepare(`
    SELECT id, title, task_kind, prompt, enabled, seeded_key, created_at_utc, updated_at_utc
    FROM benchmark_question_presets
    ${where}
    ORDER BY task_kind ASC, title COLLATE NOCASE ASC, id ASC
  `).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => normalizeQuestionPreset(row)).filter((row): row is BenchmarkQuestionPresetRecord => row !== null);
}

export function updateBenchmarkQuestionPreset(options: {
  id: string;
  title?: string;
  taskKind?: BenchmarkTaskKind;
  prompt?: string;
  enabled?: boolean;
  databasePath?: string;
}): BenchmarkQuestionPresetRecord | null {
  const existing = readBenchmarkQuestionPreset(options.id, options.databasePath);
  if (!existing) {
    return null;
  }
  const title = options.title === undefined ? existing.title : readRequiredText(options.title, 'title');
  const prompt = options.prompt === undefined ? existing.prompt : readRequiredText(options.prompt, 'prompt');
  const taskKind = options.taskKind === undefined ? existing.taskKind : normalizeTaskKind(options.taskKind);
  const enabled = options.enabled === undefined ? existing.enabled : options.enabled;
  getDatabase(options.databasePath).prepare(`
    UPDATE benchmark_question_presets
    SET title = ?, task_kind = ?, prompt = ?, enabled = ?, updated_at_utc = ?
    WHERE id = ?
  `).run(title, taskKind, prompt, enabled ? 1 : 0, nowUtc(), existing.id);
  return readBenchmarkQuestionPreset(existing.id, options.databasePath);
}

export function deleteBenchmarkQuestionPreset(id: string, databasePath?: string): boolean {
  const presetId = String(id || '').trim();
  if (!presetId) {
    return false;
  }
  const result = getDatabase(databasePath).prepare('DELETE FROM benchmark_question_presets WHERE id = ?').run(presetId);
  return Number(result.changes) > 0;
}

function normalizeSpecOverride(input: BenchmarkSpecOverrideInput): Dict {
  const output: Dict = {};
  for (const key of SPEC_OVERRIDE_KEYS) {
    const value = input[key];
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function getSpecOverrideLabel(input: BenchmarkSpecOverrideInput): string {
  if (typeof input.label === 'string' && input.label.trim()) {
    return input.label.trim();
  }
  const normalized = normalizeSpecOverride(input);
  const n = normalized.SpeculativeNgramSizeN;
  const m = normalized.SpeculativeNgramSizeM;
  const h = normalized.SpeculativeNgramMinHits;
  const dmax = normalized.SpeculativeDraftMax;
  const dmin = normalized.SpeculativeDraftMin;
  if ([n, m, h, dmax, dmin].some((value) => value !== undefined)) {
    return `n${String(n ?? 'x')}-m${String(m ?? 'x')}-h${String(h ?? 'x')}-dmax${String(dmax ?? 'x')}-dmin${String(dmin ?? 'x')}`;
  }
  return 'Current spec settings';
}

export function createBenchmarkSessionPlan(options: {
  questionPresetIds: string[];
  repetitions: number;
  managedPresets: BenchmarkManagedPresetInput[];
  specOverrides: BenchmarkSpecOverrideInput[];
  originalConfigJson: string;
  databasePath?: string;
}): BenchmarkSessionPlan {
  const database = getDatabase(options.databasePath);
  const questionPresetIds = options.questionPresetIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (questionPresetIds.length === 0) {
    throw new Error('Expected at least one benchmark question preset.');
  }
  const repetitions = Math.trunc(Number(options.repetitions));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new Error('Expected repetitions between 1 and 100.');
  }
  if (options.managedPresets.length === 0) {
    throw new Error('Expected at least one managed llama preset.');
  }
  const specOverrides = options.specOverrides.length > 0 ? options.specOverrides : [{ label: 'Current spec settings' }];
  const prompts = questionPresetIds.map((id) => {
    const preset = readBenchmarkQuestionPreset(id, options.databasePath);
    if (!preset) {
      throw new Error(`Benchmark question preset not found: ${id}`);
    }
    return preset;
  });
  const timestamp = nowUtc();
  const sessionId = randomUUID();
  const caseCount = options.managedPresets.length * specOverrides.length;
  const transaction = database.transaction(() => {
    database.prepare(`
      INSERT INTO benchmark_sessions (
        id, status, question_preset_count, case_count, repetitions,
        current_case_index, current_prompt_index, current_repeat_index,
        restore_status, restore_error, original_config_json,
        started_at_utc, completed_at_utc, updated_at_utc
      ) VALUES (?, 'running', ?, ?, ?, NULL, NULL, NULL, 'pending', NULL, ?, ?, NULL, ?)
    `).run(sessionId, prompts.length, caseCount, repetitions, options.originalConfigJson, timestamp, timestamp);

    let caseIndex = 0;
    for (const managedPreset of options.managedPresets) {
      const managedPresetId = readRequiredText(managedPreset.id, 'managed preset id');
      const managedPresetLabel = readRequiredText(managedPreset.label, 'managed preset label');
      for (const specOverrideInput of specOverrides) {
        const specOverride = normalizeSpecOverride(specOverrideInput);
        const caseLabel = `${managedPresetLabel} / ${getSpecOverrideLabel(specOverrideInput)}`;
        const caseId = randomUUID();
        database.prepare(`
          INSERT INTO benchmark_cases (
            id, session_id, case_index, label, managed_preset_id, managed_preset_label,
            managed_preset_json, spec_override_json, created_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          caseId,
          sessionId,
          caseIndex,
          caseLabel,
          managedPresetId,
          managedPresetLabel,
          JSON.stringify(managedPreset),
          JSON.stringify(specOverride),
          timestamp,
        );
        for (let promptIndex = 0; promptIndex < prompts.length; promptIndex += 1) {
          const prompt = prompts[promptIndex];
          for (let repeatIndex = 0; repeatIndex < repetitions; repeatIndex += 1) {
            database.prepare(`
              INSERT INTO benchmark_attempts (
                id, session_id, case_id, question_preset_id, task_kind, prompt_title, prompt,
                case_label, managed_preset_id, managed_preset_label,
                case_index, prompt_index, repeat_index, status, updated_at_utc
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            `).run(
              randomUUID(),
              sessionId,
              caseId,
              prompt.id,
              prompt.taskKind,
              prompt.title,
              prompt.prompt,
              caseLabel,
              managedPresetId,
              managedPresetLabel,
              caseIndex,
              promptIndex,
              repeatIndex,
              timestamp,
            );
          }
        }
        caseIndex += 1;
      }
    }
  });
  transaction();
  const detail = readBenchmarkSessionDetail(sessionId, options.databasePath);
  if (!detail) {
    throw new Error('Failed to create benchmark session.');
  }
  return detail;
}

export function listBenchmarkSessions(options: {
  databasePath?: string;
  limit?: number;
  status?: BenchmarkSessionStatus | '';
} = {}): BenchmarkSessionRecord[] {
  const database = getDatabase(options.databasePath);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(Number(options.limit))) : 50;
  const status = String(options.status || '').trim();
  const rows = status && SESSION_STATUSES.has(status as BenchmarkSessionStatus)
    ? database.prepare(`
      SELECT * FROM benchmark_sessions
      WHERE status = ?
      ORDER BY started_at_utc DESC, id DESC
      LIMIT ?
    `).all(status, limit) as Array<Record<string, unknown>>
    : database.prepare(`
      SELECT * FROM benchmark_sessions
      ORDER BY started_at_utc DESC, id DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => normalizeSession(row)).filter((row): row is BenchmarkSessionRecord => row !== null);
}

export function readBenchmarkSessionDetail(id: string, databasePath?: string): BenchmarkSessionDetail | null {
  const sessionId = String(id || '').trim();
  if (!sessionId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const session = normalizeSession(database.prepare('SELECT * FROM benchmark_sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined);
  if (!session) {
    return null;
  }
  const cases = (database.prepare(`
    SELECT * FROM benchmark_cases
    WHERE session_id = ?
    ORDER BY case_index ASC
  `).all(sessionId) as Array<Record<string, unknown>>)
    .map((row) => normalizeCase(row))
    .filter((row): row is BenchmarkCaseRecord => row !== null);
  const attempts = listBenchmarkAttemptsForSession(sessionId, databasePath);
  return { session, cases, attempts };
}

export function listBenchmarkAttemptsForSession(sessionId: string, databasePath?: string): BenchmarkAttemptRecord[] {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return [];
  }
  const rows = getDatabase(databasePath).prepare(`
    SELECT * FROM benchmark_attempts
    WHERE session_id = ?
    ORDER BY case_index ASC, prompt_index ASC, repeat_index ASC
  `).all(normalizedSessionId) as Array<Record<string, unknown>>;
  return rows.map((row) => normalizeAttempt(row)).filter((row): row is BenchmarkAttemptRecord => row !== null);
}

export function updateBenchmarkSessionStatus(options: {
  databasePath?: string;
  sessionId: string;
  status?: BenchmarkSessionStatus;
  currentCaseIndex?: number | null;
  currentPromptIndex?: number | null;
  currentRepeatIndex?: number | null;
  restoreStatus?: BenchmarkRestoreStatus;
  restoreError?: string | null;
  completedAtUtc?: string | null;
}): BenchmarkSessionRecord | null {
  const existing = readBenchmarkSessionDetail(options.sessionId, options.databasePath)?.session;
  if (!existing) {
    return null;
  }
  const timestamp = nowUtc();
  getDatabase(options.databasePath).prepare(`
    UPDATE benchmark_sessions
    SET status = ?,
        current_case_index = ?,
        current_prompt_index = ?,
        current_repeat_index = ?,
        restore_status = ?,
        restore_error = ?,
        completed_at_utc = ?,
        updated_at_utc = ?
    WHERE id = ?
  `).run(
    options.status ?? existing.status,
    options.currentCaseIndex === undefined ? existing.currentCaseIndex : options.currentCaseIndex,
    options.currentPromptIndex === undefined ? existing.currentPromptIndex : options.currentPromptIndex,
    options.currentRepeatIndex === undefined ? existing.currentRepeatIndex : options.currentRepeatIndex,
    options.restoreStatus ?? existing.restoreStatus,
    options.restoreError === undefined ? existing.restoreError : options.restoreError,
    options.completedAtUtc === undefined ? existing.completedAtUtc : options.completedAtUtc,
    timestamp,
    existing.id,
  );
  return readBenchmarkSessionDetail(existing.id, options.databasePath)?.session ?? null;
}

export function updateBenchmarkAttempt(options: {
  databasePath?: string;
  attemptId: string;
  status?: BenchmarkAttemptStatus;
  outputText?: string | null;
  error?: string | null;
  runId?: string | null;
  managedRunId?: string | null;
  durationMs?: number | null;
  promptTokensPerSecond?: number | null;
  generationTokensPerSecond?: number | null;
  acceptanceRate?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  startedAtUtc?: string | null;
  completedAtUtc?: string | null;
}): BenchmarkAttemptRecord | null {
  const existing = readBenchmarkAttempt(options.attemptId, options.databasePath);
  if (!existing) {
    return null;
  }
  getDatabase(options.databasePath).prepare(`
    UPDATE benchmark_attempts
    SET status = ?,
        output_text = ?,
        error = ?,
        run_id = ?,
        managed_run_id = ?,
        duration_ms = ?,
        prompt_tokens_per_second = ?,
        generation_tokens_per_second = ?,
        acceptance_rate = ?,
        output_tokens = ?,
        thinking_tokens = ?,
        speculative_accepted_tokens = ?,
        speculative_generated_tokens = ?,
        started_at_utc = ?,
        completed_at_utc = ?,
        updated_at_utc = ?
    WHERE id = ?
  `).run(
    options.status ?? existing.status,
    options.outputText === undefined ? existing.outputText : options.outputText,
    options.error === undefined ? existing.error : options.error,
    options.runId === undefined ? existing.runId : options.runId,
    options.managedRunId === undefined ? existing.managedRunId : options.managedRunId,
    options.durationMs === undefined ? existing.durationMs : options.durationMs,
    options.promptTokensPerSecond === undefined ? existing.promptTokensPerSecond : options.promptTokensPerSecond,
    options.generationTokensPerSecond === undefined ? existing.generationTokensPerSecond : options.generationTokensPerSecond,
    options.acceptanceRate === undefined ? existing.acceptanceRate : options.acceptanceRate,
    options.outputTokens === undefined ? existing.outputTokens : options.outputTokens,
    options.thinkingTokens === undefined ? existing.thinkingTokens : options.thinkingTokens,
    options.speculativeAcceptedTokens === undefined ? existing.speculativeAcceptedTokens : options.speculativeAcceptedTokens,
    options.speculativeGeneratedTokens === undefined ? existing.speculativeGeneratedTokens : options.speculativeGeneratedTokens,
    options.startedAtUtc === undefined ? existing.startedAtUtc : options.startedAtUtc,
    options.completedAtUtc === undefined ? existing.completedAtUtc : options.completedAtUtc,
    nowUtc(),
    existing.id,
  );
  return readBenchmarkAttempt(existing.id, options.databasePath);
}

export function readBenchmarkAttempt(id: string, databasePath?: string): BenchmarkAttemptRecord | null {
  const attemptId = String(id || '').trim();
  if (!attemptId) {
    return null;
  }
  const row = getDatabase(databasePath).prepare('SELECT * FROM benchmark_attempts WHERE id = ?').get(attemptId) as Record<string, unknown> | undefined;
  return normalizeAttempt(row);
}

function normalizeScore(value: number | null | undefined, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const score = Math.trunc(Number(value));
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    throw new Error(`${fieldName} must be 0-10 or null.`);
  }
  return score;
}

export function updateBenchmarkAttemptGrade(options: {
  databasePath?: string;
  attemptId: string;
  outputQualityScore: number | null;
  toolUseQualityScore: number | null;
  reviewNotes: string | null;
  reviewedBy: string;
}): BenchmarkAttemptRecord | null {
  const existing = readBenchmarkAttempt(options.attemptId, options.databasePath);
  if (!existing) {
    return null;
  }
  getDatabase(options.databasePath).prepare(`
    UPDATE benchmark_attempts
    SET output_quality_score = ?,
        tool_use_quality_score = ?,
        review_notes = ?,
        reviewed_by = ?,
        reviewed_at_utc = ?,
        updated_at_utc = ?
    WHERE id = ?
  `).run(
    normalizeScore(options.outputQualityScore, 'outputQualityScore'),
    normalizeScore(options.toolUseQualityScore, 'toolUseQualityScore'),
    options.reviewNotes,
    readRequiredText(options.reviewedBy, 'reviewedBy'),
    nowUtc(),
    nowUtc(),
    existing.id,
  );
  return readBenchmarkAttempt(existing.id, options.databasePath);
}

function getNextLogSequence(database: RuntimeDatabase, sessionId: string, attemptId: string | null, streamKind: BenchmarkLogStreamKind): number {
  const row = database.prepare(`
    SELECT MAX(sequence) AS max_sequence
    FROM benchmark_logs
    WHERE session_id = ?
      AND ((attempt_id IS NULL AND ? IS NULL) OR attempt_id = ?)
      AND stream_kind = ?
  `).get(sessionId, attemptId, attemptId, streamKind) as { max_sequence?: number | null } | undefined;
  return Number.isFinite(row?.max_sequence) ? Number(row?.max_sequence) + 1 : 0;
}

export function appendBenchmarkLogChunk(options: {
  databasePath?: string;
  sessionId: string;
  attemptId?: string | null;
  streamKind: BenchmarkLogStreamKind;
  chunkText: string;
  sequence?: number;
}): void {
  const sessionId = readRequiredText(options.sessionId, 'sessionId');
  const attemptId = options.attemptId ? String(options.attemptId).trim() : null;
  const chunkText = String(options.chunkText || '');
  if (!chunkText) {
    return;
  }
  const database = getDatabase(options.databasePath);
  const streamKind = normalizeLogStream(options.streamKind);
  const sequence = Number.isFinite(options.sequence)
    ? Math.max(0, Math.trunc(Number(options.sequence)))
    : getNextLogSequence(database, sessionId, attemptId, streamKind);
  database.prepare(`
    INSERT INTO benchmark_logs (
      session_id, attempt_id, stream_kind, sequence, chunk_text, created_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, attempt_id, stream_kind, sequence) DO UPDATE SET
      chunk_text = benchmark_logs.chunk_text || excluded.chunk_text
  `).run(sessionId, attemptId, streamKind, sequence, chunkText, nowUtc());
}

export function readBenchmarkLogTextByStream(options: {
  databasePath?: string;
  sessionId: string;
  attemptId?: string | null;
}): Record<BenchmarkLogStreamKind, string> {
  const sessionId = String(options.sessionId || '').trim();
  const attemptId = options.attemptId ? String(options.attemptId).trim() : null;
  const output: Record<BenchmarkLogStreamKind, string> = {
    orchestrator: '',
    attempt_stdout: '',
    attempt_stderr: '',
    managed_llama: '',
  };
  if (!sessionId) {
    return output;
  }
  const rows = getDatabase(options.databasePath).prepare(`
    SELECT stream_kind, chunk_text
    FROM benchmark_logs
    WHERE session_id = ?
      AND ((attempt_id IS NULL AND ? IS NULL) OR attempt_id = ?)
    ORDER BY stream_kind ASC, sequence ASC, id ASC
  `).all(sessionId, attemptId, attemptId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const streamKind = normalizeLogStream(row.stream_kind);
    output[streamKind] = `${output[streamKind]}${String(row.chunk_text || '')}`;
  }
  return output;
}
