import * as fs from 'node:fs';
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

export type SummaryDeferredArtifact = {
  artifactType: 'summary_request' | 'planner_debug' | 'planner_failed';
  artifactRequestId: string;
  artifactPayload: Record<string, unknown>;
};

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

// ---------- deferred artifact payload builders ---------- //

export function buildPlannerDebugArtifact(options: {
  requestId: string;
  finalOutput: string;
  classification: SummaryClassification;
  rawReviewRequired: boolean;
  providerError?: string | null;
}): SummaryDeferredArtifact | null {
  if (!plannerDebugPayloadByRequestId.has(options.requestId)) {
    return null;
  }
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
    return null;
  }
  return {
    artifactType: 'planner_debug',
    artifactRequestId: options.requestId,
    artifactPayload: payload,
  };
}

export async function finalizePlannerDebugDump(options: {
  requestId: string;
  finalOutput: string;
  classification: SummaryClassification;
  rawReviewRequired: boolean;
  providerError?: string | null;
}): Promise<void> {
  void buildPlannerDebugArtifact(options);
}

export function buildDeferredPlannerDebugPath(requestId: string): string | null {
  return plannerDebugPayloadByRequestId.has(requestId) || fs.existsSync(getPlannerDebugPath(requestId))
    ? getPlannerDebugPath(requestId)
    : null;
}

export function buildPlannerFailureErrorMessage(options: {
  requestId: string;
  reason?: string | null;
}): string {
  const debugPath = buildDeferredPlannerDebugPath(options.requestId);
  const final = getRecord(readPlannerDebugPayload(options.requestId).final);
  const reason = options.reason
    || (typeof final?.reason === 'string' ? final.reason : null)
    || 'planner_failed';
  const debugSuffix = debugPath
    ? ` Planner debug dump: ${debugPath}`
    : '';
  return `Planner mode failed: ${reason}.${debugSuffix}`;
}

export function buildFailedRequestArtifact(options: {
  requestId: string;
  question: string;
  inputText: string;
  command?: string | null;
  error: string;
  providerError?: string | null;
}): SummaryDeferredArtifact {
  plannerFailedArtifactByRequestId.add(options.requestId);
  return {
    artifactType: 'planner_failed',
    artifactRequestId: options.requestId,
    artifactPayload: {
      requestId: options.requestId,
      command: options.command ?? null,
      question: options.question,
      inputText: options.inputText,
      error: options.error,
      providerError: options.providerError ?? options.error,
      plannerDebugPath: buildDeferredPlannerDebugPath(options.requestId),
    },
  };
}

export async function writeFailedRequestDump(options: {
  requestId: string;
  question: string;
  inputText: string;
  command?: string | null;
  error: string;
  providerError?: string | null;
}): Promise<void> {
  void buildFailedRequestArtifact(options);
}

export function buildSummaryRequestArtifact(options: {
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
}): SummaryDeferredArtifact {
  return {
    artifactType: 'summary_request',
    artifactRequestId: options.requestId,
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
      plannerDebugPath: buildDeferredPlannerDebugPath(options.requestId),
      failedRequestPath: plannerFailedArtifactByRequestId.has(options.requestId) ? getPlannerFailedPath(options.requestId) : null,
    },
  };
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
  void buildSummaryRequestArtifact(options);
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
