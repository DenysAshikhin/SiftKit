import type { SettingsSectionId } from './settings-sections';

export type DirtyContinuation =
  | { kind: 'switch-section'; nextSection: SettingsSectionId }
  | { kind: 'switch-tab'; nextTab: 'runs' | 'metrics' | 'benchmark' | 'chat' | 'settings' }
  | { kind: 'reload-settings' }
  | { kind: 'restart-backend' };

export type DirtyActionKind = DirtyContinuation['kind'];

export function getDirtyActionRequirement(isDirty: boolean, action: DirtyActionKind): 'confirm' | 'continue' {
  void action;
  return isDirty ? 'confirm' : 'continue';
}
