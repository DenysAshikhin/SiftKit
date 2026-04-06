import type { StructuredModelDecision, SummaryPhase } from './types.js';
export declare function toMockDecision(decision: StructuredModelDecision): string;
export declare function buildMockDecision(prompt: string, question: string, phase: SummaryPhase): StructuredModelDecision;
export declare function getMockSummary(prompt: string, question: string, phase: SummaryPhase): string;
