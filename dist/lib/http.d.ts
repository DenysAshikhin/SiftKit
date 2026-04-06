export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';
export type RequestJsonOptions = {
    url: string;
    method: HttpMethod;
    timeoutMs: number;
    body?: string;
};
/**
 * Issues an HTTP(S) request and parses the response as JSON. Resolves `{}` for
 * empty bodies. Rejects on HTTP >=400 with the status code and raw body text.
 *
 * Shared primitive used by the CLI, config client, benchmark matrix, and
 * status-backend client — keep in sync with consumers that expect an error to
 * be thrown for non-2xx responses.
 */
export declare function requestJson<T>(options: RequestJsonOptions): Promise<T>;
