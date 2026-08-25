import type { IncomingMessage, ServerResponse } from 'node:http';

import { z } from '../../lib/zod.js';
import { MockPlannerResponsesSchema } from '../../planner-protocol/mock-response.js';
import type { JsonObject } from '../../lib/json-types.js';
import { assertPresetAcceptsImages } from '../../llm-protocol/image-attachments.js';
import { normalizeRepoSearchScorecard } from '../repo-search-scorecard-types.js';
import type { ChatMessage, ChatSession } from '../../state/chat-sessions.js';
import {
  ChatMessageImageNotFoundError,
  readChatSessionFromPath,
  updateChatMessageImageCaption,
} from '../../state/chat-sessions.js';
import { getActiveModelPreset } from '../../config/getters.js';
import { readConfig } from '../config-store.js';
import { ChatOperationPresetSelector } from '../chat-operation-preset.js';
import { resolveChatSessionConfig } from '../chat.js';
import { getRuntimeRoot } from '../paths.js';
import { sendJson } from '../http-utils.js';
import {
  ChatSessionOperationEndpoint,
  type ChatSessionOperationRequest,
} from './chat-session-operation-endpoint.js';
import type { ServerContext } from '../server-types.js';
import {
  acquireModelRequestWithWait,
  releaseModelRequest,
} from '../server-ops.js';

const CAPTION_PROMPT = 'Describe this image in two or three sentences. Say what is legible and '
  + 'what is not at this resolution. Do not speculate about anything you cannot see.';

const CaptionRequestSchema = z.object({
  messageId: z.string().min(1),
  imageIndex: z.number().int().nonnegative(),
  mockResponses: MockPlannerResponsesSchema.optional(),
});
type CaptionRequest = z.infer<typeof CaptionRequestSchema>;

type CaptionTarget = {
  message: ChatMessage;
  dataUrl: string;
  caption: string | null;
};

function findCaptionTarget(
  session: ChatSession,
  messageId: string,
  imageIndex: number,
): CaptionTarget | null {
  const message = (session.messages ?? []).find((entry) => entry.id === messageId);
  const dataUrl = message?.images?.[imageIndex];
  const meta = message?.imageMeta?.[imageIndex];
  if (!message || !dataUrl || !meta) {
    return null;
  }
  return { message, dataUrl, caption: meta.caption };
}

/** Runs one independent vision turn and caches its result on the selected message image. */
export class ChatImageCaptionEndpoint extends ChatSessionOperationEndpoint<CaptionRequest> {
  protected readonly operationKind = 'message' as const;
  protected readonly useSessionOperationLease = false;

  protected parseRequest(
    res: ServerResponse,
    _session: ChatSession,
    parsedBody: JsonObject,
  ): CaptionRequest | null {
    const parsed = CaptionRequestSchema.safeParse(parsedBody);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Expected messageId and imageIndex.' });
      return null;
    }
    return parsed.data;
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<CaptionRequest>,
  ): Promise<void> {
    const initialTarget = findCaptionTarget(request.session, request.value.messageId, request.value.imageIndex);
    if (!initialTarget) {
      sendJson(res, 404, { error: 'Image not found.' });
      return;
    }
    if (initialTarget.caption?.trim()) {
      sendJson(res, 200, { caption: initialTarget.caption });
      return;
    }

    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_image_caption', req, res);
    if (!modelRequestLock) {
      return;
    }
    try {
      const authoritativeSession = readChatSessionFromPath(request.sessionPath);
      if (!authoritativeSession) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      const target = findCaptionTarget(authoritativeSession, request.value.messageId, request.value.imageIndex);
      if (!target) {
        sendJson(res, 404, { error: 'Image not found.' });
        return;
      }
      if (target.caption?.trim()) {
        sendJson(res, 200, { caption: target.caption });
        return;
      }

      try {
        const config = readConfig(ctx.configPath);
        const selected = new ChatOperationPresetSelector(config.Presets).select(authoritativeSession, 'chat');
        const effectiveConfig = resolveChatSessionConfig(config, selected.session);
        const activePreset = getActiveModelPreset(effectiveConfig);
        assertPresetAcceptsImages(activePreset, [target.dataUrl]);
        const result = await ctx.engineService.executeRepoSearch({
          presetId: selected.preset.id,
          taskKind: 'chat',
          prompt: CAPTION_PROMPT,
          repoRoot: process.cwd(),
          statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
          config: effectiveConfig,
          systemPrompt: 'Independently assess the supplied image. Return only the requested caption.',
          history: [],
          thinkingEnabled: false,
          allowedTools: [],
          initialUserImages: [target.dataUrl],
          ...(request.value.mockResponses ? { mockResponses: request.value.mockResponses } : {}),
        });
        const task = normalizeRepoSearchScorecard(result.scorecard).tasks[0];
        if (!task) {
          throw new Error('Image caption inference returned no task result.');
        }
        const caption = task.finalOutput.trim();
        if (!caption) {
          throw new Error('Image caption inference returned an empty caption.');
        }
        const latestSession = readChatSessionFromPath(request.sessionPath);
        const latestTarget = latestSession
          ? findCaptionTarget(latestSession, request.value.messageId, request.value.imageIndex)
          : null;
        if (!latestTarget || latestTarget.dataUrl !== target.dataUrl) {
          throw new ChatMessageImageNotFoundError();
        }
        if (latestTarget.caption?.trim()) {
          sendJson(res, 200, { caption: latestTarget.caption });
          return;
        }
        updateChatMessageImageCaption(
          getRuntimeRoot(),
          request.sessionId,
          latestTarget.message.id,
          request.value.imageIndex,
          caption,
        );
        sendJson(res, 200, { caption });
      } catch (error) {
        if (error instanceof ChatMessageImageNotFoundError) {
          sendJson(res, 404, { error: error.message });
          return;
        }
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }
}
