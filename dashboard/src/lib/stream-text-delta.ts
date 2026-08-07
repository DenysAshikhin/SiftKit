import type { ChatStreamTextDelta } from '@siftkit/contracts';

/** Applies one wire delta to the assembled text. Offset 0 is a keyframe. */
export function applyTextDelta(previous: string, delta: ChatStreamTextDelta): string {
  if (delta.offset === 0) {
    return delta.text;
  }
  if (delta.offset === previous.length) {
    return previous + delta.text;
  }
  if (delta.offset < previous.length) {
    return previous.slice(0, delta.offset) + delta.text;
  }
  return previous;
}