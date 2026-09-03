export * from '@siftkit/contracts';
import type {
  RuntimeLlamaCppConfig,
  ModelRuntimePreset,
  OperationModeAllowedTools,
  SiftPreset,
  ManagedLlamaSpeculativeType,
  PresetKind,
  PresetOperationMode,
  PresetSurface,
  PresetToolName,
  IdleSummarySnapshotRow,
  ChatTranscriptMessage,
  ChatTranscriptToolCallMessage,
} from '@siftkit/contracts';
import { ChatTranscriptMessageSchema } from '@siftkit/contracts';

export const ChatMessageSchema = ChatTranscriptMessageSchema;
export type ChatMessage = ChatTranscriptMessage;
export type ChatToolCallMessage = ChatTranscriptToolCallMessage;

// Dashboard-local aliases over the shared contract types (no contract-name equivalent).
export type DashboardLlamaCppConfig = RuntimeLlamaCppConfig;
export type DashboardModelRuntimePreset = ModelRuntimePreset;
export type DashboardOperationModeAllowedTools = OperationModeAllowedTools;
export type DashboardPreset = SiftPreset;
export type DashboardManagedLlamaSpeculativeType = ManagedLlamaSpeculativeType;
export type DashboardPresetKind = PresetKind;
export type DashboardPresetExecutionFamily = PresetKind;
export type DashboardPresetOperationMode = PresetOperationMode;
export type DashboardPresetSurface = PresetSurface;
export type DashboardPresetToolName = PresetToolName;
export type IdleSummarySnapshot = IdleSummarySnapshotRow;
