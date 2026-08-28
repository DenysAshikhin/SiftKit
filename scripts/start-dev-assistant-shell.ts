import { join } from 'node:path';

import { z } from '../src/lib/zod.js';

/** Minimal view of GET /config used by the dev-stack assistant shell watcher. */
export const AssistantShellConfigSchema = z.object({
  Assistant: z.object({
    Enabled: z.boolean(),
  }),
});

export type AssistantShellAction = 'start' | 'stop' | 'none';

/**
 * Transition-based lifecycle: the shell starts when the assistant switch is on at
 * startup or flips on, and stops when it flips off. A shell the user quit manually
 * stays quit while the switch remains on (no flip, no restart).
 */
export function decideAssistantShellAction(
  previousEnabled: boolean | null,
  currentEnabled: boolean,
  shellRunning: boolean,
): AssistantShellAction {
  if (currentEnabled && !shellRunning && previousEnabled !== true) {
    return 'start';
  }
  if (!currentEnabled && shellRunning && previousEnabled === true) {
    return 'stop';
  }
  return 'none';
}

export function getAssistantShellPath(repoRoot: string): string {
  return join(repoRoot, 'desktop', 'src-tauri', 'target', 'release', 'siftkit-assistant-shell.exe');
}
