export type ObservedBudgetState = {
    observedTelemetrySeen: boolean;
    lastKnownCharsPerToken: number | null;
    updatedAtUtc: string | null;
};
export declare function getDefaultObservedBudgetState(): ObservedBudgetState;
export declare function normalizeObservedBudgetState(input: unknown): ObservedBudgetState;
export declare function readObservedBudgetState(): ObservedBudgetState;
export declare function writeObservedBudgetState(state: ObservedBudgetState): void;
export declare function tryWriteObservedBudgetState(state: ObservedBudgetState): void;
