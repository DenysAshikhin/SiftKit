import type { ToolActivityKind } from '@siftkit/contracts';

import type { RepoNativeToolCall } from './repo-tool-arguments.js';
import { isValidationCommand } from './engine/validation-command-output-policy.js';

export function getToolActivityKind(call: RepoNativeToolCall): ToolActivityKind {
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
