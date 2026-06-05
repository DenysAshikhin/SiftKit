const DEFAULT_MIN_TOTAL_TOKENS = 101;
const DEFAULT_WINDOW_TOKENS = 10;
const DEFAULT_MIN_REPEATS = 2;

export type TokenRepetitionDetection = {
  totalTokens: number;
  windowTokens: number;
  periodTokens: number;
  repeatedRunTokens: number;
  repeatedTokens: string[];
  truncatedText: string;
};

export type TokenRepetitionDetectionOptions = {
  minTotalTokens?: number;
  windowTokens?: number;
  minRepeats?: number;
  minRepeatedRunTokens?: number;
};

type TokenSpan = {
  value: string;
  startIndex: number;
};

function tokenizeForRepetitionDetection(text: string): TokenSpan[] {
  const tokens: TokenSpan[] = [];
  const pattern = /<\/?[A-Za-z_][A-Za-z0-9_-]*>?|[A-Za-z0-9_]+|[^\s]/gu;
  for (const match of String(text || '').matchAll(pattern)) {
    tokens.push({
      value: match[0],
      startIndex: match.index || 0,
    });
  }
  return tokens;
}

function buildPrefixTable(tokens: readonly TokenSpan[]): number[] {
  const prefixTable = Array.from({ length: tokens.length }, () => 0);
  for (let index = 1; index < tokens.length; index += 1) {
    let prefixLength = prefixTable[index - 1] || 0;
    while (prefixLength > 0 && tokens[index]?.value !== tokens[prefixLength]?.value) {
      prefixLength = prefixTable[prefixLength - 1] || 0;
    }
    if (tokens[index]?.value === tokens[prefixLength]?.value) {
      prefixLength += 1;
    }
    prefixTable[index] = prefixLength;
  }
  return prefixTable;
}

export function detectRecentTokenRepetition(
  text: string,
  options: TokenRepetitionDetectionOptions = {},
): TokenRepetitionDetection | null {
  const minTotalTokens = Math.max(1, Math.trunc(options.minTotalTokens ?? DEFAULT_MIN_TOTAL_TOKENS));
  const windowTokens = Math.max(1, Math.trunc(options.windowTokens ?? DEFAULT_WINDOW_TOKENS));
  const minRepeats = Math.max(2, Math.trunc(options.minRepeats ?? DEFAULT_MIN_REPEATS));
  const minRepeatedRunTokens = Math.max(0, Math.trunc(options.minRepeatedRunTokens ?? 0));
  const tokens = tokenizeForRepetitionDetection(text);
  if (tokens.length < minTotalTokens || tokens.length < windowTokens) {
    return null;
  }

  const suffixWindow = tokens.slice(tokens.length - windowTokens);
  const reversedWindow = [...suffixWindow].reverse();
  const prefixTable = buildPrefixTable(reversedWindow);
  const periodTokens = windowTokens - (prefixTable[windowTokens - 1] || 0);
  if (periodTokens >= windowTokens || windowTokens / periodTokens < minRepeats) {
    return null;
  }

  const repeatedTokens = suffixWindow.slice(windowTokens - periodTokens).map((token) => token.value);
  let repeatedRunStartIndex = tokens.length - periodTokens;
  while (repeatedRunStartIndex - periodTokens >= 0) {
    let previousPeriodMatches = true;
    for (let offset = 0; offset < periodTokens; offset += 1) {
      if (tokens[repeatedRunStartIndex - periodTokens + offset]?.value !== tokens[repeatedRunStartIndex + offset]?.value) {
        previousPeriodMatches = false;
        break;
      }
    }
    if (!previousPeriodMatches) {
      break;
    }
    repeatedRunStartIndex -= periodTokens;
  }
  const repeatedRunTokens = tokens.length - repeatedRunStartIndex;
  if (repeatedRunTokens < minRepeatedRunTokens) {
    return null;
  }

  return {
    totalTokens: tokens.length,
    windowTokens,
    periodTokens,
    repeatedRunTokens,
    repeatedTokens,
    truncatedText: String(text || '').slice(0, tokens[repeatedRunStartIndex]?.startIndex || 0).trimEnd(),
  };
}
