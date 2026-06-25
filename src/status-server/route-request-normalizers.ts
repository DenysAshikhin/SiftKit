import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject, OptionalJsonValue } from '../lib/json-types.js';
import type {
  SummaryPolicyProfile,
  SummarySourceKind,
  SummaryTimingInput,
} from '../summary/types.js';
import type { DashboardRunLogType } from './dashboard-runs.js';

export type RepoSearchRouteRequest = {
  prompt: string;
  repoRoot: string;
  model: string | null;
  maxTurns: number | null;
};

export type SummaryRouteRequest = {
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  backend: string | undefined;
  model: string | undefined;
  sourceKind: SummarySourceKind | undefined;
  commandExitCode: number | undefined;
  requestTimeoutSeconds: number;
  timing: SummaryTimingInput | undefined;
};

export type DashboardRunLogDeleteRequest =
  | { mode: 'count'; type: DashboardRunLogType; count: number }
  | { mode: 'beforeDate'; type: DashboardRunLogType; beforeDate: string };

const DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_SECONDS = 240;

function optionalNumber(reader: JsonRecordReader, key: string): number | undefined {
  return reader.number(key) ?? undefined;
}

function normalizeSummaryPolicyProfile(value: OptionalJsonValue): SummaryPolicyProfile {
  return (
    value === 'pass-fail'
    || value === 'unique-errors'
    || value === 'buried-critical'
    || value === 'json-extraction'
    || value === 'diff-summary'
    || value === 'risky-operation'
  ) ? value : 'general';
}

function normalizeSummarySourceKind(value: OptionalJsonValue): SummarySourceKind | undefined {
  return value === 'command-output' ? 'command-output' : undefined;
}

function readSummaryTiming(value: OptionalJsonValue): SummaryTimingInput | undefined {
  const objectValue = JsonRecordReader.asObject(value);
  if (!objectValue) {
    return undefined;
  }
  const reader = new JsonRecordReader(objectValue);
  return {
    processStartedAtMs: reader.number('processStartedAtMs'),
    stdinWaitMs: reader.number('stdinWaitMs'),
    serverPreflightMs: reader.number('serverPreflightMs'),
  };
}

function normalizeRunLogDeleteMode(value: string): 'count' | 'beforeDate' | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'count') {
    return 'count';
  }
  if (normalized === 'beforedate' || normalized === 'before_date') {
    return 'beforeDate';
  }
  return null;
}

function normalizeRunLogDeleteType(value: string): DashboardRunLogType | null {
  const normalized = value.trim().toLowerCase();
  return normalized === 'all'
    || normalized === 'summary'
    || normalized === 'repo_search'
    || normalized === 'planner'
    || normalized === 'chat'
    || normalized === 'other'
    ? normalized
    : null;
}

export function parseRepoSearchRequest(body: JsonObject): RepoSearchRouteRequest | null {
  const reader = new JsonRecordReader(body);
  const prompt = reader.optionalString('prompt');
  if (!prompt) {
    return null;
  }
  return {
    prompt,
    repoRoot: reader.optionalString('repoRoot') || process.cwd(),
    model: reader.nullableString('model'),
    maxTurns: reader.nullableNonNegativeInteger('maxTurns'),
  };
}

export function parseSummaryRequest(body: JsonObject): SummaryRouteRequest | null {
  const reader = new JsonRecordReader(body);
  const question = reader.optionalString('question');
  const inputTextValue = reader.value('inputText');
  const inputText = typeof inputTextValue === 'string' ? inputTextValue : '';
  if (!question || !inputText.trim()) {
    return null;
  }
  return {
    question,
    inputText,
    format: reader.value('format') === 'json' ? 'json' : 'text',
    policyProfile: normalizeSummaryPolicyProfile(reader.value('policyProfile')),
    backend: reader.optionalString('backend'),
    model: reader.optionalString('model'),
    sourceKind: normalizeSummarySourceKind(reader.value('sourceKind')),
    commandExitCode: optionalNumber(reader, 'commandExitCode'),
    requestTimeoutSeconds: reader.positiveNumber('requestTimeoutSeconds', DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_SECONDS),
    timing: readSummaryTiming(reader.value('timing')),
  };
}

export function parseDashboardRunLogDeleteRequest(body: JsonObject): DashboardRunLogDeleteRequest | null {
  const reader = new JsonRecordReader(body);
  const mode = normalizeRunLogDeleteMode(reader.string('mode'));
  const type = normalizeRunLogDeleteType(reader.string('type'));
  if (!mode || !type) {
    return null;
  }
  if (mode === 'count') {
    const count = reader.number('count');
    return count !== null && Number.isInteger(count) && count > 0
      ? { mode, type, count: Math.trunc(count) }
      : null;
  }
  const beforeDate = reader.optionalString('beforeDate');
  if (!beforeDate || !/^\d{4}-\d{2}-\d{2}$/u.test(beforeDate)) {
    return null;
  }
  return Number.isFinite(Date.parse(`${beforeDate}T00:00:00.000Z`))
    ? { mode, type, beforeDate }
    : null;
}
