import { useId, useState } from 'react';

import {
  PLAN_MAX_TURNS_VALIDATION_ERROR,
  PlanMaxTurnsOverrideSchema,
} from '../lib/chat-composer-inputs';

export function RepoAgentTurnsControl(props: {
  value: string;
  defaultMaxTurns: number;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const fieldId = `repo-agent-turns-${id}`;
  const errorId = `${fieldId}-error`;
  const parsed = PlanMaxTurnsOverrideSchema.safeParse(props.value);
  const invalid = !parsed.success;
  const maxTurns = parsed.success && 'maxTurns' in parsed.data
    ? parsed.data.maxTurns
    : props.defaultMaxTurns;

  return (
    <div className="repo-agent-turns-control">
      <button
        type="button"
        className="hchip"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={props.disabled}
      >
        Turns: {invalid ? 'Invalid' : maxTurns}
      </button>
      {open ? (
        <div className="repo-agent-turns-editor">
          <label htmlFor={fieldId}>Maximum turns</label>
          <input
            id={fieldId}
            type="text"
            inputMode="numeric"
            value={props.value}
            aria-invalid={invalid ? 'true' : undefined}
            aria-describedby={invalid ? errorId : undefined}
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.target.value)}
          />
          <button
            type="button"
            className="ghost-btn"
            onClick={() => props.onChange('')}
            disabled={props.disabled}
          >
            Reset to default
          </button>
        </div>
      ) : null}
      {invalid ? (
        <span id={errorId} className="repo-agent-turns-error" role="alert">
          {PLAN_MAX_TURNS_VALIDATION_ERROR}
        </span>
      ) : null}
    </div>
  );
}
