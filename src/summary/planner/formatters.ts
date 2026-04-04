import { getRecord } from './json-filter.js';

export const MAX_PLANNER_TOOL_RESULT_CHARACTERS = 12_000;

export function truncatePlannerText(text: string): string {
  if (text.length <= MAX_PLANNER_TOOL_RESULT_CHARACTERS) {
    return text;
  }

  return `${text.slice(0, MAX_PLANNER_TOOL_RESULT_CHARACTERS)}\n... [truncated ${text.length - MAX_PLANNER_TOOL_RESULT_CHARACTERS} chars]`;
}

export function formatNumberedLineBlock(lines: string[], startLine: number): string {
  return lines
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n');
}

export function formatCompactJsonBlock(values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n');
}

export function formatPlannerToolResultHeader(value: Record<string, unknown>): string | null {
  const tool = typeof value.tool === 'string' ? value.tool : '';
  if (tool === 'read_lines') {
    return `read_lines startLine=${value.startLine} endLine=${value.endLine} lineCount=${value.lineCount}`;
  }
  if (tool === 'find_text') {
    return `find_text mode=${value.mode} query=${JSON.stringify(value.query)} hitCount=${value.hitCount}`;
  }
  if (tool === 'json_filter') {
    const base = `json_filter collectionPath=${value.collectionPath} matchedCount=${value.matchedCount}`;
    const usedFallback = value.usedFallback === true;
    if (!usedFallback) {
      return base;
    }
    const ignoredPrefixPreview = typeof value.ignoredPrefixPreview === 'string'
      ? value.ignoredPrefixPreview
      : '';
    const parsedSectionPreview = typeof value.parsedSectionPreview === 'string'
      ? value.parsedSectionPreview
      : '';
    return `${base}\njson_filter ignored "${ignoredPrefixPreview}" due to not being valid json, here is the parsed valid section: "${parsedSectionPreview}"`;
  }
  return null;
}

export function formatPlannerResult(value: unknown): string {
  const record = getRecord(value);
  if (record && typeof record.text === 'string') {
    const header = formatPlannerToolResultHeader(record);
    return truncatePlannerText(header ? `${header}\n${record.text}` : record.text);
  }
  return truncatePlannerText(JSON.stringify(value, null, 2));
}

export function formatPlannerToolResultTokenGuardError(resultTokens: number): string {
  return `Error: tool call results in ${resultTokens} tokens (more than 70% of remaining tokens). Try again with a more limited tool call)`;
}
