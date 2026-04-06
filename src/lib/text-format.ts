export type ColorOptions = { env?: NodeJS.ProcessEnv; isTTY?: boolean };

export function formatTimestamp(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(Math.floor(milliseconds / 1000), 0);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}:${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  return `${seconds}s`;
}

export function formatGroupedNumber(value: unknown, fractionDigits: number | null = null): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const numericValue = Number(value);
  const useGrouping = Math.abs(numericValue) >= 1000;
  if (fractionDigits === null) {
    return useGrouping
      ? numericValue.toLocaleString('en-US', { maximumFractionDigits: 20 })
      : String(numericValue);
  }
  if (!useGrouping) {
    return numericValue.toFixed(fractionDigits);
  }
  return numericValue.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function formatInteger(value: unknown): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return formatGroupedNumber(Math.trunc(Number(value)));
}

export function formatMilliseconds(milliseconds: unknown): string {
  if (!Number.isFinite(milliseconds) || Number(milliseconds) < 0) {
    return 'n/a';
  }
  return `${formatGroupedNumber(milliseconds, 2)}ms`;
}

export function formatSeconds(milliseconds: unknown): string {
  if (!Number.isFinite(milliseconds) || Number(milliseconds) < 0) {
    return 'n/a';
  }
  return `${formatGroupedNumber(Number(milliseconds) / 1000, 2)}s`;
}

export function formatPercentage(value: unknown): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${formatGroupedNumber(Number(value) * 100, 2)}%`;
}

export function formatRatio(value: unknown): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${formatGroupedNumber(value, 2)}x`;
}

export function formatTokensPerSecond(value: unknown): string {
  if (!Number.isFinite(value) || Number(value) < 0) {
    return 'n/a';
  }
  return formatGroupedNumber(value, 2);
}

export function supportsAnsiColor(options: ColorOptions = {}): boolean {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stdout && process.stdout.isTTY);
  return isTTY && !Object.prototype.hasOwnProperty.call(env, 'NO_COLOR');
}

export function colorize(text: string, colorCode: number, options: ColorOptions = {}): string {
  if (!supportsAnsiColor(options)) {
    return text;
  }
  return `\x1b[${colorCode}m${text}\x1b[0m`;
}
