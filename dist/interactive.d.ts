import type { SummaryClassification } from './summary/types.js';
export type InteractiveCaptureRequest = {
    Command: string;
    ArgumentList?: string[];
    Question?: string;
    Format?: 'text' | 'json';
    Backend?: string;
    Model?: string;
    PolicyProfile?: 'general' | 'pass-fail' | 'unique-errors' | 'buried-critical' | 'json-extraction' | 'diff-summary' | 'risky-operation';
};
export type InteractiveCaptureResult = {
    ExitCode: number;
    TranscriptPath: string;
    WasSummarized: boolean;
    RawReviewRequired: boolean;
    OutputText: string;
    Summary: string;
    Classification: SummaryClassification;
    PolicyDecision: string;
};
export declare function runInteractiveCapture(request: InteractiveCaptureRequest): Promise<InteractiveCaptureResult>;
