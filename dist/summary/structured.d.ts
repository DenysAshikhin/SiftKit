import type { ChunkPromptContext, StructuredModelDecision, SummaryPhase, SummarySourceKind } from './types.js';
export declare function stripCodeFence(text: string): string;
export declare function decodeStructuredOutputText(text: string): string;
export declare function tryRecoverStructuredModelDecision(text: string): StructuredModelDecision | null;
export declare function parseStructuredModelDecision(text: string): StructuredModelDecision;
export declare function ensureRawReviewSentence(decision: StructuredModelDecision, format: 'text' | 'json'): StructuredModelDecision;
export declare function normalizeStructuredDecision(decision: StructuredModelDecision, format: 'text' | 'json'): StructuredModelDecision;
export declare function buildConservativeChunkFallbackDecision(options: {
    inputText: string;
    question: string;
    format: 'text' | 'json';
}): StructuredModelDecision;
export declare function buildConservativeDirectFallbackDecision(options: {
    inputText: string;
    question: string;
    format: 'text' | 'json';
    sourceKind: SummarySourceKind;
}): StructuredModelDecision;
export declare function isInternalChunkLeaf(options: {
    phase?: SummaryPhase;
    chunkContext?: ChunkPromptContext;
}): boolean;
