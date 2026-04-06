import * as http from 'node:http';
type Dict = Record<string, unknown>;
export type TextResponse = {
    statusCode: number;
    body: string;
};
export type JsonResponse = {
    statusCode: number;
    body: unknown;
    rawText: string;
};
export type RequestJsonOptions = {
    method?: string;
    timeoutMs?: number;
    body?: string;
};
export declare function requestText(url: string, timeoutMs: number): Promise<TextResponse>;
export declare function requestJson(url: string, options?: RequestJsonOptions): Promise<JsonResponse>;
export declare function readBody(req: http.IncomingMessage): Promise<string>;
export declare function sleep(milliseconds: number): Promise<void>;
export declare function parseJsonBody(bodyText: string): Dict;
export declare function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void;
export declare function ensureDirectory(targetPath: string): void;
export declare function writeText(targetPath: string, content: string): void;
export declare function readTextIfExists(targetPath: string | null | undefined): string;
export declare function listFiles(targetPath: string): string[];
export declare function saveContentAtomically(targetPath: string, content: string): void;
export declare function safeReadJson(targetPath: string): Dict | null;
export declare function getIsoDateFromStat(targetPath: string): string;
export {};
