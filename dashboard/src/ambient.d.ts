declare module 'react-markdown' {
  import * as React from 'react';
  const ReactMarkdown: React.ComponentType<{
    children?: string;
    remarkPlugins?: unknown[];
  }>;
  export default ReactMarkdown;
}

declare module 'remark-gfm' {
  const remarkGfm: unknown;
  export default remarkGfm;
}
