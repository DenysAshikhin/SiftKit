const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
/** A blank line before a list item may continue a loose list, so it is never a block boundary. */
const LIST_ITEM_PATTERN = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/u;
/**
 * Constructs that bind across blank lines: link reference and footnote definitions resolve
 * document-wide, and HTML blocks of CommonMark types 1-5 may contain blank lines.
 */
const CROSS_BLOCK_PATTERN = /^ {0,3}(?:\[[^\]\n]+\]:|<(?:pre|script|style|textarea)(?:[\s>]|$)|<!--|<\?|<![A-Za-z[])/imu;

/** The top-level blocks and whether the last one is still inside an unclosed code fence. */
function scanMarkdownBlocks(markdown: string): { blocks: string[]; inFence: boolean } {
  if (CROSS_BLOCK_PATTERN.test(markdown)) {
    return { blocks: [markdown], inFence: false };
  }
  const blocks: string[] = [];
  let current: string[] = [];
  let hasContent = false;
  let previousBlank = false;
  let openFence: string | null = null;
  for (const line of markdown.split('\n')) {
    if (openFence === null && previousBlank && hasContent && /^\S/u.test(line) && !LIST_ITEM_PATTERN.test(line)) {
      blocks.push(current.join('\n'));
      current = [];
    }
    const fence = FENCE_PATTERN.exec(line)?.[1] ?? null;
    if (openFence === null) {
      openFence = fence;
    } else if (fence !== null && fence[0] === openFence[0] && fence.length >= openFence.length && line.trim() === fence) {
      openFence = null;
    }
    current.push(line);
    hasContent ||= line.trim() !== '';
    previousBlank = openFence === null && line.trim() === '';
  }
  blocks.push(current.join('\n'));
  return { blocks, inFence: openFence !== null };
}

/**
 * Splits markdown into top-level blocks that render exactly as the whole document does, so a streamed
 * answer's finished blocks keep identical text and only the growing tail needs re-parsing. Text whose
 * blocks could interact across a boundary stays whole.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  return scanMarkdownBlocks(markdown).blocks;
}

/** Where a streamed prefix's last, still-growing block starts (after its separating newline), and whether it is an open fence. */
export function streamTailStart(markdown: string): { start: number; inFence: boolean } {
  const { blocks, inFence } = scanMarkdownBlocks(markdown);
  return { start: blocks.slice(0, -1).reduce((offset, block) => offset + block.length + 1, 0), inFence };
}
