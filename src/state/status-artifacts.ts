import { z } from '../lib/zod.js';
import type { JsonObject } from '../lib/json-types.js';
import { getRuntimeArtifactUri } from './runtime-artifacts.js';

/**
 * Artifact payloads a summary run defers to the status server at terminal time.
 * `request_abandoned` is server-authored, so it is a status artifact but never a
 * deferred one.
 */
export const DEFERRED_ARTIFACT_TYPES = ['summary_request', 'planner_debug', 'planner_failed'] as const;
export const STATUS_ARTIFACT_TYPES = [...DEFERRED_ARTIFACT_TYPES, 'request_abandoned'] as const;

export type DeferredArtifactType = (typeof DEFERRED_ARTIFACT_TYPES)[number];
export type StatusArtifactType = (typeof STATUS_ARTIFACT_TYPES)[number];

export const DeferredArtifactTypeSchema = z.enum(DEFERRED_ARTIFACT_TYPES);
export const StatusArtifactTypeSchema = z.enum(STATUS_ARTIFACT_TYPES);

export type DeferredArtifact = {
  artifactType: DeferredArtifactType;
  artifactRequestId: string;
  artifactPayload: JsonObject;
};

/** Runtime-artifact row id the status server persists each status artifact under. */
export function getStatusArtifactId(artifactType: StatusArtifactType, requestId: string): string {
  return `status:${artifactType}:${requestId}`;
}

/**
 * Resolvable reference to a persisted status artifact. Uses the one `db://`
 * scheme the repo can actually parse (`parseRuntimeArtifactUri` +
 * `readRuntimeArtifact`), so a reference handed to a user or stored in a payload
 * can be fetched back.
 */
export function getStatusArtifactUri(artifactType: StatusArtifactType, requestId: string): string {
  return getRuntimeArtifactUri(getStatusArtifactId(artifactType, requestId));
}
