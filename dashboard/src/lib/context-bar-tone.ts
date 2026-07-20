export function getContextBarFillTone(usedRatio: number): 'accent' | 'warn' {
  return usedRatio >= 0.85 ? 'warn' : 'accent';
}
