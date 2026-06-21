import type { Scorecard } from './engine.js';

export function getOutputCharacterCount(scorecard: Scorecard): number {
  const outputText = scorecard.tasks
    .map((task) => (typeof task.finalOutput === 'string' ? task.finalOutput.trim() : ''))
    .filter((value) => value.length > 0)
    .join('\n\n');
  return outputText.length;
}

export function getNumericTotal(scorecard: Scorecard, key: string): number | null {
  const rawValue = scorecard.totals[key];
  return Number.isFinite(rawValue) && Number(rawValue) >= 0 ? Number(rawValue) : null;
}
