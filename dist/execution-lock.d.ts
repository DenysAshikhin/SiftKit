export declare function getExecutionLockTimeoutMilliseconds(): number;
export declare function acquireExecutionLock(): Promise<{
    token: string;
}>;
export declare function releaseExecutionLock(lock: {
    token: string;
}): Promise<void> | void;
export declare function withExecutionLock<T>(fn: () => Promise<T> | T): Promise<T>;
