import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { OptionalJsonValue } from '../../lib/json-types.js';
import type { IgnorePolicy } from '../command-safety.js';

export function toPosixPath(value: string): string {
  return value.replace(/\\/gu, '/');
}

export function isRepoRelativePathIgnored(relativePath: string, ignorePolicy: IgnorePolicy): boolean {
  const normalized = toPosixPath(relativePath).replace(/^\.\/+/u, '');
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => ignorePolicy.namesLower.has(segment.toLowerCase()))) return true;
  return ignorePolicy.paths.some((ignoredPath) => (
    normalized === ignoredPath || normalized.startsWith(`${ignoredPath}/`)
  ));
}

function firstExistingAncestor(absolutePath: string): string {
  let current = absolutePath;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function escapesRepoRootViaSymlink(repoRoot: string, absolutePath: string): boolean {
  const realRoot = realpathSync(repoRoot);
  const realTarget = realpathSync(firstExistingAncestor(absolutePath));
  const relativePath = relative(realRoot, realTarget);
  return relativePath.startsWith('..') || isAbsolute(relativePath);
}

export function resolveRepoScopedPath(repoRoot: string, rawPath: OptionalJsonValue): {
  absolutePath: string;
  relativePath: string;
} | null {
  const pathText = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!pathText || isAbsolute(pathText)) return null;
  const absolutePath = resolve(repoRoot, pathText);
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
  if (escapesRepoRootViaSymlink(repoRoot, absolutePath)) return null;
  return { absolutePath, relativePath: toPosixPath(relativePath) };
}
