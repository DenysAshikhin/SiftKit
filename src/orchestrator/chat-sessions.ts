import { basename, extname } from 'node:path';

import type { OrchestratorStartRequest } from '@siftkit/contracts';

import type { SiftConfig } from '../config/types.ts';
import { linkChatSessionToOrchestratorRun, saveChatSessionMetadata, sessionShowingOrchestratorRun } from '../state/chat-sessions.ts';
import { buildNewChatSession } from '../status-server/new-chat-session.ts';
import { getRuntimeRoot } from '../status-server/paths.ts';
import type { ServerContext } from '../status-server/server-types.ts';

/** How long a sidebar title may be; the task's first line says what the run is for. */
const SESSION_TITLE_MAX_LENGTH = 72;

function sessionTitle(request: OrchestratorStartRequest): string {
  const task = request.task?.split('\n')[0]?.trim() ?? '';
  if (task !== '') return task.length > SESSION_TITLE_MAX_LENGTH ? `${task.slice(0, SESSION_TITLE_MAX_LENGTH - 1)}…` : task;
  const plan = request.planPath === null ? '' : basename(request.planPath, extname(request.planPath)).trim();
  return plan === '' ? 'Orchestrator run' : plan;
}

/**
 * Points the run's session at it: the session the start named, else the one a replay of this
 * submission already made, else a new session (a CLI start) titled after the work in the run's repo.
 */
export function showRunInChatSession(
  ctx: ServerContext, config: SiftConfig, modelConfig: SiftConfig, request: OrchestratorStartRequest, runId: string,
): void {
  const sessionId = request.sessionId ?? sessionShowingOrchestratorRun(ctx.runtimeDatabase, runId)
    ?? createRunSession(config, modelConfig, request);
  linkChatSessionToOrchestratorRun(ctx.runtimeDatabase, sessionId, runId);
}

function createRunSession(config: SiftConfig, modelConfig: SiftConfig, request: OrchestratorStartRequest): string {
  const session = buildNewChatSession(config, modelConfig, request.presetId, sessionTitle(request), request.repoRoot);
  saveChatSessionMetadata(getRuntimeRoot(), session);
  return session.id;
}
