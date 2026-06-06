import type { Dict } from '../lib/types.js';
export type ChatMessage = Dict;
export type ChatSession = Dict & {
    id: string;
    messages?: ChatMessage[];
};
export declare function estimateTokenCount(value: unknown): number;
export declare function getChatSessionsRoot(runtimeRoot: string): string;
export declare function listChatSessionPaths(runtimeRoot: string): string[];
export declare function readChatSessionFromPath(targetPath: string): ChatSession | null;
export declare function readChatSessions(runtimeRoot: string): ChatSession[];
export declare function getChatSessionPath(runtimeRoot: string, sessionId: string): string;
export declare function deleteChatSession(runtimeRoot: string, sessionId: string): boolean;
export declare function deleteChatMessage(runtimeRoot: string, sessionId: string, messageId: string): {
    session: ChatSession;
    deletedMessage: ChatMessage;
} | null;
export declare function saveChatSession(runtimeRoot: string, session: ChatSession): void;
