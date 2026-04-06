type Dict = Record<string, unknown>;
export type JsonlEvent = {
    kind: string;
    at: string | null;
    payload: Dict;
};
export declare function readJsonlEvents(transcriptPath: string | null): JsonlEvent[];
export declare function getTranscriptDurationMs(transcriptPath: string | null): number | null;
export {};
