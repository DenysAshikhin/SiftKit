import React from 'react';
import { buildToolPolicyMatrixRows } from '../../lib/tool-policy-matrix';
import type { ToolPolicySettingsActions } from '../../settings-action-groups';
import type {
  DashboardOperationModeAllowedTools,
  DashboardPresetOperationMode,
  DashboardPresetToolName,
} from '../../types';

const MODE_COLUMNS: { mode: DashboardPresetOperationMode; label: string }[] = [
  { mode: 'summary', label: 'summary' },
  { mode: 'read-only', label: 'read-only' },
  { mode: 'full', label: 'full' },
];

function MatrixCell({ active, mode, tool, toolPolicyActions }: {
  active: boolean;
  mode: DashboardPresetOperationMode;
  tool: DashboardPresetToolName;
  toolPolicyActions: ToolPolicySettingsActions;
}) {
  return (
    <td className="c">
      <button
        type="button"
        className={active ? 'cb on' : 'cb'}
        aria-pressed={active}
        onClick={() => toolPolicyActions.setToolEnabled(mode, tool, !active)}
      />
    </td>
  );
}

export function ToolPolicyMatrix({ allowed, toolPolicyActions }: {
  allowed: DashboardOperationModeAllowedTools;
  toolPolicyActions: ToolPolicySettingsActions;
}) {
  const groups = buildToolPolicyMatrixRows(allowed);

  return (
    <table className="tp-table">
      <thead>
        <tr>
          <th>Tool</th>
          {MODE_COLUMNS.map((column) => <th key={column.mode} className="c">{column.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <React.Fragment key={group.title}>
            <tr className="grp"><td colSpan={4}>{group.title}</td></tr>
            {group.rows.map((row) => (
              <tr key={row.tool}>
                <td>{row.tool}</td>
                <MatrixCell active={row.summary} mode="summary" tool={row.tool} toolPolicyActions={toolPolicyActions} />
                <MatrixCell active={row.readOnly} mode="read-only" tool={row.tool} toolPolicyActions={toolPolicyActions} />
                <MatrixCell active={row.full} mode="full" tool={row.tool} toolPolicyActions={toolPolicyActions} />
              </tr>
            ))}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}
