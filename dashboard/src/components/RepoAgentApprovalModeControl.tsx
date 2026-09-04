import React from 'react';
import type { ApprovalMode } from '@siftkit/contracts';

const APPROVAL_MODE_OPTIONS = [
  { value: 'interactive', label: 'Manual', title: 'Every mutating tool call waits for your approval' },
  { value: 'auto', label: 'Auto', title: 'The model reviews each mutating call; unsure calls wait for you' },
  { value: 'off', label: 'Approve all', title: 'No approvals; a pending approval is released immediately' },
] as const satisfies readonly { value: ApprovalMode; label: string; title: string }[];

export function RepoAgentApprovalModeControl({ value, disabled, onChange }: {
  value: ApprovalMode;
  disabled: boolean;
  onChange(mode: ApprovalMode): void;
}) {
  return (
    <div className="approval-mode" role="group" aria-label="Approval mode">
      {APPROVAL_MODE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'hchip on' : 'hchip'}
          aria-pressed={option.value === value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
