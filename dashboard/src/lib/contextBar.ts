import { formatNumber } from './format';

export type ContextBarVisual = {
  ratio: number;
  percent: number;
  fillColor: string;
  titleText: string;
};

export function computeContextBarVisual(used: number, total: number): ContextBarVisual {
  const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
  const percent = ratio * 100;
  const hue = 120 - 120 * ratio;
  const fillColor = `hsl(${hue}, 70%, 45%)`;
  const titleText = `${formatNumber(used)} / ${formatNumber(total)} (${(ratio * 100).toFixed(1)}% used)`;
  return { ratio, percent, fillColor, titleText };
}
