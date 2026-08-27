import { ToolActivitySchema, type ToolActivity, type ToolActivityKind, type ToolActivitySubject } from '@siftkit/contracts';

import type { RepoNativeToolCall } from './repo-tool-arguments.js';
import { isValidationCommand } from './engine/validation-command-output-policy.js';

function deriveActivityKind(call: RepoNativeToolCall): ToolActivityKind {
  switch (call.toolName) {
    case 'read':
      return 'read';
    case 'grep':
    case 'find':
    case 'ls':
    case 'git':
      return 'search';
    case 'write':
    case 'edit':
      return 'edit';
    case 'web_search':
      return 'web_search';
    case 'web_fetch':
      return 'web_fetch';
    case 'run':
      return isValidationCommand(call.args.command) ? 'validate' : 'command';
  }
}

function getFileSubject(path: string): ToolActivitySubject {
  const segments = path.replace(/\\/gu, '/').split('/').filter(Boolean);
  const value = segments[segments.length - 1];
  return value ? { kind: 'file', value } : { kind: 'none' };
}

function getActivitySubject(call: RepoNativeToolCall): ToolActivitySubject {
  switch (call.toolName) {
    case 'read':
    case 'write':
    case 'edit':
      return getFileSubject(call.args.path);
    case 'web_fetch':
      try {
        const url = new URL(call.args.url);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname
          ? { kind: 'host', value: url.hostname }
          : { kind: 'none' };
      } catch {
        return { kind: 'none' };
      }
    case 'grep':
    case 'find':
    case 'ls':
    case 'git':
    case 'run':
    case 'web_search':
      return { kind: 'none' };
  }
}

export function getToolActivity(call: RepoNativeToolCall): ToolActivity {
  return ToolActivitySchema.parse({
    activityKind: deriveActivityKind(call),
    activitySubject: getActivitySubject(call),
  });
}
