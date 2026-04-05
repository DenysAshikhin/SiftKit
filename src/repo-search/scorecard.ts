export function getOutputCharacterCount(scorecard: unknown): number {
  const tasks = (
    scorecard
    && typeof scorecard === 'object'
    && !Array.isArray(scorecard)
    && Array.isArray((scorecard as { tasks?: unknown }).tasks)
  )
    ? (scorecard as { tasks: Array<{ finalOutput?: unknown }> }).tasks
    : [];
  if (tasks.length === 0) {
    return 0;
  }
  const outputText = tasks
    .map((task) => (typeof task?.finalOutput === 'string' ? task.finalOutput.trim() : ''))
    .filter((value) => value.length > 0)
    .join('\n\n');
  return outputText.length;
}

export function getNumericTotal(scorecard: unknown, key: string): number | null {
  if (!scorecard || typeof scorecard !== 'object' || Array.isArray(scorecard)) {
    return null;
  }
  const totals = (scorecard as { totals?: unknown }).totals;
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) {
    return null;
  }
  const rawValue = (totals as Record<string, unknown>)[key];
  return Number.isFinite(rawValue) && Number(rawValue) >= 0 ? Number(rawValue) : null;
}
