import React from 'react';
import { buildToolPolicyMatrixRows, toggleToolInMode } from '../../lib/tool-policy-matrix';
import type { DashboardConfig, DashboardOperationModeAllowedTools, DashboardPresetOperationMode, DashboardPresetToolName } from '../../types';

const MODE_COLUMNS: { mode: DashboardPresetOperationMode; label: string }[] = [
  { mode: 'summary', label: 'summary' },
  { mode: 'read-only', label: 'read-only' },
  { mode: 'full', label: 'full' },
];

function MatrixCell({ active, onToggle }: { active: boolean; onToggle(): void }) {
  return (
    <td className="c">
      <button
        type="button"
        className={active ? 'cb on' : 'cb'}
        aria-pressed={active}
        onClick={onToggle}
      />
    </td>
  );
}

export function ToolPolicyMatrix({ allowed, updateSettingsDraft }: {
  allowed: DashboardOperationModeAllowedTools;
  updateSettingsDraft(updater: (next: DashboardConfig) => void): void;
}) {
  const groups = buildToolPolicyMatrixRows(allowed);

  function toggle(tool: DashboardPresetToolName, mode: DashboardPresetOperationMode): void {
    updateSettingsDraft((next) => {
      next.OperationModeAllowedTools[mode] = toggleToolInMode(next.OperationModeAllowedTools, tool, mode);
    });
  }

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
                <MatrixCell active={row.summary} onToggle={() => toggle(row.tool, 'summary')} />
                <MatrixCell active={row.readOnly} onToggle={() => toggle(row.tool, 'read-only')} />
                <MatrixCell active={row.full} onToggle={() => toggle(row.tool, 'full')} />
              </tr>
            ))}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}
