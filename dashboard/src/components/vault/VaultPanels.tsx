import type {
  VaultNoteDetail, VaultNoteSummary, VaultRevision, VaultRevisionSummary, VaultReview, VaultStats,
} from '@siftkit/contracts';
import { vaultKey } from '@siftkit/contracts';

import { diffRows, lineDiff } from '../../lib/vault-diff.ts';
import { actorClass, outlineOf } from '../../lib/vault-edits.ts';
import { ago, fmtTime } from '../../lib/vault-time.ts';
import { Inline, NoteMarkdown } from './NoteMarkdown.tsx';
import { ContextCard } from './NoteView.tsx';
import type { VaultActions } from './vault-actions.ts';

const LINKED_SHOWN = 80;
const OUTGOING_SHOWN = 60;
const REVISIONS_SHOWN = 200;
const PREVIEW_LINES = 14;
const REVIEW_SHOWN = 300;
const num = (value: number) => value.toLocaleString('en-US');
const noLinks = { unresolved: new Set<string>(), colors: new Map<string, string>(), noteId: null };

export function VaultStatsPanel(props: { readonly stats: VaultStats | null }) {
  const { stats } = props;
  if (stats === null) return <div className="v-empty">Loading…</div>;
  return (
    <>
      <div className="v-rsec">
        <h4>Vault</h4>
        <div className="v-stat-grid">
          <div className="v-stat"><b>{num(stats.notes)}</b><small>notes</small></div>
          <div className="v-stat"><b>{num(stats.links)}</b><small>links</small></div>
          <div className="v-stat"><b>{num(stats.tags)}</b><small>tags</small></div>
          <div className="v-stat"><b>{num(stats.notesWithUnverified)}</b><small>notes with unverified facts</small></div>
          <div className="v-stat"><b>{num(stats.stubs)}</b><small>link-only notes</small></div>
        </div>
      </div>
      <div className="v-rsec">
        <h4>Validation</h4>
        <div className="v-stat-grid">
          <div className="v-stat"><b>{num(stats.validation.queueDepth)}</b><small>notes awaiting validation</small></div>
          <div className="v-stat"><b>{stats.validation.oldestValidatedAtUtc?.slice(0, 10) ?? 'never'}</b><small>oldest validation</small></div>
        </div>
      </div>
      <div className="v-rsec">
        <h4>By kind</h4>
        <div className="v-stat-grid">
          {Object.entries(stats.byKind).map(([kind, count]) => <div key={kind} className="v-stat"><b>{num(count)}</b><small>{kind}</small></div>)}
        </div>
      </div>
    </>
  );
}

export interface LinksPanelProps {
  readonly detail: VaultNoteDetail;
  readonly unlinked: readonly VaultNoteSummary[] | null;
  readonly colors: ReadonlyMap<string, string>;
  readonly actions: VaultActions;
}

export function LinksPanel(props: LinksPanelProps) {
  const { detail, unlinked, colors, actions } = props;
  const linked = detail.backlinks.slice(0, LINKED_SHOWN);
  const outgoing = detail.outgoing.resolved;
  return (
    <>
      <div className="v-rsec">
        <h4>Linked mentions <span>{num(detail.backlinks.length)}</span></h4>
        {linked.length === 0 ? <div className="v-hint">Nothing links here yet.</div> : linked.map((backlink) => (
          <div key={backlink.note.id} className="v-bl">
            <div className="v-src" onClick={(event) => actions.openNote(backlink.note.id, event.ctrlKey || event.metaKey)}>
              <span className="v-dot" style={{ background: colors.get(vaultKey(backlink.note.title)) }} />{backlink.note.title}
            </div>
            {backlink.labels.length > 0 && <div className="v-bl-ctx">{backlink.labels.map((label) => <span key={label} className="v-mini-label">{label}</span>)}</div>}
          </div>
        ))}
        {detail.backlinks.length > linked.length && <div className="v-hint">+ {num(detail.backlinks.length - linked.length)} more notes</div>}
      </div>
      <div className="v-rsec">
        <h4>Outgoing links <span>{num(outgoing.length)}</span></h4>
        <div className="v-chips">
          {outgoing.slice(0, OUTGOING_SHOWN).map((note) => <span key={note.id} className="v-chip" onClick={() => actions.openNote(note.id, false)}>{note.title}</span>)}
          {outgoing.length > OUTGOING_SHOWN && <small className="v-hint">+{outgoing.length - OUTGOING_SHOWN}</small>}
        </div>
      </div>
      <div className="v-rsec">
        <h4>Unlinked mentions <span>{unlinked === null ? '…' : num(unlinked.length)}</span></h4>
        {unlinked !== null && unlinked.length === 0 && <div className="v-hint">None.</div>}
        {unlinked?.map((note) => (
          <div key={note.id} className="v-bl">
            <div className="v-src" onClick={() => actions.openNote(note.id, false)}>
              {note.title}
              <small><a className="v-wl" onClick={(event) => { event.stopPropagation(); actions.linkMention(note.id, detail.note.title); }}>link it</a></small>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function OutlinePanel(props: { readonly body: string; readonly actions: VaultActions }) {
  const entries = outlineOf(props.body);
  return (
    <div className="v-rsec">
      <h4>Outline <span>{entries.length}</span></h4>
      <div className="v-outline">
        {entries.length === 0 ? <div className="v-hint">No headings.</div> : entries.map((entry) => (
          <div key={entry.line} style={{ paddingLeft: (entry.level - 1) * 10 + 6 }} onClick={() => props.actions.jumpTo(entry.line)}>
            {entry.text}<small>{entry.items || ''}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface HistoryPanelProps {
  readonly noteId: string;
  readonly revisions: readonly VaultRevisionSummary[] | null;
  readonly selected: number | null;
  readonly nowMs: number;
  readonly actions: VaultActions;
}

export function HistoryPanel(props: HistoryPanelProps) {
  const { noteId, revisions, selected, nowMs, actions } = props;
  if (revisions === null) return <div className="v-empty">Loading…</div>;
  const newestFirst = [...revisions].sort((left, right) => right.revision - left.revision).slice(0, REVISIONS_SHOWN);
  return (
    <>
      <div className="v-rsec">
        <h4>Revisions <span>{revisions.length}</span></h4>
        {newestFirst.map((revision) => (
          <div key={revision.revision} className={`v-rev ${actorClass(revision.actor)}${selected === revision.revision ? ' v-sel' : ''}`} onClick={() => actions.openDiff(noteId, revision.revision)}>
            <span className="v-pip" />
            <div>
              <div className="v-who">r{revision.revision} · {revision.actor}</div>
              <div className="v-what">{revision.summary}</div>
              <div className="v-when">{fmtTime(revision.createdAtUtc)} · {ago(revision.createdAtUtc, nowMs)}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="v-hint">Every write is a revision: the migration, background note-writer jobs, tidy passes, and your own edits. Click one to see its diff and restore it.</div>
    </>
  );
}

export interface DiffViewProps {
  readonly noteId: string;
  readonly title: string;
  readonly revision: VaultRevision;
  /** The previous revision's body, or `null` for the first revision. */
  readonly before: string | null;
  readonly isCurrent: boolean;
  readonly actions: VaultActions;
}

export function DiffView(props: DiffViewProps) {
  const { noteId, title, revision, before, isCurrent, actions } = props;
  const ops = lineDiff(before === null ? [] : before.split('\n'), revision.body.split('\n'));
  const rows = diffRows(ops, before !== null);
  const added = ops.filter((op) => op.kind === 'add').length;
  const removed = ops.filter((op) => op.kind === 'del').length;
  return (
    <article className="v-note">
      <div className="v-crumbs"><span>{title}</span><span className="v-sep">/</span><span>history</span></div>
      <div className="v-diff-head">
        <h2>r{revision.revision} · {revision.actor}</h2>
        <button type="button" className="v-btn" onClick={() => actions.openNote(noteId, false)}>Open note</button>
        {isCurrent ? <span className="v-chip">current</span> : <button type="button" className="v-btn v-danger" onClick={() => actions.restore(noteId, revision.revision)}>Restore this version</button>}
      </div>
      <p className="v-hint">
        {fmtTime(revision.createdAtUtc)} · {revision.summary} · <span className="v-plus">+{added}</span> <span className="v-minus">−{removed}</span>
      </p>
      <div className="v-diff">
        {rows.map((row, index) => (row.kind === 'gap' ? <div key={index} className="v-gap">⋯</div> : <div key={index} className={`v-${row.kind}`}>{row.text || ' '}</div>))}
      </div>
    </article>
  );
}

export function ReviewView(props: { readonly review: VaultReview | null; readonly stats: VaultStats | null; readonly actions: VaultActions }) {
  const { review, stats, actions } = props;
  if (review === null) return <div className="v-empty">Loading…</div>;
  const ctx = { ...noLinks, actions };
  return (
    <article className="v-note">
      <div className="v-crumbs"><span>vault</span><span className="v-sep">/</span><span>review</span></div>
      <div className="v-note-head"><h1>Review</h1></div>
      <p className="v-hint">Facts tagged <span className="v-tag v-t-unverified">#unverified</span> wait for you. Keep moves the fact into its row, swaps it in for the value a conflict replaces, or confirms a doubted value. Drop removes the flag, and for a doubt the value too. Both create a revision.</p>
      <div className="v-stat-grid" style={{ margin: '12px 0 18px' }}>
        <div className="v-stat"><b>{num(review.total)}</b><small>unverified facts</small></div>
        <div className="v-stat"><b>{num(stats?.notesWithUnverified ?? 0)}</b><small>notes with unverified facts</small></div>
        <div className="v-stat"><b>{num(stats?.validation.queueDepth ?? 0)}</b><small>notes awaiting validation</small></div>
      </div>
      <div className="v-md">
        <ul>
          {review.items.slice(0, REVIEW_SHOWN).map((item) => (
            <li key={`${item.note.id}:${item.line}`} className="v-unverified">
              <a className="v-wl" onClick={() => actions.openNote(item.note.id, false)}>{item.note.title}</a>{' · '}
              {item.label !== null && <span className="v-mini-label">{item.label}</span>}
              <Inline text={item.value} ctx={ctx} />
              {item.flag !== null && <small className="v-flag">{item.flag.kind === 'replaces' ? ` replaces ${item.flag.value}` : ` doubt: ${item.flag.reason}`}</small>}
              <span className="v-actions v-always">
                <button type="button" onClick={() => actions.triage(item.note.id, item.line, 'confirm')}>✓</button>
                <button type="button" onClick={() => actions.triage(item.note.id, item.line, 'drop')}>✕</button>
              </span>
            </li>
          ))}
        </ul>
        {review.total > REVIEW_SHOWN && <div className="v-long-note">{num(review.total - REVIEW_SHOWN)} more — filter with <code>tag:#unverified</code> in search.</div>}
      </div>
    </article>
  );
}

export interface GraphPreviewProps {
  readonly detail: VaultNoteDetail | null;
  readonly degree: number;
  readonly stats: VaultStats | null;
  readonly colors: ReadonlyMap<string, string>;
  readonly nowMs: number;
  readonly actions: VaultActions;
}

/** Graph-view side panel: a single click previews a note here, a double click opens it. */
export function GraphPreview(props: GraphPreviewProps) {
  const { detail, degree, stats, colors, nowMs, actions } = props;
  if (detail === null) {
    return <><div className="v-empty">Click a node to preview it here.<br />Double-click opens the note.</div><VaultStatsPanel stats={stats} /></>;
  }
  const { note } = detail;
  return (
    <div className="v-preview-card">
      <div className="v-crumbs">{note.folder || 'vault'}</div>
      <h2>{note.title}</h2>
      <div className="v-aka" style={{ margin: '0 0 8px' }}>{num(degree)} links · updated {ago(note.updatedAtUtc, nowMs)}</div>
      <NoteMarkdown body={note.body} unresolved={new Set(detail.outgoing.unresolved.map(vaultKey))} colors={colors} limit={PREVIEW_LINES} full={false} noteId={null} actions={actions} />
      {note.isStub && <ContextCard backlinks={detail.backlinks} colors={colors} actions={actions} />}
      <button type="button" className="v-btn v-primary v-wide" onClick={() => actions.openNote(note.id, false)}>Open note</button>
    </div>
  );
}
