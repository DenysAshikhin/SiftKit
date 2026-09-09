import { JsonValueSchema, type JsonValue } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import type { JsonObject } from './types.js';

/**
 * OpenAI-compatible providers reserve a top-level `error` key for fatal stream
 * termination, so any populated `error` slot ends the stream and a delta packet
 * never matches. Null is excluded because providers ride `"error": null` along on
 * ordinary delta frames.
 */
const StreamErrorFrameSchema = z.object({ error: JsonValueSchema });

/**
 * The documented payload shape. Unknown siblings such as TabbyAPI's `trace` are
 * stripped; a payload that does not match at all is rendered verbatim instead of
 * being dropped, because dropping it resurrects the missing-[DONE]-sentinel report
 * this parser exists to replace.
 */
const StreamErrorPayloadSchema = z.object({
  message: JsonValueSchema.optional(),
  code: JsonValueSchema.optional(),
});

export type StreamErrorFrame = {
  message: string;
  code: string | null;
};

/** Used when a provider sends an error frame with no message text of its own. */
export const UNSPECIFIED_STREAM_ERROR_MESSAGE = 'provider reported an unspecified stream error';

function renderErrorText(value: JsonValue): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.trim() || UNSPECIFIED_STREAM_ERROR_MESSAGE;
}

/** Reads a fatal error frame off an already-parsed packet, or null if this is not one. */
export function readStreamErrorFrame(packet: JsonObject): StreamErrorFrame | null {
  const frame = StreamErrorFrameSchema.safeParse(packet);
  if (!frame.success || frame.data.error === null) {
    return null;
  }
  const payload = StreamErrorPayloadSchema.safeParse(frame.data.error);
  if (!payload.success) {
    return { message: renderErrorText(frame.data.error), code: null };
  }
  const { message, code } = payload.data;
  return {
    message: message === undefined ? UNSPECIFIED_STREAM_ERROR_MESSAGE : renderErrorText(message),
    code: typeof code === 'string' ? code : null,
  };
}
