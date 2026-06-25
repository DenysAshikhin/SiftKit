export * from '@siftkit/contracts';
import type {
  RuntimeLlamaCppConfig,
  ServerManagedLlamaPreset,
  OperationModeAllowedTools,
  SiftPreset,
  ManagedLlamaSpeculativeType,
  PresetKind,
  PresetOperationMode,
  PresetSurface,
  PresetToolName,
  IdleSummarySnapshotRow,
} from '@siftkit/contracts';

// Dashboard-local aliases over the shared contract types (no contract-name equivalent).
export type DashboardLlamaCppConfig = RuntimeLlamaCppConfig;
export type DashboardManagedLlamaPreset = ServerManagedLlamaPreset;
export type DashboardOperationModeAllowedTools = OperationModeAllowedTools;
export type DashboardPreset = SiftPreset;
export type DashboardManagedLlamaSpeculativeType = ManagedLlamaSpeculativeType;
export type DashboardPresetKind = PresetKind;
export type DashboardPresetExecutionFamily = PresetKind;
export type DashboardPresetOperationMode = PresetOperationMode;
export type DashboardPresetSurface = PresetSurface;
export type DashboardPresetToolName = PresetToolName;
export type IdleSummarySnapshot = IdleSummarySnapshotRow;

// Purely client-side selection state, never crosses the wire.
export type RepoSearchAutoAppendSelection = {
  includeAgentsMd: boolean;
  includeRepoFileListing: boolean;
};
