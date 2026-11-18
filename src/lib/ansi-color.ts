// Terminal colour helpers; kept apart from text-format.ts so the browser dashboard can import that one.
export type ColorOptions = { env?: NodeJS.ProcessEnv; isTTY?: boolean };

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
