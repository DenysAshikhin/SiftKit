import { type ChatSession } from '../state/chat-sessions.js';
type Dict = Record<string, unknown>;
export declare function buildContextUsage(session: ChatSession): Dict;
export declare function resolveActiveChatModel(config: Dict | null | undefined, session: ChatSession): string;
export type ChatCompletionRequest = {
    url: string;
    model: string;
    body: Dict;
};
type BuildChatOptions = {
    thinkingEnabled?: boolean;
    stream?: boolean;
};
export declare function buildChatCompletionRequest(config: Dict, session: ChatSession, userContent: string, options?: BuildChatOptions): ChatCompletionRequest;
export type ChatUsage = {
    promptTokens: number | null;
    completionTokens: number | null;
    thinkingTokens: number | null;
    promptCacheTokens: number | null;
    promptEvalTokens: number | null;
};
export declare function generateChatAssistantMessage(config: Dict, session: ChatSession, userContent: string): Promise<{
    assistantContent: string;
    thinkingContent: string;
    usage: ChatUsage;
}>;
type AppendChatOptions = {
    toolContextContents?: string[];
};
export declare function appendChatMessagesWithUsage(runtimeRoot: string, session: ChatSession, content: string, assistantContent: string, usage?: Partial<ChatUsage>, thinkingContent?: string, options?: AppendChatOptions): ChatSession;
export type StreamProgress = {
    assistantContent: string;
    thinkingContent: string;
};
type StreamResult = {
    assistantContent: string;
    thinkingContent: string;
    usage: ChatUsage;
};
export declare function streamChatAssistantMessage(config: Dict, session: ChatSession, userContent: string, onProgress: ((progress: StreamProgress) => void) | null): Promise<StreamResult>;
export declare function condenseChatSession(runtimeRoot: string, session: ChatSession): ChatSession;
export declare function buildPlanRequestPrompt(userPrompt: unknown): string;
export declare function buildPlanMarkdownFromRepoSearch(userPrompt: string, repoRoot: string, result: Dict | null | undefined): string;
export declare function getScorecardTotal(scorecard: unknown, key: string): number | null;
export declare function buildToolContextFromRepoSearchResult(result: Dict | null | undefined): string[];
export declare function buildRepoSearchMarkdown(userPrompt: string, repoRoot: string, result: Dict | null | undefined): string;
export type RepoSearchExecuteFn = (request: Dict) => Promise<Dict>;
export declare function loadRepoSearchExecutor(): RepoSearchExecuteFn;
export {};
