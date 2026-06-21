// Third-party module shims: react-markdown's plugin array and remark-gfm's
// default export are opaque plugin values, so `unknown` is the honest type.
declare module 'react-markdown' {
  import type { ComponentType } from 'react';
  const ReactMarkdown: ComponentType<{
    children?: string;
    remarkPlugins?: unknown[];
  }>;
  export default ReactMarkdown;
}

declare module 'remark-gfm' {
  const remarkGfm: unknown;
  export default remarkGfm;
}
