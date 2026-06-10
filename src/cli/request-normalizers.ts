import type {
  CommandOutputReducerProfile,
  CommandOutputRiskLevel,
} from '../command-output/types.js';
import type { ShellName } from '../capture/process.js';
import type { SummaryPolicyProfile } from '../summary/types.js';

export function normalizeCliFormat(value: unknown): 'text' | 'json' {
  return value === 'json' ? 'json' : 'text';
}

export function normalizeCliPolicyProfile(value: unknown): SummaryPolicyProfile | undefined {
  return (
    value === 'general'
    || value === 'pass-fail'
    || value === 'unique-errors'
    || value === 'buried-critical'
    || value === 'json-extraction'
    || value === 'diff-summary'
    || value === 'risky-operation'
  ) ? value : undefined;
}

export function normalizeCliPolicyProfileOrDefault(value: unknown): SummaryPolicyProfile {
  return normalizeCliPolicyProfile(value) || 'general';
}

export function normalizeCliRiskLevel(value: unknown): CommandOutputRiskLevel | undefined {
  return value === 'informational' || value === 'debug' || value === 'risky' ? value : undefined;
}

export function normalizeCliReducerProfile(value: unknown): CommandOutputReducerProfile | undefined {
  return value === 'smart' || value === 'errors' || value === 'tail' || value === 'diff' || value === 'none'
    ? value
    : undefined;
}

export function normalizeCliShell(value: unknown): ShellName | undefined {
  return value === 'auto'
    || value === 'pwsh'
    || value === 'powershell'
    || value === 'bash'
    || value === 'sh'
    || value === 'cmd'
    ? value
    : undefined;
}
