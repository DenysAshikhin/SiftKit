import {
  captureExecutingPlannerRequest,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
  type ChatMessage,
  type ExecutingPlannerRequest,
  type PlannerThinkingFlags,
} from '../../src/repo-search/planner-protocol.js';
import { toProtocolTools } from '../../src/providers/inference.js';

export const THINKING_ON_FLAGS = {
  thinkingEnabled: true,
  reasoningContentEnabled: true,
  preserveThinking: true,
} satisfies PlannerThinkingFlags;

/** A small measured prompt: the fixture exercises verdict wiring, not budget exhaustion. */
const VERDICT_FIXTURE_PROMPT_TOKENS = 1_000;

/** The executing planner snapshot a verdict must extend: serialized transcript, flags, full tool set. */
export function captureExecutingForVerdict(
  messages: ChatMessage[],
  flags: PlannerThinkingFlags = THINKING_ON_FLAGS,
): ExecutingPlannerRequest {
  return captureExecutingPlannerRequest(
    serializeProtocolMessages(messages, flags.reasoningContentEnabled),
    flags,
    toProtocolTools(resolveRepoSearchPlannerToolDefinitions()),
    VERDICT_FIXTURE_PROMPT_TOKENS,
  );
}

/** The transcript-bound half of a verdict request; callers add config, endpoint, and timing. */
export function baseVerdictOptions(transcriptMessages: ChatMessage[], executing: ExecutingPlannerRequest) {
  const pendingMessages: ChatMessage[] = [];
  return { transcriptMessages, pendingMessages, question: 'approve?', executing };
}
