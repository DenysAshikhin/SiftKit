export type SseFrame = { event: string; data: string };

/** Incrementally parses text/event-stream chunks into complete data frames. */
export class SseFrameParser {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let boundary = /\r?\n\r?\n/u.exec(this.buffer);
    while (boundary) {
      const packet = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/u.exec(this.buffer);
      const frame = parsePacket(packet);
      if (frame) {
        frames.push(frame);
      }
    }
    return frames;
  }
}

function parsePacket(packet: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of packet.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  return dataLines.length === 0 ? null : { event, data: dataLines.join('\n') };
}
