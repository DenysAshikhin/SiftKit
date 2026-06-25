import { readdirSync } from 'node:fs';
import { join, resolve, basename, relative } from 'node:path';

export type FindFilesResult = {
  Name: string;
  RelativePath: string;
  FullPath: string;
};

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  const regexBody = escaped.replace(/\*/gu, '.*').replace(/\?/gu, '.');
  return new RegExp(`^${regexBody}$`, 'i');
}

function walkFiles(rootPath: string, results: string[]): void {
  const entries = readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, results);
      continue;
    }

    if (entry.isFile()) {
      results.push(fullPath);
    }
  }
}

export function findFiles(names: string[], searchPath = '.'): FindFilesResult[] {
  const resolvedPath = resolve(searchPath);
  const patterns = names.map((name) => wildcardToRegex(name));
  const files: string[] = [];
  walkFiles(resolvedPath, files);

  return files
    .filter((filePath) => patterns.some((pattern) => pattern.test(basename(filePath))))
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => ({
      Name: basename(filePath),
      RelativePath: relative(resolvedPath, filePath),
      FullPath: filePath,
    }));
}
