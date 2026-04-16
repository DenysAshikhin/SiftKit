import http from 'node:http';
import path from 'node:path';

import { getRuntimeRootFromStatusPath } from './runtime-config.ts';

type JsonObject = Record<string, unknown>;

export type RequestJsonOptions = {
  method?: string;
  body?: string;
};

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function resolveArtifactLogPathFromStatusPost(parsedBody: unknown): string | null {
  if (!parsedBody || typeof parsedBody !== 'object') {
    return null;
  }

  const body = parsedBody as JsonObject;
  const artifactType = typeof body.artifactType === 'string'
    ? body.artifactType.trim()
    : '';
  const artifactRequestId = typeof body.artifactRequestId === 'string'
    ? body.artifactRequestId.trim()
    : '';
  if (!artifactType || !artifactRequestId) {
    return null;
  }

  const statusPath = typeof body.statusPath === 'string' && body.statusPath.trim()
    ? body.statusPath
    : (process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH || '');
  if (!statusPath) {
    return null;
  }

  const logsPath = path.join(getRuntimeRootFromStatusPath(statusPath), 'logs');
  if (artifactType === 'summary_request') {
    return path.join(logsPath, 'requests', `request_${artifactRequestId}.json`);
  }
  if (artifactType === 'planner_failed') {
    return path.join(logsPath, 'failed', `request_failed_${artifactRequestId}.json`);
  }
  if (artifactType === 'planner_debug') {
    return path.join(logsPath, `planner_debug_${artifactRequestId}.json`);
  }

  return null;
}

export function requestJson(url: string, options: RequestJsonOptions = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseText += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${responseText}`));
            return;
          }

          resolve(responseText ? JSON.parse(responseText) : {});
        });
      },
    );

    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}
