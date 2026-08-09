import { existsSync, readFileSync, statSync } from 'node:fs';

import { SIFT_MAX_IMAGE_BYTES } from '@siftkit/contracts';

import { admitImageBuffer } from '../../llm-protocol/image-admission.js';
import {
  IMAGE_RETENTION_DISABLED_REASON,
  imageMimeForPath,
} from '../../llm-protocol/image-attachments.js';
import { buildReadPathKey } from './read-overlap.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RepoToolContext, RepoToolExecution } from './repo-tools.js';

export const VISION_DISABLED_READ_REASON =
  'reading images requires an exl3 preset with VisionEnabled; this preset is text-only';

/**
 * Shares `read`'s path resolution, ignore policy and existence checks, then diverges: no line
 * windowing, no read-overlap tracking, and a re-read guard keyed off what is live in context.
 */
export function executeImageRead(options: {
  args: JsonObject;
  requestedCommand: string;
  absolutePath: string;
  displayPath: string;
  context: RepoToolContext;
}): RepoToolExecution {
  const { args, requestedCommand, absolutePath, displayPath, context } = options;
  if (!context.visionEnabled) {
    return { ok: false, command: requestedCommand, reason: VISION_DISABLED_READ_REASON, toolType: 'read' };
  }
  if (context.visionImageRetention === 0) {
    return { ok: false, command: requestedCommand, reason: IMAGE_RETENTION_DISABLED_REASON, toolType: 'read' };
  }
  if (args.offset !== undefined || args.limit !== undefined) {
    return {
      ok: false,
      command: requestedCommand,
      reason: 'offset and limit do not apply to images; read the image without them',
      toolType: 'read',
    };
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file', toolType: 'read' };
  }
  const pathKey = buildReadPathKey(displayPath);
  if (context.liveImagePathKeys.has(pathKey)) {
    return {
      ok: false,
      command: requestedCommand,
      reason: `${displayPath} is already attached in this context. Look at the image above instead of reading it again.`,
      toolType: 'read',
    };
  }
  const mime = imageMimeForPath(displayPath);
  if (mime === undefined) {
    return { ok: false, command: requestedCommand, reason: 'path is not a supported image', toolType: 'read' };
  }
  const buffer = readFileSync(absolutePath);
  if (buffer.byteLength > SIFT_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      command: requestedCommand,
      reason: `image is ${buffer.byteLength} bytes; the limit is ${SIFT_MAX_IMAGE_BYTES} bytes`,
      toolType: 'read',
    };
  }
  try {
    const admitted = admitImageBuffer(buffer, mime, context.imageTokenBudget, context.visionMaxImagePixels);
    return {
      ok: true,
      requestedCommand,
      command: requestedCommand,
      exitCode: 0,
      output: `Image ${displayPath} (${admitted.metadata.width}×${admitted.metadata.height}) attached below.`,
      toolType: 'read',
      imageDataUrl: admitted.dataUrl,
      imageMetadata: admitted.metadata,
      imagePathKey: pathKey,
    };
  } catch (error) {
    return {
      ok: false,
      command: requestedCommand,
      reason: error instanceof Error ? error.message : String(error),
      toolType: 'read',
    };
  }
}
