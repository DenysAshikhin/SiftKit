import http from 'node:http';

/**
 * The agent every test-side HTTP client must use.
 *
 * `http.globalAgent` has `keepAlive: true`, so a completed request leaves its socket pooled for
 * reuse. A server drops that socket once its own `keepAliveTimeout` (5s) elapses, and a test
 * that pauses longer than that between two requests to the same origin — waiting on a managed
 * backend to finish starting, say — reuses a connection the server has already closed and fails
 * with `read ECONNRESET`. Under load the pause grows and the failure appears at random.
 *
 * Not pooling at all removes the race outright: tests make far too few requests for connection
 * reuse to be worth a flake.
 */
export const testHttpAgent = new http.Agent({ keepAlive: false });
