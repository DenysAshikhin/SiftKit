// Re-exports from shared lib for status-server backwards compatibility.
export {
  type ColorOptions,
  formatTimestamp,
  formatElapsed,
  formatGroupedNumber,
  formatInteger,
  formatMilliseconds,
  formatSeconds,
  formatPercentage,
  formatRatio,
  formatTokensPerSecond,
  supportsAnsiColor,
  colorize,
} from '../lib/text-format.js';
