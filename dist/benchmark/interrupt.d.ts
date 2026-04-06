export declare function createInterruptSignal(): {
    interrupted: Promise<never>;
    dispose: () => void;
};
export declare function createFixtureHeartbeat(options: {
    fixtureLabel: string;
    fixtureIndex: number;
    fixtureCount: number;
    startedAtMs: number;
}): NodeJS.Timeout;
export declare function runWithFixtureDeadline<T>(operation: Promise<T>, options: {
    fixtureLabel: string;
    requestTimeoutSeconds: number;
    interrupted: Promise<never>;
}): Promise<T>;
export declare function isTimeoutError(error: unknown): boolean;
