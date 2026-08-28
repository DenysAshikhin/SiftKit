import { z } from 'zod';

import { ImageDataUrlSchema } from './image.js';

/**
 * Wire contracts between the Tauri desktop shell (Rust) and the daemon's `/assistant/*` routes.
 *
 * Every DTO is `.strict()` and pins `schemaVersion` to a literal, so a shell built against a
 * different contract generation fails closed at the boundary instead of half-parsing.
 */

/**
 * The shell's 64-bit dHash as 16 lowercase hex characters. The charset is part of the contract:
 * the daemon reads these as hex `BigInt`s to score perceptual similarity.
 */
export const PerceptualHashSchema = z.string().regex(/^[0-9a-f]{16}$/);

export const ForegroundContextDtoSchema = z.object({
  processName: z.string().nullable(),
  executablePath: z.string().nullable(),
  applicationId: z.string().nullable(),
  normalizedTitle: z.string().nullable(),
  fullscreen: z.boolean(),
}).strict();
export type ForegroundContextDto = z.infer<typeof ForegroundContextDtoSchema>;

export const ActivityEventDtoSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAtUtc: z.string(),
  foreground: ForegroundContextDtoSchema,
  idleSeconds: z.number().int().min(0),
  sessionLocked: z.boolean(),
}).strict();
export type ActivityEventDto = z.infer<typeof ActivityEventDtoSchema>;

/**
 * The cadence the shell pushes `EnvironmentStateDto` on (spec §2). The daemon treats three missed
 * beats as "the shell is gone", so both sides derive their timing from this one value.
 */
export const DESKTOP_HEARTBEAT_INTERVAL_SECONDS = 20;
export const DESKTOP_HEARTBEAT_STALENESS_SECONDS = DESKTOP_HEARTBEAT_INTERVAL_SECONDS * 3;

export const EnvironmentStateDtoSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAtUtc: z.string(),
  fullscreen: z.boolean(),
  locked: z.boolean(),
  doNotDisturb: z.boolean(),
  presenting: z.boolean(),
  excludedApplication: z.boolean(),
  secondsSinceInput: z.number().int().min(0),
  power: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('available'),
      onBattery: z.boolean(),
      batteryPercent: z.number().min(0).max(100),
    }).strict(),
    z.object({ kind: z.literal('unavailable') }).strict(),
  ]),
}).strict();
export type EnvironmentStateDto = z.infer<typeof EnvironmentStateDtoSchema>;

export const CaptureReasonSchema = z.enum(['fixed_cadence', 'window_change', 'manual']);
export type CaptureReason = z.infer<typeof CaptureReasonSchema>;

export const CaptureDisplayDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  primary: z.boolean(),
  pixelWidth: z.number().int().positive(),
  pixelHeight: z.number().int().positive(),
  logicalWidth: z.number().int().positive(),
  logicalHeight: z.number().int().positive(),
  scaleFactor: z.number().positive(),
}).strict();
export type CaptureDisplayDto = z.infer<typeof CaptureDisplayDtoSchema>;

export const CaptureSubmissionDtoSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAtUtc: z.string(),
  reason: CaptureReasonSchema,
  display: CaptureDisplayDtoSchema,
  foregroundContextKey: z.string().min(1),
  foreground: ForegroundContextDtoSchema,
  pixelSha256: z.string().length(64),
  perceptualHash: PerceptualHashSchema,
  imageDataUrl: ImageDataUrlSchema,
}).strict();
export type CaptureSubmissionDto = z.infer<typeof CaptureSubmissionDtoSchema>;

export const SuppressionRuleIdSchema = z.enum([
  'private_mode',
  'session_locked',
  'secure_desktop',
  'unknown_foreground',
  'process_denylist',
  'title_deny_pattern',
  'private_browsing',
  'fullscreen_suppression',
  'secret_classification',
  'capture_failure',
]);
export type SuppressionRuleId = z.infer<typeof SuppressionRuleIdSchema>;

export const SuppressionAuditDtoSchema = z.object({
  schemaVersion: z.literal(1),
  occurredAtUtc: z.string(),
  ruleId: SuppressionRuleIdSchema,
}).strict();
export type SuppressionAuditDto = z.infer<typeof SuppressionAuditDtoSchema>;

export const KeyCustodySchema = z.enum(['file', 'desktop']);
export type KeyCustody = z.infer<typeof KeyCustodySchema>;

export const KeyCustodyStateSchema = z.object({
  custody: KeyCustodySchema,
  imported: z.boolean(),
  activeKeyId: z.string().nullable(),
}).strict();
export type KeyCustodyState = z.infer<typeof KeyCustodyStateSchema>;

export const KeyCustodyStatusDtoSchema = z.object({
  schemaVersion: z.literal(1),
  ...KeyCustodyStateSchema.shape,
}).strict();
export type KeyCustodyStatusDto = z.infer<typeof KeyCustodyStatusDtoSchema>;

export const KEY_MATERIAL_SCHEMA_VERSION = 1;

export const KeyMaterialDtoSchema = z.object({
  schemaVersion: z.literal(KEY_MATERIAL_SCHEMA_VERSION),
  activeKeyId: z.string().min(1),
  /** keyId -> base64 key material, 32 bytes once decoded. */
  keys: z.record(z.string().min(1), z.string().min(1)),
}).strict();
export type KeyMaterialDto = z.infer<typeof KeyMaterialDtoSchema>;

export const DesktopStateDtoSchema = z.object({
  schemaVersion: z.literal(1),
  assistantEnabled: z.boolean(),
  captureEnabled: z.boolean(),
  paused: z.boolean(),
  custody: KeyCustodyStateSchema,
  imageCapability: z.object({
    capable: z.boolean(),
    instanceId: z.string().nullable(),
    queueDepth: z.number().int().min(0),
  }).strict(),
  pendingQuestion: z.object({
    id: z.string(),
    questionText: z.string(),
  }).strict().nullable(),
}).strict();
export type DesktopStateDto = z.infer<typeof DesktopStateDtoSchema>;

/** Queue states the dashboard pending view lists; the DTO state enum derives from this. */
export const PENDING_CAPTURE_LIST_STATES = ['queued', 'awaiting_image_capability', 'processing'] as const;

/** A capture still owed an extraction, listed for the dashboard pending view. */
export const PendingCaptureDtoSchema = z.object({
  evidenceId: z.string().min(1),
  state: z.enum(PENDING_CAPTURE_LIST_STATES),
  enqueuedAtUtc: z.string(),
  byteLength: z.number().int().positive(),
  foregroundContextKey: z.string(),
}).strict();
export type PendingCaptureDto = z.infer<typeof PendingCaptureDtoSchema>;

export const PendingCapturesResponseSchema = z.object({
  captures: z.array(PendingCaptureDtoSchema),
}).strict();
export type PendingCapturesResponse = z.infer<typeof PendingCapturesResponseSchema>;
