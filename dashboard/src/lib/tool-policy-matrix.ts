import { togglePresetTool } from '../preset-editor';
import type {
  DashboardOperationModeAllowedTools,
  DashboardPresetOperationMode,
  DashboardPresetToolName,
} from '../types';

export const TOOL_POLICY_GROUPS = [
  { title: 'Text & JSON', tools: ['find_text', 'read_lines', 'json_filter', 'json_get'] },
  { title: 'Repository', tools: ['read', 'grep', 'find', 'ls', 'git'] },
  { title: 'Web', tools: ['web_search', 'web_fetch'] },
] as const satisfies readonly { title: string; tools: readonly DashboardPresetToolName[] }[];

export type ToolPolicyRow = {
  tool: DashboardPresetToolName;
  summary: boolean;
  readOnly: boolean;
  full: boolean;
};

export type ToolPolicyGroup = {
  title: string;
  rows: ToolPolicyRow[];
};

export function buildToolPolicyMatrixRows(allowed: DashboardOperationModeAllowedTools): ToolPolicyGroup[] {
  return TOOL_POLICY_GROUPS.map((group) => ({
    title: group.title,
    rows: group.tools.map((tool) => ({
      tool,
      summary: allowed.summary.includes(tool),
      readOnly: allowed['read-only'].includes(tool),
      full: allowed.full.includes(tool),
    })),
  }));
}

export function toggleToolInMode(
  allowed: DashboardOperationModeAllowedTools,
  tool: DashboardPresetToolName,
  mode: DashboardPresetOperationMode,
): DashboardPresetToolName[] {
  return togglePresetTool(allowed[mode], tool);
}
