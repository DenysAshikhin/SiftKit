export declare function getExecutionServiceUrl(): string;
export declare function getExecutionServerState(): Promise<{
    busy: boolean;
}>;
export declare function tryAcquireExecutionLease(): Promise<{
    acquired: boolean;
    token: string | null;
}>;
export declare function refreshExecutionLease(token: string): Promise<void>;
export declare function releaseExecutionLease(token: string): Promise<void>;
