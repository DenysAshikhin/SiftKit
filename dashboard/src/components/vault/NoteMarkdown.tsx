import type { MouseEvent, ReactNode } from 'react';
import { vaultKey } from '@siftkit/contracts';

import { noteBlocks, type VaultBlock, type VaultListItem } from '../../lib/vault-blocks.ts';
import { inlineTokens, pillValue } from '../../lib/vault-inline.ts';
import type { VaultActions } from './vault-actions.ts';

const RESOLVED_FALLBACK_COLOR = '#2fbfa0';
const UNRESOLVED_COLOR = '#3a4c61';

export interface NoteMarkdownProps {
  readonly body: string;
  /** Vault keys of link targets that no note owns. */
  readonly unresolved: ReadonlySet<string>;
  /** Folder colour by vault key of a note title. */
  readonly colors: ReadonlyMap<string, string>;
  readonly limit: number;
  readonly full: boolean;
  /** The note being edited in place; `null` renders a read-only preview. */
  readonly noteId: string | null;
  readonly actions: VaultActions;
}

type RenderContext = Omit<NoteMarkdownProps, 'body' | 'limit' | 'full'>;

const anchorRect = (event: MouseEvent<HTMLElement>) => event.currentTarget.getBoundingClientRect();

function WikiLink(props: { readonly target: string; readonly label: string | null; readonly pill: boolean; readonly ctx: RenderContext }) {
  const { target, label, pill, ctx } = props;
  const key = vaultKey(target);
  const unresolved = ctx.unresolved.has(key);
  const handlers = {
    'data-link': target,
    onClick: (event: MouseEvent<HTMLElement>) => { ctx.actions.clearHover(); ctx.actions.followLink(target, event.ctrlKey || event.metaKey); },
    onMouseEnter: (event: MouseEvent<HTMLElement>) => { if (!unresolved) ctx.actions.hoverLink(target, anchorRect(event)); },
    onMouseLeave: () => ctx.actions.clearHover(),
  };
  if (!pill) return <a className={`v-wl${unresolved ? ' v-unresolved' : ''}`} {...handlers}>{label ?? target}</a>;
  const color = unresolved ? UNRESOLVED_COLOR : ctx.colors.get(key) ?? RESOLVED_FALLBACK_COLOR;
  return <a className={`v-pill${unresolved ? ' v-unresolved' : ''}`} {...handlers}><i style={{ background: color }} />{label ?? target}</a>;
}

export function Inline(props: { readonly text: string; readonly ctx: RenderContext }) {
  return inlineTokens(props.text).map((token, index): ReactNode => {
    if (token.kind === 'link') {
      return token.embed
        ? <a key={index} className="v-wl" data-link={token.target}>⤷ {token.target}</a>
        : <WikiLink key={index} target={token.target} label={token.label} pill={false} ctx={props.ctx} />;
    }
    if (token.kind === 'tag') {
      return <span key={index} className={`v-tag v-t-${token.tag}`} onClick={() => props.ctx.actions.searchTag(token.tag)}>#{token.tag}</span>;
    }
    if (token.kind === 'code') return <code key={index}>{token.text}</code>;
    if (token.kind === 'bold') return <b key={index}>{token.text}</b>;
    if (token.kind === 'italic') return <i key={index}>{token.text}</i>;
    if (token.kind === 'dim') return <span key={index} className="v-em-dim">{token.text}</span>;
    return token.text;
  });
}

export function PillList(props: { readonly values: readonly string[]; readonly ctx: RenderContext }) {
  return props.values.map((value, index) => {
    const pill = pillValue(value);
    return pill.kind === 'link'
      ? <WikiLink key={index} target={pill.target} label={pill.label} pill ctx={props.ctx} />
      : <span key={index} className="v-pill v-txt"><Inline text={pill.text} ctx={props.ctx} /></span>;
  });
}

function ListItem(props: { readonly item: VaultListItem; readonly ctx: RenderContext }) {
  const { item, ctx } = props;
  const { noteId, actions } = ctx;
  if (item.kind === 'task') {
    return (
      <li className={`v-task${item.done ? ' v-done' : ''}`}>
        <input type="checkbox" checked={item.done} disabled={noteId === null} onChange={() => { if (noteId !== null) actions.toggleTask(noteId, item.line); }} />{' '}
        <Inline text={item.text} ctx={ctx} />
      </li>
    );
  }
  return (
    <li className={item.unverified ? 'v-unverified' : undefined}>
      {item.label !== null && <span className="v-mini-label">{item.label}</span>}
      <Inline text={item.text} ctx={ctx} />
      {item.unverified && noteId !== null && (
        <span className="v-actions">
          <button type="button" onClick={() => actions.triage(noteId, item.line, 'confirm')}>✓ keep</button>
          <button type="button" onClick={() => actions.triage(noteId, item.line, 'drop')}>✕ drop</button>
        </span>
      )}
    </li>
  );
}

const fileName = (target: string) => target.split('/').at(-1) ?? target;

function Block(props: { readonly block: VaultBlock; readonly ctx: RenderContext }) {
  const { block, ctx } = props;
  switch (block.kind) {
    case 'paragraph':
      return <p className={block.lead ? 'v-lead' : undefined}><Inline text={block.text} ctx={ctx} /></p>;
    case 'facts':
      return (
        <div className="v-facts">
          {block.rows.map((row) => (
            <div key={row.line} className="v-frow"><span className="v-flabel">{row.label}</span><span className="v-fvals"><PillList values={row.values} ctx={ctx} /></span></div>
          ))}
        </div>
      );
    case 'heading': {
      const Heading = block.level === 2 ? 'h2' : 'h3';
      return <Heading id={`v-h-${block.line}`}><Inline text={block.text} ctx={ctx} /></Heading>;
    }
    case 'list':
      return <ul>{block.items.map((item) => <ListItem key={item.line} item={item} ctx={ctx} />)}</ul>;
    case 'callout': {
      const head = <><span className="v-co-kind">{block.calloutKind}</span> <Inline text={block.title} ctx={ctx} /></>;
      const parts = block.parts.map((part, index) => (part.kind === 'list'
        ? <ul key={index}>{part.items.map((item) => <ListItem key={item.line} item={item} ctx={ctx} />)}</ul>
        : <p key={index} className="v-pills"><PillList values={part.values} ctx={ctx} /></p>));
      const className = `v-callout v-co-${block.calloutKind}`;
      if (block.fold === '') return <div className={className}><div className="v-co-head">{head}</div>{parts}</div>;
      return <details className={className} open={block.fold === '+'}><summary className="v-co-head">{head}</summary>{parts}</details>;
    }
    case 'quote':
      return <blockquote>{block.lines.map((line, index) => <div key={index}><Inline text={line} ctx={ctx} /></div>)}</blockquote>;
    case 'embeds':
      if (block.targets.length === 1) {
        const target = block.targets[0] ?? '';
        return <div className="v-embed"><div className="v-embed-art">🖼</div><div className="v-cap"><span>📎 {target}</span></div></div>;
      }
      return <div className="v-thumbs">{block.targets.map((target) => <div key={target} className="v-thumb" title={target}>🖼 {fileName(target)}</div>)}</div>;
    case 'fence':
      return <pre><code>{block.text}</code></pre>;
    case 'more':
      return ctx.noteId === null ? null : (
        <div className="v-long-note">{block.remaining.toLocaleString('en-US')} more lines. <a className="v-wl" onClick={() => ctx.actions.showFull()}>Show everything</a></div>
      );
  }
}

/** Renders a note body in the vault dialect: lead, fact pills, foldable callouts, tasks, triage and embeds. */
export function NoteMarkdown(props: NoteMarkdownProps) {
  const { body, limit, full, ...ctx } = props;
  return <div className="v-md">{noteBlocks(body, { limit, full }).map((block, index) => <Block key={index} block={block} ctx={ctx} />)}</div>;
}
