import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from './zod.js';
import { JsonObjectSchema, type JsonObject, type JsonValue } from './json-types.js';
import { parseJsonObjectText, parseJsonText } from './json.js';

export function ensureDirectory(dirPath: string): string {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function writeUtf8NoBom(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf8' });
}

export function isRetryableFsError(error: Error | null): boolean {
  const code = error && 'code' in error ? String(error.code ?? '') : '';
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

export function saveContentAtomically(filePath: string, content: string): void {
  const directory = dirname(filePath);
  ensureDirectory(directory);
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tempPath = join(
      directory,
      `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`
    );

    try {
      writeUtf8NoBom(tempPath, content);
      renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Ignore temp cleanup failures during retry handling.
      }

      if (!isRetryableFsError(lastError) || attempt === 4) {
        break;
      }
    }
  }

  if (isRetryableFsError(lastError)) {
    writeUtf8NoBom(filePath, content);
    return;
  }

  throw lastError ?? new Error(`Failed to save ${filePath} atomically.`);
}

/**
 * Async twin of `saveContentAtomically`. Writes to a temp file in the same
 * directory and renames it into place, so a process killed mid-write can never
 * leave a truncated target. Retries the Windows-only sharing-violation codes.
 */
export async function saveContentAtomicallyAsync(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tempPath = join(
      directory,
      `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`
    );

    try {
      await writeFile(tempPath, content, { encoding: 'utf8' });
      await rename(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await rm(tempPath, { force: true }).catch(() => undefined);

      if (!isRetryableFsError(lastError) || attempt === 4) {
        break;
      }
    }
  }

  if (isRetryableFsError(lastError)) {
    await writeFile(filePath, content, { encoding: 'utf8' });
    return;
  }

  throw lastError ?? new Error(`Failed to save ${filePath} atomically.`);
}

export function readJsonObjectFile(filePath: string): JsonObject {
  return parseJsonObjectText(readFileSync(filePath, 'utf8'));
}

export function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): T {
  return parseJsonText<T>(readFileSync(filePath, 'utf8'), schema);
}

export function writeJsonFile(filePath: string, value: JsonValue): void {
  ensureDirectory(dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readTextIfExists(targetPath: string): string | null {
  if (!existsSync(targetPath)) {
    return null;
  }
  return readFileSync(targetPath, 'utf8');
}

export function readTrimmedFileText(filePath: string): string {
  if (!existsSync(filePath)) {
    return '';
  }
  return readFileSync(filePath, 'utf8').trim();
}

export function writeText(targetPath: string, content: string): void {
  ensureDirectory(dirname(targetPath));
  writeFileSync(targetPath, content, 'utf8');
}

export function safeReadJson(targetPath: string): JsonObject | null {
  try {
    const parsed = JsonObjectSchema.safeParse(JSON.parse(readFileSync(targetPath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// sleep() has moved to lib/time.ts — import from there instead.
export { sleep } from './time.js';
