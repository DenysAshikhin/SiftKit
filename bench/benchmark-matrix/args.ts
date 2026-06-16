import { defaultManifestPath, type MatrixCliOptions } from './types.js';

export function getRequiredString(value: unknown, name: string): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error(`Manifest field '${name}' is required.`);
  }

  return text;
}

export function getRequiredInt(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Manifest field '${name}' must be an integer.`);
  }

  return parsed;
}

export function getRequiredDouble(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Manifest field '${name}' must be numeric.`);
  }

  return parsed;
}

export function getOptionalInt(value: unknown, name: string): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }

  return getRequiredInt(value, name);
}

export function getOptionalPositiveInt(value: unknown, name: string): number | null {
  const parsed = getOptionalInt(value, name);
  if (parsed === null) {
    return null;
  }
  if (parsed <= 0) {
    throw new Error(`Manifest field '${name}' must be greater than zero.`);
  }

  return parsed;
}

export function getOptionalBoolean(value: unknown, name: string): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Manifest field '${name}' must be boolean.`);
  }

  return value;
}

export function parseArguments(argv: string[]): MatrixCliOptions {
  const parsed: MatrixCliOptions = {
    manifestPath: defaultManifestPath,
    runIds: [],
    promptPrefixFile: null,
    requestTimeoutSeconds: null,
    validateOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--manifest':
      case '--manifest-path':
        parsed.manifestPath = argv[++index];
        break;
      case '--run-id':
        parsed.runIds.push(argv[++index]);
        break;
      case '--prompt-prefix-file':
        parsed.promptPrefixFile = argv[++index];
        break;
      case '--request-timeout-seconds':
        parsed.requestTimeoutSeconds = getOptionalPositiveInt(argv[++index], 'requestTimeoutSeconds');
        break;
      case '--validate-only':
        parsed.validateOnly = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return parsed;
}
