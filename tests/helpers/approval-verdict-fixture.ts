import {
  captureExecutingPlannerRequest,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
  type ChatMessage,
  type ExecutingPlannerRequest,
  type PlannerThinkingFlags,
} from '../../src/repo-search/planner-protocol.js';
import { toProtocolTools } from '../../src/providers/llama-cpp.js';

export const THINKING_ON_FLAGS = {
  thinkingEnabled: true,
  reasoningContentEnabled: true,
  preserveThinking: true,
} satisfies PlannerThinkingFlags;

const VERDICT_FIXTURE_SLOT_ID = 2;

/** The executing planner snapshot a verdict must extend: serialized transcript, flags, full tool set. */
export function captureExecutingForVerdict(
  messages: ChatMessage[],
  flags: PlannerThinkingFlags = THINKING_ON_FLAGS,
): ExecutingPlannerRequest {
  return captureExecutingPlannerRequest(
    serializeProtocolMessages(messages, flags.reasoningContentEnabled),
    flags,
    toProtocolTools(resolveRepoSearchPlannerToolDefinitions()),
    VERDICT_FIXTURE_SLOT_ID,
  );
}

/** The transcript-bound half of a verdict request; callers add config, endpoint, and timing. */
export function baseVerdictOptions(transcriptMessages: ChatMessage[], executing: ExecutingPlannerRequest) {
  const pendingMessages: ChatMessage[] = [];
  return { transcriptMessages, pendingMessages, question: 'approve?', executing };
}
