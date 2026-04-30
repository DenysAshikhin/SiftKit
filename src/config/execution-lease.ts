import { requestJson, requestJsonFull } from '../lib/http.js';
import {
  deriveServiceUrl,
  getStatusBackendUrl,
  toStatusServerUnavailableError,
} from './status-backend.js';

export function getExecutionServiceUrl(): string {
  return deriveServiceUrl(getStatusBackendUrl(), '/execution');
}

export async function getExecutionServerState(): Promise<{ busy: boolean }> {
  const serviceUrl = getExecutionServiceUrl();
  try {
    const response = await requestJson<{ busy?: boolean }>({
      url: serviceUrl,
      method: 'GET',
      timeoutMs: 2000,
    });
    if (typeof response?.busy !== 'boolean') {
      throw new Error('Execution endpoint did not return a usable busy flag.');
    }

    return {
      busy: response.busy,
    };
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: error,
      operation: 'execution:get',
      serviceUrl,
    });
  }
}

export async function tryAcquireExecutionLease(): Promise<{ acquired: boolean; token: string | null }> {
  const serviceUrl = `${getExecutionServiceUrl().replace(/\/$/u, '')}/acquire`;
  try {
    const response = await requestJson<{ acquired?: boolean; token?: string | null }>({
      url: serviceUrl,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ pid: process.pid }),
    });
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
      cause: error,
      operation: 'execution:acquire',
      serviceUrl,
    });
  }
}

export async function refreshExecutionLease(token: string): Promise<void> {
  const serviceUrl = `${getExecutionServiceUrl().replace(/\/$/u, '')}/heartbeat`;
  try {
    await requestJson({
      url: serviceUrl,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: error,
      operation: 'execution:refresh',
      serviceUrl,
    });
  }
}

export async function releaseExecutionLease(token: string): Promise<void> {
  const serviceUrl = `${getExecutionServiceUrl().replace(/\/$/u, '')}/release`;
  try {
    const response = await requestJsonFull<{ ok?: boolean; released?: boolean; busy?: boolean }>({
      url: serviceUrl,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ token }),
    });
    if (response.statusCode === 409 && response.body?.released === false) {
      return;
    }
    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}: ${response.rawText}`);
    }
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: error,
      operation: 'execution:release',
      serviceUrl,
    });
  }
}
