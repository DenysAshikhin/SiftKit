import type { OptionalJsonValue } from '../../../src/lib/json-types.js';

type ToolCommandRecord = {
  modelVisibleCommand?: OptionalJsonValue;
  command?: OptionalJsonValue;
};

function readTrimmedString(record: ToolCommandRecord, key: 'modelVisibleCommand' | 'command'): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function getDisplayToolCommand(record: ToolCommandRecord): string {
  const visible = readTrimmedString(record, 'modelVisibleCommand');
  if (visible) return visible;
  return readTrimmedString(record, 'command');
}

export function commandMatchesDisplayText(record: ToolCommandRecord, text: string): boolean {
  const target = text.trim();
  if (!target) return false;
  return readTrimmedString(record, 'modelVisibleCommand') === target
    || readTrimmedString(record, 'command') === target;
}
