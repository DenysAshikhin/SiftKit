export declare class StatusServerUnavailableError extends Error {
    healthUrl: string;
    constructor(healthUrl: string);
}
export declare class MissingObservedBudgetError extends Error {
    constructor(message?: string);
}
