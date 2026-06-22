import http from 'node:http';
import path from 'node:path';

import { z } from '../../src/lib/zod.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import type { JsonValue } from '../../src/lib/json-types.js';
import { getRuntimeRootFromStatusPath } from './runtime-config.js';

// The status-server posts these locator fields on every artifact write; a parsed
// JSON body (JsonObject) is structurally assignable here without a cast.
export type ArtifactLogSource = {
  statusPath?: JsonValue;
  artifactType?: JsonValue;
  artifactRequestId?: JsonValue;
};

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

export function resolveArtifactLogPathFromStatusPost(parsedBody: ArtifactLogSource | null): string | null {
  if (!parsedBody) {
    return null;
  }

  const artifactType = typeof parsedBody.artifactType === 'string'
    ? parsedBody.artifactType.trim()
    : '';
  const artifactRequestId = typeof parsedBody.artifactRequestId === 'string'
    ? parsedBody.artifactRequestId.trim()
    : '';
  if (!artifactType || !artifactRequestId) {
    return null;
  }

  const statusPath = typeof parsedBody.statusPath === 'string' && parsedBody.statusPath.trim()
    ? parsedBody.statusPath
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

export function requestJson<T = JsonValue>(url: string, options: RequestJsonOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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

          const parsedBody = responseText ? parseJsonValueText(responseText) : {};
          resolve(z.custom<T>((value) => value !== undefined).parse(parsedBody));
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
