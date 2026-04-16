import type { ReactNode } from 'react';

import type { SettingsFieldLayout } from '../settings-sections';

export type SettingsFieldProps = {
  label: string;
  layout: SettingsFieldLayout;
  helpText?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
};

export function SettingsField({ label, layout, helpText, className, children }: SettingsFieldProps) {
  return (
    <div className={`settings-live-field settings-live-field-${layout}${className ? ` ${className}` : ''}`}>
      <div className="settings-live-label-row">
        <SettingsInlineHelpLabel label={label} helpText={helpText} />
      </div>
      {children}
    </div>
  );
}

export function SettingsInlineHelpLabel({ label, helpText }: { label: string; helpText?: string | undefined }) {
  return (
    <>
      <label>{label}</label>
      {helpText ? (
        <span className="settings-live-help">
          <button type="button" className="settings-live-help-trigger" aria-label={`Explain ${label}`}>
            ?
          </button>
          <span className="settings-live-help-popover" role="note">
            {helpText}
          </span>
        </span>
      ) : null}
    </>
  );
}
