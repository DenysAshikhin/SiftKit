import type { SiftConfig } from '../config/index.js';
import type { SummaryClassification, SummaryDecision, SummaryResult, SummarySourceKind } from './types.js';
export declare function getSummaryDecision(text: string, question: string | null | undefined, riskLevel: 'informational' | 'debug' | 'risky', config: SiftConfig, options?: {
    sourceKind?: SummarySourceKind;
    commandExitCode?: number | null;
}): SummaryDecision;
export declare function getPolicyDecision(classification: SummaryClassification): SummaryResult['PolicyDecision'];
