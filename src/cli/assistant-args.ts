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
  | { readonly kind: 'policy_block_topic'; readonly topic: string };

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
  if (area === 'projections' && args[1] === 'rebuild') {
    exact(args, 2, 'siftkit assistant projections rebuild');
    return { kind: 'projections_rebuild' };
  }
  throw new Error('Unknown or missing assistant command. Run `siftkit --help`.');
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
    throw new Error('Memory forget requires exactly one of --preview or --confirm <token>.');
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
