import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Dict = Record<string, unknown>;

export type TextResponse = { statusCode: number; body: string };
export type JsonResponse = { statusCode: number; body: unknown; rawText: string };
export type RequestJsonOptions = { method?: string; timeoutMs?: number; body?: string };

export function requestText(url: string, timeoutMs: number): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 0,
          body,
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs} ms.`));
    });
    request.on('error', reject);
    request.end();
  });
}

export function requestJson(url: string, options: RequestJsonOptions = {}): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const body = typeof options.body === 'string' ? options.body : '';
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      } : undefined,
    }, (response) => {
      let responseText = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        responseText += chunk;
      });
      response.on('end', () => {
        if (!responseText.trim()) {
          resolve({ statusCode: response.statusCode || 0, body: {}, rawText: '' });
          return;
        }
        try {
          resolve({
            statusCode: response.statusCode || 0,
            body: JSON.parse(responseText),
            rawText: responseText,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(Number(options.timeoutMs || 60000), () => {
      request.destroy(new Error(`Request timed out after ${Number(options.timeoutMs || 60000)} ms.`));
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseJsonBody(bodyText: string): Dict {
  if (!bodyText || !bodyText.trim()) {
    return {};
  }
  return JSON.parse(bodyText) as Dict;
}

export function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function ensureDirectory(targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

export function writeText(targetPath: string, content: string): void {
  ensureDirectory(targetPath);
  fs.writeFileSync(targetPath, content, 'utf8');
}

export function readTextIfExists(targetPath: string | null | undefined): string {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) {
      return '';
    }
    return fs.readFileSync(targetPath, 'utf8');
  } catch {
    return '';
  }
}

export function listFiles(targetPath: string): string[] {
  if (!fs.existsSync(targetPath)) {
    return [];
  }
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(targetPath, entry.name));
}

export function saveContentAtomically(targetPath: string, content: string): void {
  ensureDirectory(targetPath);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tempPath = path.join(
      path.dirname(targetPath),
      `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`
    );
    try {
      fs.writeFileSync(tempPath, content, 'utf8');
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Ignore cleanup failures.
      }
      if (!error || typeof error !== 'object') {
        break;
      }
      const code = String((error as { code?: unknown }).code || '');
      if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || attempt === 4) {
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to save ${targetPath}.`);
}

export function safeReadJson(targetPath: string): Dict | null {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8')) as Dict;
  } catch {
    return null;
  }
}

export function getIsoDateFromStat(targetPath: string): string {
  try {
    return fs.statSync(targetPath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
