import * as fs from 'node:fs';
import { notifyStatusBackend } from '../config/index.js';
import { createTracer } from '../lib/trace.js';
import {
  getPlannerDebugPath,
  getPlannerFailedPath,
} from '../config/paths.js';
import { getRecord } from './planner/json-filter.js';
import type {
  SummaryClassification,
  SummaryFailureContext,
  SummaryFailureError,
  SummarySourceKind,
} from './types.js';

// ---------- failure context ---------- //

export function getSummaryFailureContext(error: unknown): SummaryFailureContext | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const context = (error as SummaryFailureError).siftkitSummaryFailureContext;
  return context && typeof context === 'object' ? context : null;
}

export function attachSummaryFailureContext(
  error: unknown,
  context: SummaryFailureContext
): unknown {
  if (!error || typeof error !== 'object') {
    const wrapped = new Error(String(error)) as SummaryFailureError;
    wrapped.siftkitSummaryFailureContext = context;
    return wrapped;
  }

  const typedError = error as SummaryFailureError;
  typedError.siftkitSummaryFailureContext ??= context;
  return typedError;
}

// ---------- planner debug dump (in-memory, request-scoped) ---------- //

const plannerDebugPayloadByRequestId = new Map<string, Record<string, unknown>>();
const plannerFailedArtifactByRequestId = new Set<string>();

export function readPlannerDebugPayload(requestId: string): Record<string, unknown> {
  return plannerDebugPayloadByRequestId.get(requestId) ?? {};
}

export function updatePlannerDebugDump(
  requestId: string,
  update: (payload: Record<string, unknown>) => Record<string, unknown>,
): void {
  const payload = readPlannerDebugPayload(requestId);
  plannerDebugPayloadByRequestId.set(requestId, update(payload));
}

export function createPlannerDebugRecorder(options: {
  requestId: string;
  question: string;
  inputText: string;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  commandText?: string | null;
}): {
  path: string;
  record: (event: Record<string, unknown>) => void;
  finish: (result: Record<string, unknown>) => void;
} {
  const debugPath = getPlannerDebugPath(options.requestId);
  updatePlannerDebugDump(options.requestId, () => ({
    requestId: options.requestId,
    command: options.commandText ?? null,
    question: options.question,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode ?? null,
    inputText: options.inputText,
    events: [],
    final: null,
  }));
  return {
    path: debugPath,
    record(event) {
      updatePlannerDebugDump(options.requestId, (payload) => ({
        ...payload,
        events: [...(Array.isArray(payload.events) ? payload.events : []), event],
      }));
    },
    finish(result) {
      updatePlannerDebugDump(options.requestId, (payload) => ({
        ...payload,
        final: result,
      }));
    },
  };
}

// ---------- artifact posting via status backend ---------- //

async function postSummaryArtifact(options: {
  requestId: string;
  artifactType: 'summary_request' | 'planner_debug' | 'planner_failed';
  artifactPayload: Record<string, unknown>;
}): Promise<void> {
  await notifyStatusBackend({
    running: false,
    requestId: options.requestId,
    artifactType: options.artifactType,
    artifactRequestId: options.requestId,
    artifactPayload: options.artifactPayload,
  });
}

export async function finalizePlannerDebugDump(options: {
  requestId: string;
  finalOutput: string;
  classification: SummaryClassification;
  rawReviewRequired: boolean;
  providerError?: string | null;
}): Promise<void> {
  updatePlannerDebugDump(options.requestId, (payload) => ({
    ...payload,
    final: {
      ...(getRecord(payload.final) ?? {}),
      finalOutput: options.finalOutput,
      classification: options.classification,
      rawReviewRequired: options.rawReviewRequired,
      providerError: options.providerError ?? null,
    },
  }));
  const payload = readPlannerDebugPayload(options.requestId);
  if (Object.keys(payload).length === 0) {
    return;
  }
  await postSummaryArtifact({
    requestId: options.requestId,
    artifactType: 'planner_debug',
    artifactPayload: payload,
  });
}

export function buildPlannerFailureErrorMessage(options: {
  requestId: string;
  reason?: string | null;
}): string {
  const debugPath = getPlannerDebugPath(options.requestId);
  const final = getRecord(readPlannerDebugPayload(options.requestId).final);
  const reason = options.reason
    || (typeof final?.reason === 'string' ? final.reason : null)
    || 'planner_failed';
  const debugSuffix = fs.existsSync(debugPath)
    ? ` Planner debug dump: ${debugPath}`
    : '';
  return `Planner mode failed: ${reason}.${debugSuffix}`;
}

export async function writeFailedRequestDump(options: {
  requestId: string;
  question: string;
  inputText: string;
  command?: string | null;
  error: string;
  providerError?: string | null;
}): Promise<void> {
  await postSummaryArtifact({
    requestId: options.requestId,
    artifactType: 'planner_failed',
    artifactPayload: {
      requestId: options.requestId,
      command: options.command ?? null,
      question: options.question,
      inputText: options.inputText,
      error: options.error,
      providerError: options.providerError ?? options.error,
      plannerDebugPath: plannerDebugPayloadByRequestId.has(options.requestId) ? getPlannerDebugPath(options.requestId) : null,
    },
  });
  plannerFailedArtifactByRequestId.add(options.requestId);
}

export async function writeSummaryRequestDump(options: {
  requestId: string;
  question: string;
  inputText: string;
  command?: string | null;
  backend: string;
  model: string;
  classification?: SummaryClassification | null;
  rawReviewRequired?: boolean | null;
  summary?: string | null;
  providerError?: string | null;
  error?: string | null;
}): Promise<void> {
  await postSummaryArtifact({
    requestId: options.requestId,
    artifactType: 'summary_request',
    artifactPayload: {
      requestId: options.requestId,
      command: options.command ?? null,
      question: options.question,
      inputText: options.inputText,
      backend: options.backend,
      model: options.model,
      classification: options.classification ?? null,
      ...(options.rawReviewRequired ? { rawReviewRequired: true } : {}),
      summary: options.summary ?? null,
      providerError: options.providerError ?? null,
      error: options.error ?? null,
      plannerDebugPath: plannerDebugPayloadByRequestId.has(options.requestId) ? getPlannerDebugPath(options.requestId) : null,
      failedRequestPath: plannerFailedArtifactByRequestId.has(options.requestId) ? getPlannerFailedPath(options.requestId) : null,
    },
  });
}

export function appendTestProviderEvent(event: Record<string, unknown>): void {
  const logPath = process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
  if (!logPath || !logPath.trim()) {
    return;
  }

  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
}

export function clearSummaryArtifactState(requestId: string): void {
  plannerDebugPayloadByRequestId.delete(requestId);
  plannerFailedArtifactByRequestId.delete(requestId);
}

export const traceSummary = createTracer('SIFTKIT_TRACE_SUMMARY', 'summary');
