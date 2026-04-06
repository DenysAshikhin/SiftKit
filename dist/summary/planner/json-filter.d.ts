export declare const MAX_JSON_FALLBACK_PREVIEW_CHARACTERS = 200;
export declare function getRecord(value: unknown): Record<string, unknown> | null;
export declare function getFiniteInteger(value: unknown): number | null;
export declare function getValueByPath(value: unknown, pathText: string): unknown;
export declare function setValueByPath(target: Record<string, unknown>, pathText: string, value: unknown): void;
export declare function normalizeJsonFilterFilters(filters: Record<string, unknown>[]): Record<string, unknown>[];
export declare function compareJsonFilterOrdered(actual: unknown, expected: unknown, op: 'gt' | 'gte' | 'lt' | 'lte'): boolean;
export declare function matchesJsonFilter(item: unknown, filter: Record<string, unknown>): boolean;
export declare function projectJsonFilterItem(item: unknown, select: string[] | null): unknown;
export declare function toJsonFallbackPreview(text: string): string;
export declare function findBalancedJsonEndIndex(inputText: string, startIndex: number): number;
export declare function parseJsonForJsonFilter(inputText: string): {
    parsed: unknown;
    usedFallback: boolean;
    ignoredPrefixPreview: string | null;
    parsedSectionPreview: string | null;
};
