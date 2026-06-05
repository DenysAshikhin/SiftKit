import * as http from 'node:http';
import * as https from 'node:https';
import {
  requestJson as requestJsonHttp,
  requestJsonFull as requestJsonFullHttp,
  requestText as requestTextHttp,
  type FullJsonResponse,
  type HttpMethod,
  type TextResponse,
} from './http.js';

/**
 * The single transport for all SiftKit <-> llama.cpp communication.
 *
 * llama.cpp closes idle keep-alive sockets after each response. Node's global
 * agent pools sockets (keepAlive defaults to true on Node >= 19), so a second
 * back-to-back request reuses the just-closed socket and fails immediately with
 * `read ECONNRESET`, in strict alternation. Every llama call therefore goes
 * through these pooling-disabled agents — one fresh socket per request, closed
 * on completion — and never through `http.globalAgent`.
 */
const httpAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: Infinity });

export type LlamaRequestJsonOptions = {
  url: string;
  method: HttpMethod;
  timeoutMs?: number;
  body?: string;
  abortSignal?: AbortSignal;
};

export type LlamaRequestTextOptions = {
  url: string;
  timeoutMs: number;
};

export type LlamaStreamOptions = {
  url: string;
  body: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type LlamaStreamResult = { sawDone: boolean };

export type LlamaStreamPacket = Record<string, unknown>;

/** Returning `'stop'` from a packet handler ends the stream and resolves. */
export type LlamaStreamSignal = 'stop' | void;

/** HTTP error from a streamed llama.cpp call, carrying the upstream status/body. */
export class LlamaHttpError extends Error {
  public readonly statusCode: number;
  public readonly rawText: string;

  constructor(statusCode: number, rawText: string) {
    super(`llama.cpp stream failed with HTTP ${statusCode}${rawText.trim() ? `: ${rawText.trim()}` : '.'}`);
    this.name = 'LlamaHttpError';
    this.statusCode = statusCode;
    this.rawText = rawText;
  }
}

export class LlamaClient {
  static agentFor(target: URL): http.Agent | https.Agent {
    return target.protocol === 'https:' ? httpsAgent : httpAgent;
  }

  static requestJsonFull<T>(options: LlamaRequestJsonOptions): Promise<FullJsonResponse<T>> {
    return requestJsonFullHttp<T>({ ...options, agent: LlamaClient.agentFor(new URL(options.url)) });
  }

  static requestJson<T>(options: LlamaRequestJsonOptions): Promise<T> {
    return requestJsonHttp<T>({ ...options, agent: LlamaClient.agentFor(new URL(options.url)) });
  }

  static requestText(options: LlamaRequestTextOptions): Promise<TextResponse> {
    return requestTextHttp({ ...options, agent: LlamaClient.agentFor(new URL(options.url)) });
  }

  /**
   * Issues a streamed (SSE) chat completion. Splits `data:` packets, parses each
   * JSON payload and hands it to `onData`; `[DONE]` and malformed packets are
   * swallowed. `onData` may return `'stop'` to end the stream early and resolve
   * with what it accumulated (e.g. runaway-output guards). Resolves on stream
   * end or early stop. Rejects with the abort reason if `abortSignal` fires,
   * with {@link LlamaHttpError} on HTTP >= 400, and with the socket error on an
   * upstream reset before completion.
   */
  static streamChatCompletion(
    options: LlamaStreamOptions,
    onData: (packet: LlamaStreamPacket) => LlamaStreamSignal,
  ): Promise<LlamaStreamResult> {
    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise<LlamaStreamResult>((resolve, reject) => {
      let settled = false;
      let sawDone = false;
      let stoppedEarly = false;
      const settleResolve = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        options.abortSignal?.removeEventListener('abort', abortRequest);
        resolve({ sawDone });
      };
      const settleReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        options.abortSignal?.removeEventListener('abort', abortRequest);
        reject(error);
      };
      const getAbortError = (): Error => (
        options.abortSignal?.reason instanceof Error
          ? options.abortSignal.reason
          : new Error(String(options.abortSignal?.reason || 'llama.cpp chat stream aborted.'))
      );
      const handleStreamClose = (error: Error): void => {
        if (stoppedEarly) {
          settleResolve();
          return;
        }
        if (options.abortSignal?.aborted) {
          settleReject(getAbortError());
          return;
        }
        if (sawDone) {
          settleResolve();
          return;
        }
        settleReject(error);
      };

      const request = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        agent: LlamaClient.agentFor(target),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        },
      }, (response) => {
        const statusCode = response.statusCode || 0;
        if (statusCode >= 400) {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => { settleReject(new LlamaHttpError(statusCode, body)); });
          response.on('error', () => { settleReject(new LlamaHttpError(statusCode, body)); });
          return;
        }
        let rawBuffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          rawBuffer += chunk;
          let boundary = rawBuffer.indexOf('\n\n');
          while (boundary >= 0) {
            const packet = rawBuffer.slice(0, boundary);
            rawBuffer = rawBuffer.slice(boundary + 2);
            boundary = rawBuffer.indexOf('\n\n');
            const dataLine = packet
              .split(/\r?\n/gu)
              .map((line) => line.trim())
              .filter(Boolean)
              .find((line) => line.startsWith('data:'));
            if (!dataLine) {
              continue;
            }
            const dataValue = dataLine.slice(5).trim();
            if (dataValue === '[DONE]') {
              sawDone = true;
              continue;
            }
            let parsed: LlamaStreamPacket;
            try {
              parsed = JSON.parse(dataValue) as LlamaStreamPacket;
            } catch {
              continue;
            }
            if (onData(parsed) === 'stop') {
              stoppedEarly = true;
              request.destroy();
              settleResolve();
              return;
            }
          }
        });
        response.on('aborted', () => { handleStreamClose(new Error('llama.cpp chat stream reset before completion.')); });
        response.on('error', (error: Error) => { handleStreamClose(error); });
        response.on('end', settleResolve);
      });

      const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
        ? Math.trunc(Number(options.timeoutMs))
        : 0;
      if (timeoutMs > 0) {
        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error(`llama.cpp chat stream timed out after ${timeoutMs} ms.`));
        });
      }
      const abortRequest = (): void => { request.destroy(getAbortError()); };
      request.on('error', (error: Error) => { handleStreamClose(error); });
      if (options.abortSignal?.aborted) {
        abortRequest();
      } else {
        options.abortSignal?.addEventListener('abort', abortRequest, { once: true });
      }
      request.write(options.body);
      request.end();
    });
  }
}
