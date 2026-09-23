import {
  OrchestratorDecideRequestSchema,
  OrchestratorProgressSchema,
  OrchestratorRunListSchema,
  OrchestratorRunStateSchema,
  OrchestratorStartRequestSchema,
  type OrchestratorDecideRequest,
  type OrchestratorProgress,
  type OrchestratorRunState,
  type OrchestratorStartRequest,
} from '@siftkit/contracts';
import { parseJsonText } from '../../src/lib/json.js';
import { SseFrameParser } from '../../src/lib/sse-frame-parser.js';
import { parseJsonResponse } from './api.js';

function postJson(url: string, body: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, ...(signal ? { signal } : {}) });
}

export async function startOrchestrator(request: OrchestratorStartRequest): Promise<OrchestratorRunState> {
  return parseJsonResponse(await postJson('/orchestrator', JSON.stringify(OrchestratorStartRequestSchema.parse(request))), OrchestratorRunStateSchema);
}

export async function listOrchestratorRuns(repoRoot: string): Promise<OrchestratorRunState[]> {
  const response = await fetch(`/orchestrator/runs?repoRoot=${encodeURIComponent(repoRoot)}`);
  return (await parseJsonResponse(response, OrchestratorRunListSchema)).runs;
}

export async function decideOrchestrator(request: OrchestratorDecideRequest): Promise<OrchestratorRunState> {
  return parseJsonResponse(await postJson('/orchestrator/decide', JSON.stringify(OrchestratorDecideRequestSchema.parse(request))), OrchestratorRunStateSchema);
}

export async function abortOrchestrator(runId: string): Promise<OrchestratorRunState> {
  return parseJsonResponse(await postJson('/orchestrator/abort', JSON.stringify({ runId })), OrchestratorRunStateSchema);
}

/** Replays committed progress after the cursor, then follows live progress; returns the state that ended the stream. */
export async function* followOrchestrator(
  runId: string,
  afterSequence: number,
  signal: AbortSignal,
): AsyncGenerator<OrchestratorProgress, OrchestratorRunState> {
  const response = await postJson('/orchestrator/events', JSON.stringify({ runId, afterSequence }), signal);
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  if (!response.body) throw new Error('Orchestrator event stream body was empty.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('Orchestrator event stream ended without a result.');
    for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
      // The events route writes only progress and a closing result; anything else is a protocol break.
      if (frame.event === 'progress') {
        yield parseJsonText(frame.data, OrchestratorProgressSchema);
        continue;
      }
      if (frame.event !== 'result') throw new Error(`Unexpected orchestrator stream frame: ${frame.event}`);
      await reader.cancel();
      return parseJsonText(frame.data, OrchestratorRunStateSchema);
    }
  }
}
