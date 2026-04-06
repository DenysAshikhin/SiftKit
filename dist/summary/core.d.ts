import type { SummaryRequest, SummaryResult } from './types.js';
export declare function summarizeRequest(request: SummaryRequest): Promise<SummaryResult>;
export declare function readSummaryInput(options: {
    text?: string;
    file?: string;
    stdinText?: string;
}): string | null;
