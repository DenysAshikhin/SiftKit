type Dict = Record<string, unknown>;
export type ChatMessage = Dict;
export type ChatSession = Dict & {
    id: string;
    messages?: ChatMessage[];
    hiddenToolContexts?: Dict[];
};
export declare function estimateTokenCount(value: unknown): number;
export declare function getChatSessionsRoot(runtimeRoot: string): string;
export declare function listChatSessionPaths(runtimeRoot: string): string[];
export declare function readChatSessionFromPath(targetPath: string): ChatSession | null;
export declare function readChatSessions(runtimeRoot: string): ChatSession[];
export declare function getChatSessionPath(runtimeRoot: string, sessionId: string): string;
export declare function saveChatSession(runtimeRoot: string, session: ChatSession): void;
export {};
