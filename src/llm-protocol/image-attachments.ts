import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from '../lib/zod.js';
import { SIFT_MAX_IMAGE_BYTES } from '../config/constants.js';
import type { LlamaCppContentPart } from './types.js';
import type { ModelRuntimePreset } from '../config/types.js';

// ── MIME mapping ────────────────────────────────────────────────────────
// shared image attachment core

const IMAGE_MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
} as const;

type ImageExtension = keyof typeof IMAGE_MIME_MAP;

// ── Schema ──────────────────────────────────────────────────────────────

const SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export const ImageDataUrlSchema = z.string().refine(
  (val) => {
    if (!val.startsWith('data:image/')) return false;
    const mimeMatch = val.match(/^data:(image\/\w+);base64,/);
    if (!mimeMatch) return false;
    return SUPPORTED_MIMES.has(mimeMatch[1]);
  },
  { message: 'supported-image' },
);

export function parseImageDataUrls(input: unknown): string[] {
  const parsed = z.array(ImageDataUrlSchema).parse(input);
  return parsed;
}

// ── Reader ──────────────────────────────────────────────────────────────

export class ImageAttachmentReader {
  read(filePath: string): string {
    const rawExt = extname(filePath).toLowerCase();
    const mime = IMAGE_MIME_MAP[rawExt as ImageExtension];
    if (!mime) {
      throw new Error(`Unsupported image extension: ${rawExt}`);
    }
    const buf = readFileSync(filePath);
    if (buf.byteLength > SIFT_MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds maximum size of ${SIFT_MAX_IMAGE_BYTES} bytes`);
    }
    const b64 = buf.toString('base64');
    return `data:${mime};base64,${b64}`;
  }

  readAll(filePaths: string[]): string[] {
    return filePaths.map((p) => this.read(p));
  }
}

// ── Content builder ─────────────────────────────────────────────────────

export function buildUserContent(text: string, imageUris: string[]): string | LlamaCppContentPart[] {
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

// ── Preset guard ────────────────────────────────────────────────────────

export function assertPresetAcceptsImages(preset: ModelRuntimePreset, imageUris: string[]): void {
  if (imageUris.length === 0) return;
  if (preset.Backend === 'llama') {
    throw new Error('Images require exl3 backend; llama backend does not support images');
  }
  if (!preset.VisionEnabled) {
    throw new Error('Vision is not enabled for this preset; enable VisionEnabled to use images');
  }
}