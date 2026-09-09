import { z } from '../lib/zod.js';
import type { JsonObject } from './types.js';

/**
 * OpenAI-compatible providers reserve a top-level `error` key for fatal stream
 * termination, so a delta packet never matches this shape. Both the object form
 * (`{"error": {"message": ...}}`) and the bare string form appear in the wild.
 * Unknown sibling keys such as TabbyAPI's `trace` are stripped by `z.object`.
 */
const StreamErrorFrameSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string().optional(),
      code: z.string().nullish(),
    }),
  ]),
});

export type StreamErrorFrame = {
  message: string;
  code: string | null;
};

/** Used when a provider sends an error frame with no message text of its own. */
export const UNSPECIFIED_STREAM_ERROR_MESSAGE = 'provider reported an unspecified stream error';

/** Reads a fatal error frame off an already-parsed packet, or null if this is not one. */
export function readStreamErrorFrame(packet: JsonObject): StreamErrorFrame | null {
  const parsed = StreamErrorFrameSchema.safeParse(packet);
  if (!parsed.success) {
    return null;
  }
  const { error } = parsed.data;
  if (typeof error === 'string') {
    return { message: error.trim() || UNSPECIFIED_STREAM_ERROR_MESSAGE, code: null };
  }
  return {
    message: error.message?.trim() || UNSPECIFIED_STREAM_ERROR_MESSAGE,
    code: error.code ?? null,
  };
}
