import type { Dict } from '../lib/types.js';

export function getDisplayToolCommand(command: Dict): string {
  const modelVisibleCommand = typeof command.modelVisibleCommand === 'string' ? command.modelVisibleCommand.trim() : '';
  if (modelVisibleCommand) return modelVisibleCommand;
  return typeof command.command === 'string' ? command.command.trim() : '';
}

export function commandMatchesDisplayText(command: Dict, text: string): boolean {
  const target = text.trim();
  if (!target) return false;
  const visible = typeof command.modelVisibleCommand === 'string' ? command.modelVisibleCommand.trim() : '';
  const raw = typeof command.command === 'string' ? command.command.trim() : '';
  return visible === target || raw === target;
}
