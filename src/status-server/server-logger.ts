import { z } from '../lib/zod.js';

const LogLevelSchema = z.enum(['quiet', 'normal', 'debug']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

const LEVEL_RANK: Record<LogLevel, number> = { quiet: 0, normal: 1, debug: 2 };

/** Column at which continuation lines align with the field group of an event line. */
const CONTINUATION_INDENT = 35;

export const Ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  timestamp: '\x1b[2;37m',
  scope: '\x1b[36m',
  id: '\x1b[2;35m',
  slow: '\x1b[33m',
  ok: '\x1b[32m',
  error: '\x1b[31m',
} as const;

export type ServerLogEvent = {
  scope: string;
  id: string;
  event: string;
  fields: string;
  date?: Date;
};

export function shortenRequestId(requestId: string): string {
  const normalized = requestId.trim();
  return normalized ? normalized.slice(0, 8) : '--------';
}

export function readLogLevelFromEnv(): LogLevel {
  return LogLevelSchema.catch('normal').parse((process.env.SIFTKIT_LOG_LEVEL ?? '').trim());
}

export function shouldUseColour(): boolean {
  if ((process.env.NO_COLOR ?? '').trim()) {
    return false;
  }
  if ((process.env.FORCE_COLOR ?? '').trim()) {
    return true;
  }
  return process.stdout.isTTY === true;
}

function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export type ServerLoggerOptions = {
  level: LogLevel;
  colour: boolean;
  write: (text: string) => void;
};

export class ServerLogger {
  private readonly level: LogLevel;
  private readonly colour: boolean;
  private readonly writeText: (text: string) => void;

  constructor(options: ServerLoggerOptions) {
    this.level = options.level;
    this.colour = options.colour;
    this.writeText = options.write;
  }

  /** Tracing detail; only printed at `debug`. */
  debug(event: ServerLogEvent): void {
    this.emit(event, 'debug', '');
  }

  /** Ordinary progress; printed at `normal` and `debug`. */
  event(event: ServerLogEvent): void {
    this.emit(event, 'normal', '');
  }

  /** Queue, heartbeat and wait lines; printed at `normal` and `debug`, de-emphasised. */
  dim(event: ServerLogEvent): void {
    this.emit(event, 'normal', Ansi.dim);
  }

  /** Terminal success; printed at every level. */
  ok(event: ServerLogEvent): void {
    this.emit(event, 'quiet', Ansi.ok);
  }

  /** Failure; printed at every level. */
  error(event: ServerLogEvent): void {
    this.emit(event, 'quiet', Ansi.error);
  }

  /** Continuation lines for grouped events; indented to the field column, never coloured. */
  continuation(text: string): void {
    if (LEVEL_RANK[this.level] < LEVEL_RANK.normal) {
      return;
    }
    this.writeText(`${' '.repeat(CONTINUATION_INDENT)}${text}\n`);
  }

  private paint(text: string, code: string): string {
    return this.colour && code ? `${code}${text}${Ansi.reset}` : text;
  }

  /** `minimumLevel` is the lowest configured level at which the line still prints. */
  private emit(event: ServerLogEvent, minimumLevel: LogLevel, eventColour: string): void {
    if (LEVEL_RANK[this.level] < LEVEL_RANK[minimumLevel]) {
      return;
    }
    const clock = this.paint(formatClock(event.date ?? new Date()), Ansi.timestamp);
    const scope = this.paint(event.scope, Ansi.scope);
    const id = this.paint(shortenRequestId(event.id), Ansi.id);
    const verb = this.paint(event.event, eventColour || Ansi.bold);
    const fields = event.fields ? `  ${event.fields}` : '';
    this.writeText(`${clock}  ${scope} ${id}  ${verb}${fields}\n`);
  }
}

export const serverLogger = new ServerLogger({
  level: readLogLevelFromEnv(),
  colour: shouldUseColour(),
  write: (text: string) => { process.stdout.write(text); },
});
