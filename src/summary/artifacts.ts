import { appendFileSync } from 'node:fs';
import { createTracer } from '../lib/trace.js';
import type { InferenceBackendId } from '../config/types.js';
import type { JsonObject } from '../lib/json-types.js';
import { getStatusArtifactUri, type DeferredArtifact } from '../state/status-artifacts.js';
import { getRecord } from './planner/json-filter.js';
import type {
  SummaryClassification,
  SummaryFailureContext,
  SummaryProviderId,
  SummarySourceKind,
} from './types.js';

// ---------- failure context ---------- //

// Failure context rides alongside the thrown Error in a WeakMap keyed by the
// Error identity, so the error stays a plain Error with no bolted-on field and
// no cast is needed to read the context back out.
const failureContextByError = new WeakMap<Error, SummaryFailureContext>();

export function getSummaryFailureContext(error: Error): SummaryFailureContext | null {
  return failureContextByError.get(error) ?? null;
}

export function attachSummaryFailureContext(
  error: Error,
  context: SummaryFailureContext
): Error {
  if (!failureContextByError.has(error)) {
    failureContextByError.set(error, context);
  }
  return error;
}

// ---------- planner debug dump (in-memory, request-scoped) ---------- //

const plannerDebugPayloadByRequestId = new Map<string, JsonObject>();
const plannerDebugEventsByRequestId = new Map<string, JsonObject[]>();
const plannerFailedArtifactByRequestId = new Set<string>();

export function readPlannerDebugPayload(requestId: string): JsonObject {
  const payload = plannerDebugPayloadByRequestId.get(requestId);
  if (!payload) {
    return {};
  }
  return { ...payload, events: plannerDebugEventsByRequestId.get(requestId) ?? [] };
}

export function updatePlannerDebugDump(
  requestId: string,
  update: (payload: JsonObject) => JsonObject,
): void {
  const payload = plannerDebugPayloadByRequestId.get(requestId) ?? {};
  plannerDebugPayloadByRequestId.set(requestId, update(payload));
}

export function createPlannerDebugRecorder(options: {
  requestId: string;
  question: string;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  commandText?: string | null;
}): {
  record: (event: JsonObject) => void;
  finish: (result: JsonObject) => void;
} {
  plannerDebugPayloadByRequestId.set(options.requestId, {
    requestId: options.requestId,
    command: options.commandText ?? null,
    question: options.question,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode ?? null,
    final: null,
  });
  plannerDebugEventsByRequestId.set(options.requestId, []);
  return {
    record(event) {
      plannerDebugEventsByRequestId.get(options.requestId)?.push(event);
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
}): DeferredArtifact | null {
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

export function buildPlannerDebugReference(requestId: string): string | null {
  return plannerDebugPayloadByRequestId.has(requestId)
    ? getStatusArtifactUri('planner_debug', requestId)
    : null;
}

export function buildPlannerFailureErrorMessage(options: {
  requestId: string;
  reason?: string | null;
}): string {
  const debugPath = buildPlannerDebugReference(options.requestId);
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
}): DeferredArtifact {
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
      plannerDebugPath: buildPlannerDebugReference(options.requestId),
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
  provider: SummaryProviderId;
  backend: InferenceBackendId | null;
  model: string;
  classification?: SummaryClassification | null;
  rawReviewRequired?: boolean | null;
  summary?: string | null;
  providerError?: string | null;
  error?: string | null;
  requestDurationMs?: number | null;
  providerDurationMs?: number | null;
  wallDurationMs?: number | null;
}): DeferredArtifact {
  return {
    artifactType: 'summary_request',
    artifactRequestId: options.requestId,
    artifactPayload: {
      requestId: options.requestId,
      command: options.command ?? null,
      question: options.question,
      inputText: options.inputText,
      provider: options.provider,
      backend: options.backend,
      model: options.model,
      classification: options.classification ?? null,
      ...(options.rawReviewRequired ? { rawReviewRequired: true } : {}),
      summary: options.summary ?? null,
      providerError: options.providerError ?? null,
      error: options.error ?? null,
      requestDurationMs: options.requestDurationMs ?? null,
      providerDurationMs: options.providerDurationMs ?? null,
      wallDurationMs: options.wallDurationMs ?? null,
      plannerDebugPath: buildPlannerDebugReference(options.requestId),
      failedRequestPath: plannerFailedArtifactByRequestId.has(options.requestId)
        ? getStatusArtifactUri('planner_failed', options.requestId)
        : null,
    },
  };
}

export async function writeSummaryRequestDump(options: {
  requestId: string;
  question: string;
  inputText: string;
  command?: string | null;
  provider: SummaryProviderId;
  backend: InferenceBackendId | null;
  model: string;
  classification?: SummaryClassification | null;
  rawReviewRequired?: boolean | null;
  summary?: string | null;
  providerError?: string | null;
  error?: string | null;
}): Promise<void> {
  void buildSummaryRequestArtifact(options);
}

export function appendTestProviderEvent(event: JsonObject): void {
  const logPath = process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
  if (!logPath || !logPath.trim()) {
    return;
  }

  appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
}

export function clearSummaryArtifactState(requestId: string): void {
  plannerDebugPayloadByRequestId.delete(requestId);
  plannerDebugEventsByRequestId.delete(requestId);
  plannerFailedArtifactByRequestId.delete(requestId);
}

export const traceSummary = createTracer('SIFTKIT_TRACE_SUMMARY', 'summary');
