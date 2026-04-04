import { requestJson } from '../lib/http.js';
import {
  deriveServiceUrl,
  getStatusBackendUrl,
  toStatusServerUnavailableError,
} from './status-backend.js';

export function getExecutionServiceUrl(): string {
  return deriveServiceUrl(getStatusBackendUrl(), '/execution');
}

export async function getExecutionServerState(): Promise<{ busy: boolean }> {
  try {
    const response = await requestJson<{ busy?: boolean }>({
      url: getExecutionServiceUrl(),
      method: 'GET',
      timeoutMs: 2000,
    });
    if (typeof response?.busy !== 'boolean') {
      throw new Error('Execution endpoint did not return a usable busy flag.');
    }

    return {
      busy: response.busy,
    };
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export async function tryAcquireExecutionLease(): Promise<{ acquired: boolean; token: string | null }> {
  try {
    const response = await requestJson<{ acquired?: boolean; token?: string | null }>({
      url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/acquire`,
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
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export async function refreshExecutionLease(token: string): Promise<void> {
  try {
    await requestJson({
      url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/heartbeat`,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ token }),
    });
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export async function releaseExecutionLease(token: string): Promise<void> {
  try {
    await requestJson({
      url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/release`,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ token }),
    });
  } catch {
    throw toStatusServerUnavailableError();
  }
}
