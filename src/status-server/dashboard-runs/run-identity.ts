import {
  ModelRuntimePresetSchema,
  RunOperationTypeSchema,
  SiftPresetSchema,
  type ModelRuntimePreset,
  type RunOperationType,
  type SiftPreset,
} from '@siftkit/contracts';
import { z } from '../../lib/zod.js';

/**
 * Canonical identity persisted beside the legacy `run_kind` projection. Null in any field means
 * "not recorded for this run", never "the default preset"; consumers must not substitute one.
 */
export const RunIdentitySchema = z.object({
  operationType: RunOperationTypeSchema.nullable(),
  operationPresetId: z.string().nullable(),
  modelPresetId: z.string().nullable(),
  operationPresetJson: z.string().nullable(),
  modelPresetJson: z.string().nullable(),
});
export type RunIdentity = z.infer<typeof RunIdentitySchema>;

/** Identity for writes that carry no operation (admission side-effects, status-file metadata). */
export const UNRECORDED_RUN_IDENTITY: RunIdentity = {
  operationType: null,
  operationPresetId: null,
  modelPresetId: null,
  operationPresetJson: null,
  modelPresetJson: null,
};

/** Identity for a run whose operation is known before (or without) its presets resolving. */
export function operationOnlyRunIdentity(operationType: RunOperationType): RunIdentity {
  return { ...UNRECORDED_RUN_IDENTITY, operationType };
}

/** Snapshots are re-validated before serialization so a malformed preset never lands in the log. */
export function serializeOperationPresetSnapshot(preset: SiftPreset): string {
  return JSON.stringify(SiftPresetSchema.parse(preset));
}

export function serializeModelPresetSnapshot(preset: ModelRuntimePreset): string {
  return JSON.stringify(ModelRuntimePresetSchema.parse(preset));
}

export function buildRunIdentity(options: {
  operationType: RunOperationType;
  operationPreset: SiftPreset | null;
  modelPreset: ModelRuntimePreset | null;
  /** The id a session references; defaults to the snapshot's own id. */
  modelPresetId?: string;
}): RunIdentity {
  return {
    operationType: options.operationType,
    operationPresetId: options.operationPreset?.id ?? null,
    operationPresetJson: options.operationPreset ? serializeOperationPresetSnapshot(options.operationPreset) : null,
    modelPresetId: options.modelPresetId ?? options.modelPreset?.id ?? null,
    modelPresetJson: options.modelPreset ? serializeModelPresetSnapshot(options.modelPreset) : null,
  };
}
