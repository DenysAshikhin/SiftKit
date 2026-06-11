export type DisplayToolCommand = {
  command?: string | null;
  displayCommand?: string | null;
  modelVisibleCommand?: string | null;
  content?: string | null;
};

export function getDisplayToolCommand(command: DisplayToolCommand): string {
  const modelVisibleCommand = command.modelVisibleCommand?.trim() || '';
  if (modelVisibleCommand) return modelVisibleCommand;
  return command.displayCommand?.trim()
    || command.command?.trim()
    || command.content?.trim()
    || '';
}

export function commandMatchesDisplayText(command: DisplayToolCommand, text: string): boolean {
  const target = text.trim();
  if (!target) return false;
  return getDisplayToolCommand(command) === target || command.command?.trim() === target;
}
