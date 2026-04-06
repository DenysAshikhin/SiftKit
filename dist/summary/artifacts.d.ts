import type { SummaryClassification, SummaryFailureContext, SummarySourceKind } from './types.js';
export declare function getSummaryFailureContext(error: unknown): SummaryFailureContext | null;
export declare function attachSummaryFailureContext(error: unknown, context: SummaryFailureContext): unknown;
export declare function readPlannerDebugPayload(requestId: string): Record<string, unknown>;
export declare function updatePlannerDebugDump(requestId: string, update: (payload: Record<string, unknown>) => Record<string, unknown>): void;
export declare function createPlannerDebugRecorder(options: {
    requestId: string;
    question: string;
    inputText: string;
    sourceKind: SummarySourceKind;
    commandExitCode?: number | null;
    commandText?: string | null;
}): {
    path: string;
    record: (event: Record<string, unknown>) => void;
    finish: (result: Record<string, unknown>) => void;
};
export declare function finalizePlannerDebugDump(options: {
    requestId: string;
    finalOutput: string;
    classification: SummaryClassification;
    rawReviewRequired: boolean;
    providerError?: string | null;
}): Promise<void>;
export declare function buildPlannerFailureErrorMessage(options: {
    requestId: string;
    reason?: string | null;
}): string;
export declare function writeFailedRequestDump(options: {
    requestId: string;
    question: string;
    inputText: string;
    command?: string | null;
    error: string;
    providerError?: string | null;
}): Promise<void>;
export declare function writeSummaryRequestDump(options: {
    requestId: string;
    question: string;
    inputText: string;
    command?: string | null;
    backend: string;
    model: string;
    classification?: SummaryClassification | null;
    rawReviewRequired?: boolean | null;
    summary?: string | null;
    providerError?: string | null;
    error?: string | null;
}): Promise<void>;
export declare function appendTestProviderEvent(event: Record<string, unknown>): void;
export declare function clearSummaryArtifactState(requestId: string): void;
export declare function traceSummary(message: string): void;
