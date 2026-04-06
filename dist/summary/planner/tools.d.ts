import type { PlannerToolCall, PlannerToolDefinition, PlannerToolName } from '../types.js';
import { formatCompactJsonBlock, formatNumberedLineBlock, formatPlannerResult, formatPlannerToolResultHeader, formatPlannerToolResultTokenGuardError, truncatePlannerText } from './formatters.js';
export { formatCompactJsonBlock, formatNumberedLineBlock, formatPlannerResult, formatPlannerToolResultHeader, formatPlannerToolResultTokenGuardError, truncatePlannerText, };
export declare function getPlannerToolName(value: unknown): PlannerToolName | null;
export declare function escapeUnescapedRegexBraces(query: string): string;
export declare function buildPlannerToolDefinitions(): PlannerToolDefinition[];
export declare function executePlannerTool(inputText: string, action: PlannerToolCall): Record<string, unknown>;
