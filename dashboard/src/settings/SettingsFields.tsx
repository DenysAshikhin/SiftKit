import React from 'react';
import type { ReactNode } from 'react';

import { getSettingsFieldDescriptor, type SettingsFieldLayout, type SettingsSectionId } from '../settings-sections';

export type SettingsFieldProps = {
  label: string;
  layout: SettingsFieldLayout;
  helpText?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
};

const LAYOUT_SPAN: Record<SettingsFieldLayout, string> = {
  full: 'w4',
  half: 'w2',
  quarter: '',
};

export function shouldInlineHelp(helpText?: string): boolean {
  return typeof helpText === 'string' && helpText.length > 0 && helpText.length <= 60;
}

export function SettingsField({ label, layout, helpText, className, children }: SettingsFieldProps) {
  const inline = shouldInlineHelp(helpText);
  const classes = ['field', LAYOUT_SPAN[layout], className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <label>
        {label}
        {helpText && !inline ? <SettingsHelpPopover label={label} helpText={helpText} /> : null}
      </label>
      {children}
      {inline ? <span className="fhint">{helpText}</span> : null}
    </div>
  );
}

export type SettingsSectionFieldProps = {
  sectionId: SettingsSectionId;
  label: string;
  className?: string | undefined;
  children: ReactNode;
};

export function SettingsSectionField({ sectionId, label, className, children }: SettingsSectionFieldProps) {
  const field = getSettingsFieldDescriptor(sectionId, label);
  return (
    <SettingsField label={label} layout={field.layout} helpText={field.helpText} className={className}>
      {children}
    </SettingsField>
  );
}

export function SettingsHelpPopover({ label, helpText }: { label: string; helpText: string }) {
  return (
    <span className="settings-live-help">
      <button type="button" className="settings-live-help-trigger" aria-label={`Explain ${label}`}>
        ?
      </button>
      <span className="settings-live-help-popover" role="note">
        {helpText}
      </span>
    </span>
  );
}

export function SettingsInlineHelpLabel({ label, helpText }: { label: string; helpText?: string | undefined }) {
  return (
    <>
      <label>{label}</label>
      {helpText ? <SettingsHelpPopover label={label} helpText={helpText} /> : null}
    </>
  );
}
