import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from '../lib/zod.js';
import {
  ImageDataUrlSchema,
  SIFT_MAX_IMAGE_BYTES,
  type ImageMime,
} from '@siftkit/contracts';
import type { LlamaCppContentPart } from './types.js';
import type { OptionalJsonValue } from '../lib/json-types.js';
import type { ModelRuntimePreset } from '../config/types.js';
import { admitImageBuffer, type AdmittedImage } from './image-admission.js';
import type { ImageTokenBudget } from '@siftkit/contracts';

// ── MIME mapping ────────────────────────────────────────────────────────
// shared image attachment core

// A Map keyed by plain string, so an arbitrary file extension is looked up without
// asserting it into the key union.
const IMAGE_MIME_MAP: ReadonlyMap<string, ImageMime> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

/** Sorted so the generated tool description is stable across runs. */
export function getSupportedImageExtensions(): string[] {
  return [...IMAGE_MIME_MAP.keys()].sort();
}

export function imageMimeForPath(filePath: string): ImageMime | undefined {
  return IMAGE_MIME_MAP.get(extname(filePath).toLowerCase());
}

export function isImagePath(filePath: string): boolean {
  return imageMimeForPath(filePath) !== undefined;
}

// ── Schema ──────────────────────────────────────────────────────────────

/**
 * Parses an `images` field off a request body or a persisted row. An absent field is an
 * empty list; anything present but malformed throws rather than being silently dropped.
 */
export function parseImageDataUrls(input: OptionalJsonValue): string[] {
  if (input === undefined || input === null) return [];
  return z.array(ImageDataUrlSchema).parse(input);
}

function readImageFile(filePath: string): { buffer: Buffer; mime: ImageMime } {
  const mime = imageMimeForPath(filePath);
  if (mime === undefined) {
    throw new Error(`Unsupported image extension: ${extname(filePath).toLowerCase()}`);
  }
  const buffer = readFileSync(filePath);
  if (buffer.byteLength > SIFT_MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds maximum size of ${SIFT_MAX_IMAGE_BYTES} bytes`);
  }
  return { buffer, mime };
}

/** Encodes a local image for transport. Preset-specific admission remains server-owned. */
export function readImageFileDataUrl(filePath: string): string {
  const { buffer, mime } = readImageFile(filePath);
  return ImageDataUrlSchema.parse(`data:${mime};base64,${buffer.toString('base64')}`);
}

// ── Reader ──────────────────────────────────────────────────────────────

export class ImageAttachmentReader {
  constructor(
    private readonly budget: ImageTokenBudget,
    private readonly visionMaxImagePixels = 0,
  ) {}

  read(filePath: string): string {
    return this.readAdmitted(filePath).dataUrl;
  }

  readAdmitted(filePath: string): AdmittedImage {
    const { buffer, mime } = readImageFile(filePath);
    return admitImageBuffer(buffer, mime, this.budget, this.visionMaxImagePixels);
  }

  readAll(filePaths: string[]): string[] {
    return filePaths.map((p) => this.read(p));
  }
}

// ── Content builder ─────────────────────────────────────────────────────

export function buildUserContent(
  text: string,
  imageUris: readonly string[],
): string | LlamaCppContentPart[] {
  if (imageUris.length === 0) return text;

  const parts: LlamaCppContentPart[] = [];
  if (text.length > 0) {
    parts.push({ type: 'text', text });
  }
  for (const uri of imageUris) {
    parts.push({ type: 'image_url', image_url: { url: uri } });
  }
  return parts;
}

// ── Content schema ──────────────────────────────────────────────────────
// Runtime shape of `LlamaCppContentPart` for IO boundaries that persist or replay
// message content. Kept here so the part shape has one definition.

export const ContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z.object({ url: z.string() }).optional(),
});

export const MessageContentSchema = z.union([z.string(), z.array(ContentPartSchema)]);

// ── Content-part readers ────────────────────────────────────────────────
// Message content is either a plain string or the parts array `buildUserContent`
// produces. Every reader that needs the prose or the image count goes through these
// so the part shape is decoded in exactly one place.

export function extractContentText(content: string | LlamaCppContentPart[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join(' ');
}

export function countContentImages(content: string | LlamaCppContentPart[] | undefined): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part.type === 'image_url').length;
}

// ── Preset guard ────────────────────────────────────────────────────────

export const IMAGE_RETENTION_DISABLED_REASON =
  'Image input is disabled for this preset (VisionImageRetention = 0)';

/** Why this preset refuses image input, or `null` when it accepts it. */
function presetImageRejection(preset: ModelRuntimePreset): string | null {
  if (preset.Backend === 'llama') {
    return 'Images require exl3 backend; llama backend does not support images';
  }
  if (!preset.VisionEnabled) {
    return 'Vision is not enabled for this preset; enable VisionEnabled to use images';
  }
  if (preset.VisionImageRetention === 0) {
    return IMAGE_RETENTION_DISABLED_REASON;
  }
  return null;
}

/** The silent form of the guard below, for callers deciding whether to produce images at all. */
export function presetAcceptsImages(preset: ModelRuntimePreset): boolean {
  return presetImageRejection(preset) === null;
}

export function assertPresetAcceptsImages(
  preset: ModelRuntimePreset,
  imageUris: readonly string[],
): void {
  if (imageUris.length === 0) return;
  const rejection = presetImageRejection(preset);
  if (rejection !== null) {
    throw new Error(rejection);
  }
}
