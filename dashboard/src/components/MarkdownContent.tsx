import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitMarkdownBlocks } from '../lib/markdown-blocks';

const REMARK_PLUGINS = [remarkGfm];

/** Memoized on content: streaming re-renders the transcript, and re-parsing unchanged markdown dominates that cost. */
export const MarkdownContent = React.memo(function MarkdownContent({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{content}</ReactMarkdown>;
});

/** Same output as MarkdownContent, parsed per top-level block so a growing answer re-parses only its tail. */
export function MarkdownBlocks({ content }: { content: string }) {
  const blocks = React.useMemo(() => splitMarkdownBlocks(content), [content]);
  // Blocks only ever append or grow at the end, so a position is a stable identity.
  return blocks.map((block, index) => <MarkdownContent key={index} content={block} />);
}
