import type { LlamaCppChatMessage } from '../../providers/llama-cpp.js';
import type { PlannerToolCall, PlannerToolDefinition, SummarySourceKind } from '../types.js';
import { MAX_JSON_FALLBACK_PREVIEW_CHARACTERS } from './json-filter.js';
export { MAX_JSON_FALLBACK_PREVIEW_CHARACTERS };
export declare function buildPlannerDocumentProfile(inputText: string): string;
export declare function buildPlannerSystemPrompt(options: {
    promptPrefix?: string;
    sourceKind: SummarySourceKind;
    commandExitCode?: number | null;
    rawReviewRequired: boolean;
    toolDefinitions: PlannerToolDefinition[];
}): string;
export declare function buildPlannerInitialUserPrompt(options: {
    question: string;
    inputText: string;
}): string;
export declare function buildPlannerInvalidResponseUserPrompt(message: string): string;
export declare function renderPlannerTranscript(messages: LlamaCppChatMessage[]): string;
export declare function buildPlannerAssistantToolMessage(action: PlannerToolCall, toolCallId: string): LlamaCppChatMessage;
