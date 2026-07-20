import { togglePresetTool } from '../preset-editor';
import type {
  DashboardOperationModeAllowedTools,
  DashboardPresetOperationMode,
  DashboardPresetToolName,
} from '../types';

export const TOOL_POLICY_GROUPS = [
  { title: 'Text & JSON', tools: ['find_text', 'read_lines', 'json_filter', 'json_get'] },
  { title: 'Repository', tools: ['repo_rg', 'repo_read_file', 'repo_list_files', 'repo_git'] },
  { title: 'Object pipeline', tools: ['repo_select_object', 'repo_where_object', 'repo_sort_object', 'repo_group_object', 'repo_measure_object', 'repo_foreach_object', 'repo_get_unique'] },
  { title: 'Formatting', tools: ['repo_format_table', 'repo_format_list', 'repo_out_string', 'repo_convertto_json', 'repo_convertfrom_json', 'repo_join_string'] },
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
