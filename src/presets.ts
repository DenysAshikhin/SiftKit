import {
  FULL_PRESET_TOOLS,
  PresetKindSchema,
  PresetOperationModeSchema,
  PresetToolNameSchema,
  READ_ONLY_PRESET_TOOLS,
  SUMMARY_PRESET_TOOLS,
  type OperationModeAllowedTools,
  type PresetKind,
  type PresetOperationMode,
  type PresetSurface,
  type PresetToolName,
  type SiftPreset,
} from '@siftkit/contracts';

import { JsonRecordReader } from './lib/json-record-reader.js';
import type { OptionalJsonValue } from './lib/json-types.js';

export type {
  OperationModeAllowedTools,
  PresetKind,
  PresetOperationMode,
  PresetSurface,
  PresetToolName,
  SiftPreset,
};

const PRESET_TOOL_NAME_SET = new Set<string>(PresetToolNameSchema.options);
const DEFAULT_OPERATION_MODE_ALLOWED_TOOLS: OperationModeAllowedTools = {
  summary: [...SUMMARY_PRESET_TOOLS],
  'read-only': [...READ_ONLY_PRESET_TOOLS],
  full: [...FULL_PRESET_TOOLS],
};

function isPresetToolName(value: string): value is PresetToolName {
  return PRESET_TOOL_NAME_SET.has(value);
}

function normalizeToolList(
  value: OptionalJsonValue,
  fallback: readonly PresetToolName[],
): PresetToolName[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const tools = new Set<PresetToolName>();
  for (const entry of value) {
    if (typeof entry === 'string' && isPresetToolName(entry)) {
      tools.add(entry);
    }
  }
  return tools.size > 0 ? [...tools] : [...fallback];
}

export function isPresetKind(value: OptionalJsonValue): value is PresetKind {
  return PresetKindSchema.safeParse(value).success;
}

export function isPresetOperationMode(value: OptionalJsonValue): value is PresetOperationMode {
  return PresetOperationModeSchema.safeParse(value).success;
}

export function getDefaultOperationModeAllowedTools(): OperationModeAllowedTools {
  return {
    summary: [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.summary],
    'read-only': [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only']],
    full: [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full],
  };
}

export function normalizeOperationModeAllowedTools(input: OptionalJsonValue): OperationModeAllowedTools {
  const reader = JsonRecordReader.fromJsonValue(input);
  return {
    summary: normalizeToolList(reader.value('summary'), DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.summary),
    'read-only': normalizeToolList(
      reader.value('read-only'),
      DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only'],
    ),
    full: normalizeToolList(reader.value('full'), DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full),
  };
}

export function resolvePresetAllowedTools(
  preset: Pick<SiftPreset, 'allowedTools' | 'operationMode'>,
  operationModeAllowedTools: OperationModeAllowedTools,
): PresetToolName[] {
  const modeAllowed = new Set<PresetToolName>(operationModeAllowedTools[preset.operationMode]);
  return preset.allowedTools.filter((tool) => modeAllowed.has(tool));
}
