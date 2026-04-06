export declare const MAX_PLANNER_TOOL_RESULT_CHARACTERS = 12000;
export declare function truncatePlannerText(text: string): string;
export declare function formatNumberedLineBlock(lines: string[], startLine: number): string;
export declare function formatCompactJsonBlock(values: unknown[]): string;
export declare function formatPlannerToolResultHeader(value: Record<string, unknown>): string | null;
export declare function formatPlannerResult(value: unknown): string;
export declare function formatPlannerToolResultTokenGuardError(resultTokens: number): string;
