import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseJsonText } from './json.js';

export function ensureDirectory(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function writeUtf8NoBom(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf8' });
}

export function isRetryableFsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? String(error.code ?? '') : '';
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

export function saveContentAtomically(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  ensureDirectory(directory);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tempPath = path.join(
      directory,
      `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`
    );

    try {
      writeUtf8NoBom(tempPath, content);
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Ignore temp cleanup failures during retry handling.
      }

      if (!isRetryableFsError(error) || attempt === 4) {
        break;
      }
    }
  }

  if (isRetryableFsError(lastError)) {
    writeUtf8NoBom(filePath, content);
    return;
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to save ${filePath} atomically.`);
}

export function readJsonFile<T>(filePath: string): T {
  return parseJsonText<T>(fs.readFileSync(filePath, 'utf8'));
}

export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readTextIfExists(targetPath: string): string | null {
  if (!fs.existsSync(targetPath)) {
    return null;
  }
  return fs.readFileSync(targetPath, 'utf8');
}

export function readTrimmedFileText(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf8').trim();
}

export function listFiles(targetPath: string): string[] {
  if (!fs.existsSync(targetPath)) {
    return [];
  }
  return fs
    .readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(targetPath, entry.name));
}

export function writeText(targetPath: string, content: string): void {
  ensureDirectory(path.dirname(targetPath));
  fs.writeFileSync(targetPath, content, 'utf8');
}

export function safeReadJson(targetPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8')) as Record<string, unknown>;
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

// sleep() has moved to lib/time.ts — import from there instead.
export { sleep } from './time.js';
