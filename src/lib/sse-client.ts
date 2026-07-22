import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { SseFrameParser, type SseFrame } from './sse-frame-parser.js';

export type SseClientStreamOptions = {
  url: string;
  body: string;
  idleTimeoutMs: number;
};

type StreamItem =
  | { kind: 'frame'; frame: SseFrame }
  | { kind: 'end' }
  | { kind: 'error'; error: Error };

/** Sends a JSON POST and consumes the text/event-stream response. */
export class SseClient {
  async *stream(options: SseClientStreamOptions): AsyncGenerator<SseFrame> {
    const target = new URL(options.url);
    const requestTransport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const items: StreamItem[] = [];
    let wakeUp: (() => void) | null = null;
    const pushItem = (item: StreamItem): void => {
      items.push(item);
      if (wakeUp) {
        const wake = wakeUp;
        wakeUp = null;
        wake();
      }
    };

    const request = requestTransport({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        Accept: 'text/event-stream',
      },
    }, (response) => {
      const statusCode = response.statusCode || 0;
      response.setEncoding('utf8');
      if (statusCode >= 400) {
        let errorBody = '';
        response.on('data', (chunk: string) => { errorBody += chunk; });
        response.on('end', () => pushItem({ kind: 'error', error: new Error(`HTTP ${statusCode}: ${errorBody}`) }));
        response.on('error', () => pushItem({ kind: 'error', error: new Error(`HTTP ${statusCode}: ${errorBody}`) }));
        return;
      }

      const parser = new SseFrameParser();
      response.on('data', (chunk: string) => {
        for (const frame of parser.push(chunk)) {
          pushItem({ kind: 'frame', frame });
        }
      });
      response.on('end', () => pushItem({ kind: 'end' }));
      response.on('error', (error: Error) => pushItem({ kind: 'error', error }));
    });

    request.setTimeout(options.idleTimeoutMs, () => {
      request.destroy(new Error(`Operation stream timed out after ${options.idleTimeoutMs} ms of inactivity.`));
    });
    request.on('error', (error: Error) => pushItem({ kind: 'error', error }));
    request.write(options.body);
    request.end();

    try {
      for (;;) {
        while (items.length === 0) {
          await new Promise<void>((resolve) => { wakeUp = resolve; });
        }
        const item = items.shift();
        if (!item || item.kind === 'end') {
          return;
        }
        if (item.kind === 'error') {
          throw item.error;
        }
        yield item.frame;
      }
    } finally {
      request.destroy();
    }
  }
}
