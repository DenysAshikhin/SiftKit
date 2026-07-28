import { cloneDashboardConfig } from './lib/format';
import {
  applyOperationModeDefaults,
  applyPresetKindDefaults,
  togglePresetTool as getToggledPresetTools,
} from './preset-editor';
import { syncDerivedSettingsFields } from './settings-runtime';
import type {
  DashboardConfig,
  DashboardPreset,
  DashboardPresetKind,
  DashboardPresetOperationMode,
  DashboardPresetSurface,
  DashboardPresetToolName,
} from './types';

export class DashboardPresetDraftEditor {
  private readonly config: DashboardConfig;

  constructor(config: DashboardConfig) {
    this.config = cloneDashboardConfig(config);
  }

  setLabel(presetId: string, label: string): void {
    this.requirePreset(presetId).label = label;
  }

  setKind(presetId: string, kind: DashboardPresetKind): void {
    applyPresetKindDefaults(this.requirePreset(presetId), kind);
  }

  setOperationMode(presetId: string, operationMode: DashboardPresetOperationMode): void {
    applyOperationModeDefaults(this.requirePreset(presetId), operationMode);
  }

  toggleTool(presetId: string, tool: DashboardPresetToolName): void {
    const preset = this.requirePreset(presetId);
    preset.allowedTools = getToggledPresetTools(preset.allowedTools, tool);
  }

  setDescription(presetId: string, description: string): void {
    this.requirePreset(presetId).description = description;
  }

  setPromptPrefix(presetId: string, promptPrefix: string): void {
    this.requirePreset(presetId).promptPrefix = promptPrefix;
  }

  setSurfaceEnabled(
    presetId: string,
    surface: DashboardPresetSurface,
    enabled: boolean,
  ): void {
    const preset = this.requirePreset(presetId);
    preset.surfaces = enabled
      ? preset.surfaces.includes(surface)
        ? preset.surfaces
        : [...preset.surfaces, surface]
      : preset.surfaces.filter((entry) => entry !== surface);
  }

  setAgentsMdEnabled(presetId: string, enabled: boolean): void {
    this.requirePreset(presetId).includeAgentsMd = enabled;
  }

  setRepoFileListingEnabled(presetId: string, enabled: boolean): void {
    this.requirePreset(presetId).includeRepoFileListing = enabled;
  }

  setAutoloadFile(presetId: string, index: number, path: string): void {
    const preset = this.requirePreset(presetId);
    this.requireAutoloadIndex(preset, index);
    preset.autoloadFiles[index] = path;
  }

  addAutoloadFile(presetId: string): void {
    this.requirePreset(presetId).autoloadFiles.push('');
  }

  removeAutoloadFile(presetId: string, index: number): void {
    const preset = this.requirePreset(presetId);
    this.requireAutoloadIndex(preset, index);
    preset.autoloadFiles.splice(index, 1);
  }

  setDefaultSummaryPreset(presetId: string, enabled: boolean): void {
    this.requirePreset(presetId);
    for (const preset of this.config.Presets) {
      preset.useForSummary = preset.id === presetId ? enabled : false;
    }
  }

  getConfig(): DashboardConfig {
    return syncDerivedSettingsFields(this.config);
  }

  private requirePreset(presetId: string): DashboardPreset {
    const preset = this.config.Presets.find((entry) => entry.id === presetId);
    if (!preset) {
      throw new Error(`Unknown preset: ${presetId}`);
    }
    return preset;
  }

  private requireAutoloadIndex(preset: DashboardPreset, index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= preset.autoloadFiles.length) {
      throw new Error(`Invalid autoload file index ${index} for preset ${preset.id}`);
    }
  }
}
