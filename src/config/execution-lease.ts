import { httpClient } from '../lib/http-client.js';
import { toError } from '../lib/errors.js';
import { z } from '../lib/zod.js';
import {
  deriveServiceUrl,
  getStatusBackendUrl,
  toStatusServerUnavailableError,
} from './status-backend.js';

const ExecutionStateSchema = z.object({ busy: z.boolean().optional() }).loose();
const ExecutionAcquireSchema = z.object({
  acquired: z.boolean().optional(),
  token: z.string().nullable().optional(),
}).loose();
const ExecutionAckSchema = z.object({ ok: z.boolean().optional() }).loose();
const ExecutionReleaseSchema = z.object({
  ok: z.boolean().optional(),
  released: z.boolean().optional(),
  busy: z.boolean().optional(),
}).loose();

export function getExecutionServiceUrl(): string {
  return deriveServiceUrl(getStatusBackendUrl(), '/execution');
}

export async function getExecutionServerState(): Promise<{ busy: boolean }> {
  const serviceUrl = getExecutionServiceUrl();
  try {
    const response = await httpClient.requestJson({
      url: serviceUrl,
      method: 'GET',
      timeoutMs: 2000,
    }, ExecutionStateSchema);
    if (typeof response?.busy !== 'boolean') {
      throw new Error('Execution endpoint did not return a usable busy flag.');
    }

    return {
      busy: response.busy,
    };
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: toError(error),
      operation: 'execution:get',
      serviceUrl,
    });
  }
}

export async function tryAcquireExecutionLease(): Promise<{ acquired: boolean; token: string | null }> {
  const serviceUrl = `${getExecutionServiceUrl().replace(/\/$/u, '')}/acquire`;
  try {
    const response = await httpClient.requestJson({
      url: serviceUrl,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ pid: process.pid }),
    }, ExecutionAcquireSchema);
    if (typeof response?.acquired !== 'boolean') {
      throw new Error('Execution acquire endpoint did not return a usable acquired flag.');
    }

    return {
      acquired: response.acquired,
      token:
        response.acquired && typeof response.token === 'string' && response.token.trim()
          ? response.token
          : null,
    };
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: toError(error),
      operation: 'execution:acquire',
      serviceUrl,
    });
  }
}

export async function refreshExecutionLease(token: string): Promise<void> {
  const serviceUrl = `${getExecutionServiceUrl().replace(/\/$/u, '')}/heartbeat`;
  try {
    await httpClient.requestJson({
      url: serviceUrl,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ token }),
    }, ExecutionAckSchema);
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: toError(error),
      operation: 'execution:refresh',
      serviceUrl,
    });
  }
}

export async function releaseExecutionLease(token: string): Promise<void> {
  const serviceUrl = `${getExecutionServiceUrl().replace(/\/$/u, '')}/release`;
  try {
    const response = await httpClient.requestJsonFull({
      url: serviceUrl,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ token }),
    }, ExecutionReleaseSchema);
    if (response.statusCode === 409 && response.body?.released === false) {
      return;
    }
    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}: ${response.rawText}`);
    }
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: toError(error),
      operation: 'execution:release',
      serviceUrl,
    });
  }
}
