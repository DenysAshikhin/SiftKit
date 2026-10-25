export type AssistantCliInvocation =
  | { readonly kind: 'status' | 'pause' | 'resume' }
  | { readonly kind: 'factory_reset_preview' }
  | { readonly kind: 'factory_reset_confirm'; readonly previewToken: string }
  | { readonly kind: 'export'; readonly output: string; readonly includeBlobs: boolean }
  | { readonly kind: 'backup'; readonly output: string }
  | { readonly kind: 'restore_preview'; readonly input: string }
  | { readonly kind: 'restore_confirm'; readonly uploadId: string; readonly confirmToken: string };

const EXPORT_USAGE = 'Usage: siftkit assistant export --output <path> [--include-blobs]';
const BACKUP_USAGE = 'Usage: siftkit assistant backup --output <path>';
const RESTORE_USAGE =
  'Usage: siftkit assistant restore --input <path> --preview | --confirm <upload-id> <token>';

/** Every §16 destructive command spells the same rule, so the wording lives in one place. */
function destructiveModeError(command: string): Error {
  return new Error(`${command} requires exactly one of --preview or --confirm <token>.`);
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? '';
  if (normalized.length === 0) throw new Error(`Assistant ${label} is required.`);
  return normalized;
}

function exact(args: readonly string[], expected: number, usage: string): void {
  if (args.length !== expected) throw new Error(`Usage: ${usage}`);
}

export function parseAssistantArgs(args: readonly string[]): AssistantCliInvocation {
  const area = args[0];
  if (area === 'status' || area === 'pause' || area === 'resume') {
    exact(args, 1, `siftkit assistant ${area}`);
    return { kind: area };
  }
  if (area === 'factory-reset') return parseFactoryReset(args.slice(1));
  if (area === 'export') return parseExport(args.slice(1));
  if (area === 'backup') return parseBackup(args.slice(1));
  if (area === 'restore') return parseRestore(args.slice(1));
  throw new Error('Unknown or missing assistant command. Run `siftkit --help`.');
}

function parseFactoryReset(args: readonly string[]): AssistantCliInvocation {
  if (args.length === 1 && args[0] === '--preview') return { kind: 'factory_reset_preview' };
  if (args.length === 2 && args[0] === '--confirm') {
    return { kind: 'factory_reset_confirm', previewToken: required(args[1], 'preview token') };
  }
  throw destructiveModeError('Factory reset');
}

function parseExport(args: readonly string[]): AssistantCliInvocation {
  const includeBlobs = args.includes('--include-blobs');
  const rest = args.filter((token) => token !== '--include-blobs');
  if (rest.length !== 2 || rest[0] !== '--output') throw new Error(EXPORT_USAGE);
  return { kind: 'export', output: required(rest[1], 'output path'), includeBlobs };
}

function parseBackup(args: readonly string[]): AssistantCliInvocation {
  if (args.length !== 2 || args[0] !== '--output') throw new Error(BACKUP_USAGE);
  return { kind: 'backup', output: required(args[1], 'output path') };
}

function parseRestore(args: readonly string[]): AssistantCliInvocation {
  if (args.length === 3 && args[0] === '--input' && args[2] === '--preview') {
    return { kind: 'restore_preview', input: required(args[1], 'input path') };
  }
  if (args.length === 3 && args[0] === '--confirm') {
    return {
      kind: 'restore_confirm',
      uploadId: required(args[1], 'upload ID'),
      confirmToken: required(args[2], 'confirm token'),
    };
  }
  throw new Error(RESTORE_USAGE);
}
