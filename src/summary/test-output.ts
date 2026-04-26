export type DeterministicTestSummary = {
  verdict: 'PASS' | 'FAIL';
  summary: string;
};

function uniqueLimited(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/gu, ' ').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function extractPrefixedLines(lines: string[], pattern: RegExp): string[] {
  return uniqueLimited(lines.flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [match[1].trim()] : [];
  }), 8);
}

function extractImportantLines(lines: string[]): string[] {
  return uniqueLimited(lines.filter((line) => (
    /^\s*(?:Error|Warning|TypeError|AssertionError|ReferenceError|SyntaxError):/u.test(line)
    || /\b(?:error|warning|failed|exception|timed out|timeout)\b/iu.test(line)
    || /^\s*●\s+/u.test(line)
  )), 10);
}

function getSummaryLine(lines: string[], label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`^\\s*${escapedLabel}:\\s+(.+)$`, 'u');
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) {
      return `${label}: ${match[1].trim()}`;
    }
  }
  return null;
}

export function parseDeterministicTestOutput(options: {
  inputText: string;
  commandExitCode?: number | null;
}): DeterministicTestSummary | null {
  const lines = options.inputText.split(/\r?\n/gu);
  const hasJestSignals = lines.some((line) => /^\s*(?:PASS|FAIL)\s+\S+/u.test(line))
    || lines.some((line) => /^\s*Test Suites:\s+/u.test(line))
    || lines.some((line) => /^\s*Tests:\s+/u.test(line));
  if (!hasJestSignals) {
    return null;
  }

  const failedSuites = extractPrefixedLines(lines, /^\s*FAIL\s+(.+)$/u);
  const passedSuites = extractPrefixedLines(lines, /^\s*PASS\s+(.+)$/u);
  const failedTests = extractPrefixedLines(lines, /^\s*●\s+(.+)$/u);
  const importantLines = extractImportantLines(lines);
  const suiteSummary = getSummaryLine(lines, 'Test Suites');
  const testSummary = getSummaryLine(lines, 'Tests');
  const warningSummary = getSummaryLine(lines, 'Warnings');
  const exitFailed = Number.isFinite(options.commandExitCode) && Number(options.commandExitCode) !== 0;
  const textFailed = failedSuites.length > 0
    || failedTests.length > 0
    || /\b(?:[1-9]\d*)\s+failed\b/iu.test(`${suiteSummary || ''}\n${testSummary || ''}`);
  const verdict: 'PASS' | 'FAIL' = exitFailed || textFailed ? 'FAIL' : 'PASS';
  const parts: string[] = [];

  if (suiteSummary) {
    parts.push(suiteSummary);
  }
  if (testSummary) {
    parts.push(testSummary);
  }
  if (warningSummary) {
    parts.push(warningSummary);
  }
  if (failedSuites.length > 0) {
    parts.push(`Failing suites: ${failedSuites.join('; ')}`);
  } else if (passedSuites.length > 0 && verdict === 'PASS') {
    parts.push(`Passing suites: ${passedSuites.join('; ')}`);
  }
  if (failedTests.length > 0) {
    parts.push(`Failing tests: ${failedTests.join('; ')}`);
  }
  if (importantLines.length > 0) {
    parts.push(`Warnings/errors: ${importantLines.join('; ')}`);
  } else {
    parts.push('Warnings/errors: none detected');
  }

  return {
    verdict,
    summary: `${verdict}: ${parts.join(' | ')}`,
  };
}
