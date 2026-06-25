import { existsSync } from 'node:fs';
import { join, isAbsolute, delimiter, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

export function findCommandInPath(commandName: string): string | null {
  const pathEntries = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' && !extname(commandName)
    ? [commandName, `${commandName}.exe`, `${commandName}.cmd`, `${commandName}.bat`]
    : [commandName];

  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = join(entry, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  if (process.platform === 'win32') {
    const windowsRoot = process.env.WINDIR || 'C:\\Windows';
    const extraCandidates = [
      join(windowsRoot, 'System32', commandName),
      join(windowsRoot, 'System32', `${commandName}.exe`),
      join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', commandName),
      join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', `${commandName}.exe`),
    ];
    for (const candidate of extraCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function resolveExternalCommand(commandName: string): string {
  if (isAbsolute(commandName) || commandName.includes('\\') || commandName.includes('/')) {
    if (existsSync(commandName)) {
      return commandName;
    }
    throw new Error(`Unable to resolve external command: ${commandName}`);
  }

  const direct = spawnSync('where.exe', [commandName], { encoding: 'utf8', shell: false, windowsHide: true });
  if (direct.status === 0 && direct.stdout.trim()) {
    return direct.stdout.split(/\r?\n/u)[0].trim();
  }

  const fallback = findCommandInPath(commandName);
  if (fallback) {
    return fallback;
  }

  throw new Error(`Unable to resolve external command: ${commandName}`);
}
