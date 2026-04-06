import type { ChunkPromptContext, SummaryPhase, SummaryPolicyProfile, SummarySourceKind } from './types.js';
export declare const PROMPT_PROFILES: Record<SummaryPolicyProfile, string>;
export declare function getSourceInstructions(sourceKind: SummarySourceKind, commandExitCode: number | null | undefined): string;
export declare function extractPromptSection(prompt: string, header: string): string;
export declare function appendChunkPath(parentPath: string | null | undefined, chunkIndex: number, chunkTotal: number): string;
export declare function buildPrompt(options: {
    question: string;
    inputText: string;
    format: 'text' | 'json';
    policyProfile: SummaryPolicyProfile;
    rawReviewRequired: boolean;
    promptPrefix?: string;
    sourceKind?: SummarySourceKind;
    commandExitCode?: number | null;
    phase?: SummaryPhase;
    chunkContext?: ChunkPromptContext;
    allowUnsupportedInput?: boolean;
}): string;
