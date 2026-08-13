import { JsonValueSchema, type JsonValue } from '../lib/json-types.js';
import { parseJsonText } from '../lib/json.js';

export type AssistantCliInvocation =
  | { readonly kind: 'status' | 'pause' | 'resume' | 'policy_list' | 'projections_rebuild' }
  | { readonly kind: 'memory_search'; readonly query: string; readonly modelIntent: boolean }
  | { readonly kind: 'memory_explain' | 'memory_confirm'; readonly assertionId: string }
  | { readonly kind: 'memory_correct'; readonly assertionId: string; readonly value: JsonValue }
  | { readonly kind: 'memory_forget_preview'; readonly assertionId: string }
  | {
    readonly kind: 'memory_forget_confirm';
    readonly assertionId: string;
    readonly previewToken: string;
  }
  | { readonly kind: 'policy_block_topic'; readonly topic: string }
  | { readonly kind: 'evidence_delete_preview'; readonly evidenceId: string }
  | {
    readonly kind: 'evidence_delete_confirm';
    readonly evidenceId: string;
    readonly previewToken: string;
  }
  | { readonly kind: 'forget_topic_preview'; readonly topicKey: string; readonly addPolicy: boolean }
  | {
    readonly kind: 'forget_topic_confirm';
    readonly topicKey: string;
    readonly addPolicy: boolean;
    readonly previewToken: string;
  }
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
  if (area === 'memory') return parseMemory(args.slice(1));
  if (area === 'policy') return parsePolicy(args.slice(1));
  if (area === 'evidence') return parseEvidence(args.slice(1));
  if (area === 'projections' && args[1] === 'rebuild') {
    exact(args, 2, 'siftkit assistant projections rebuild');
    return { kind: 'projections_rebuild' };
  }
  if (area === 'factory-reset') return parseFactoryReset(args.slice(1));
  if (area === 'export') return parseExport(args.slice(1));
  if (area === 'backup') return parseBackup(args.slice(1));
  if (area === 'restore') return parseRestore(args.slice(1));
  throw new Error('Unknown or missing assistant command. Run `siftkit --help`.');
}

function parseEvidence(args: readonly string[]): AssistantCliInvocation {
  if (args[0] !== 'delete') throw new Error('Unknown assistant evidence command.');
  const evidenceId = required(args[1], 'evidence ID');
  if (args.length === 3 && args[2] === '--preview') {
    return { kind: 'evidence_delete_preview', evidenceId };
  }
  if (args.length === 4 && args[2] === '--confirm') {
    return {
      kind: 'evidence_delete_confirm', evidenceId,
      previewToken: required(args[3], 'preview token'),
    };
  }
  throw destructiveModeError('Evidence delete');
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

function parseMemory(args: readonly string[]): AssistantCliInvocation {
  const action = args[0];
  if (action === 'search') {
    const modelIntent = args.includes('--model-intent');
    const queryTokens = args.slice(1).filter((token) => token !== '--model-intent');
    if (queryTokens.some((token) => token.startsWith('--'))) {
      throw new Error(`Unknown assistant memory search option: ${queryTokens.join(' ')}`);
    }
    return {
      kind: 'memory_search',
      query: required(queryTokens.join(' '), 'search query'),
      modelIntent,
    };
  }
  if (action === 'explain' || action === 'confirm') {
    exact(args, 2, `siftkit assistant memory ${action} <assertion-id>`);
    return {
      kind: action === 'explain' ? 'memory_explain' : 'memory_confirm',
      assertionId: required(args[1], 'assertion ID'),
    };
  }
  if (action === 'correct') {
    exact(args, 4, 'siftkit assistant memory correct <assertion-id> --value <json>');
    if (args[2] !== '--value') throw new Error('Memory correction requires --value <json>.');
    return {
      kind: 'memory_correct',
      assertionId: required(args[1], 'assertion ID'),
      value: parseJsonText(required(args[3], 'correction value'), JsonValueSchema),
    };
  }
  if (action === 'forget') {
    const assertionId = required(args[1], 'assertion ID');
    if (args.length === 3 && args[2] === '--preview') {
      return { kind: 'memory_forget_preview', assertionId };
    }
    if (args.length === 4 && args[2] === '--confirm') {
      return {
        kind: 'memory_forget_confirm', assertionId,
        previewToken: required(args[3], 'preview token'),
      };
    }
    throw destructiveModeError('Memory forget');
  }
  if (action === 'forget-topic') {
    const topicKey = required(args[1], 'topic key');
    const addPolicy = args.includes('--block');
    const rest = args.slice(2).filter((token) => token !== '--block');
    if (rest.length === 1 && rest[0] === '--preview') {
      return { kind: 'forget_topic_preview', topicKey, addPolicy };
    }
    if (rest.length === 2 && rest[0] === '--confirm') {
      return {
        kind: 'forget_topic_confirm', topicKey, addPolicy,
        previewToken: required(rest[1], 'preview token'),
      };
    }
    throw destructiveModeError('Memory forget-topic');
  }
  throw new Error('Unknown assistant memory command.');
}

function parsePolicy(args: readonly string[]): AssistantCliInvocation {
  if (args[0] === 'list') {
    exact(args, 1, 'siftkit assistant policy list');
    return { kind: 'policy_list' };
  }
  if (args[0] === 'block-topic') {
    exact(args, 2, 'siftkit assistant policy block-topic <topic>');
    return { kind: 'policy_block_topic', topic: required(args[1], 'policy topic') };
  }
  throw new Error('Unknown assistant policy command.');
}
