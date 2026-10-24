import { FileTree } from '../components/vault/FileTree.tsx';
import { GraphView, LocalGraph } from '../components/vault/GraphView.tsx';
import { NoteView } from '../components/vault/NoteView.tsx';
import { SearchPanel } from '../components/vault/SearchPanel.tsx';
import { HoverCard, QuickSwitcher, StatusBar } from '../components/vault/VaultChrome.tsx';
import {
  DiffView, GraphPreview, HistoryPanel, LinksPanel, OutlinePanel, ReviewView, VaultStatsPanel,
} from '../components/vault/VaultPanels.tsx';
import type { VaultRightTab } from '../components/vault/vault-actions.ts';
import { diffKey, type VaultTabProps } from '../hooks/useVaultController.ts';
import { tabLabel } from '../lib/vault-tabs.ts';

const RIGHT_TABS: readonly (readonly [VaultRightTab, string])[] = [
  ['links', 'Links'], ['outline', 'Outline'], ['graph', 'Local graph'], ['history', 'History'], ['vault', 'Vault'],
];

const Loading = () => <div className="v-empty">Loading…</div>;

function LeftBody(props: VaultTabProps) {
  const { search, side, searchResult, actions, tabs } = props;
  if (search.trim().length > 0 || side === 'search') return <SearchPanel query={search} result={searchResult} actions={actions} />;
  const active = tabs.tabs[tabs.active];
  return (
    <FileTree
      folders={props.folders} folderNotes={props.folderNotes} expanded={props.expanded} starred={props.starred} showStubs={props.showStubs}
      stubCount={props.stats?.stubs ?? 0} activeNoteId={active?.kind === 'note' ? active.noteId : null} actions={actions}
    />
  );
}

function CenterView(props: VaultTabProps) {
  const { tabs, details, actions } = props;
  const tab = tabs.tabs[tabs.active];
  if (tab === undefined) return <div className="v-empty">No note open. Press Ctrl+O to find one.</div>;
  if (tab.kind === 'graph') {
    return (
      <GraphView
        graph={props.index} colors={props.folderColorMap} options={props.graphOptions} selectedId={props.graphSelection}
        positions={props.positions} layoutSeed={props.layoutSeed} actions={actions}
      />
    );
  }
  if (tab.kind === 'review') return <ReviewView review={props.review} stats={props.stats} actions={actions} />;
  const detail = details.get(tab.noteId);
  if (tab.kind === 'diff') {
    const diff = props.diffs.get(diffKey(tab.noteId, tab.revision));
    if (diff === undefined || detail === undefined) return <Loading />;
    return (
      <DiffView
        noteId={tab.noteId} title={detail.note.title} revision={diff.revision} before={diff.before}
        isCurrent={diff.revision.revision === detail.note.revision} actions={actions}
      />
    );
  }
  if (detail === undefined) return <Loading />;
  return (
    <NoteView
      key={tab.noteId} detail={detail} mode={tab.mode} full={tab.full} colors={props.noteColors}
      entries={props.index.nodes} nowMs={props.nowMs} actions={actions}
    />
  );
}

function RightBody(props: VaultTabProps) {
  const { right, tabs, details, actions } = props;
  const tab = tabs.tabs[tabs.active];
  if (right === 'vault') return <VaultStatsPanel stats={props.stats} />;
  if (tab?.kind === 'graph') {
    const selected = props.graphSelection;
    return (
      <GraphPreview
        detail={selected === null ? null : details.get(selected) ?? null} degree={selected === null ? 0 : props.degrees.get(selected) ?? 0}
        stats={props.stats} colors={props.noteColors} nowMs={props.nowMs} actions={actions}
      />
    );
  }
  const noteId = tab?.kind === 'note' || tab?.kind === 'diff' ? tab.noteId : null;
  if (noteId === null) return <div className="v-empty">Open a note to see its links, outline and history.</div>;
  const detail = details.get(noteId);
  if (detail === undefined) return <Loading />;
  if (right === 'links') return <LinksPanel detail={detail} unlinked={props.unlinked} colors={props.noteColors} actions={actions} />;
  if (right === 'outline') return <OutlinePanel body={detail.note.body} actions={actions} />;
  if (right === 'history') {
    return (
      <HistoryPanel
        noteId={noteId} revisions={props.revisions.get(noteId) ?? null} selected={tab?.kind === 'diff' ? tab.revision : null}
        nowMs={props.nowMs} actions={actions}
      />
    );
  }
  return <LocalGraph graph={props.localGraph} colors={props.folderColorMap} centerId={noteId} depth={props.localDepth} actions={actions} />;
}

/** The Memory tab: an Obsidian-style vault over `/assistant/vault/*`, opening on the graph. */
export function VaultTab(props: VaultTabProps) {
  const { error, side, search, tabs, titles, right, actions, toast, hover } = props;
  if (error !== null) return <div className="vault"><div className="v-empty">{error}</div></div>;
  const active = tabs.tabs[tabs.active];
  const activeDetail = active?.kind === 'note' ? props.details.get(active.noteId) : undefined;

  return (
    <div className="vault">
      <div className="v-main">
        <nav className="v-ribbon">
          <button type="button" className={side === 'files' ? 'v-on' : undefined} title="Files" onClick={() => actions.setSide('files')}>🗂</button>
          <button type="button" className={side === 'search' ? 'v-on' : undefined} title="Search (Ctrl+Shift+F)" onClick={() => actions.setSide('search')}>⌕</button>
          <button type="button" title="Graph view (Ctrl+G)" onClick={() => actions.openGraph()}>◎</button>
          <button type="button" title="Today's daily note" onClick={() => actions.openDaily()}>☀</button>
          <button type="button" title="Review unverified facts" onClick={() => actions.openReview()}>✓</button>
          <div className="v-grow" />
          <button type="button" title="New note" onClick={() => actions.newNote()}>＋</button>
          <button type="button" title="Quick switcher (Ctrl+O)" onClick={() => actions.openPalette()}>⌘</button>
        </nav>
        <aside className="v-left">
          <div className="v-pane-head">
            <h3>{side === 'search' ? 'Search' : 'Vault'}</h3>
            <button type="button" className="v-icon-btn" title="Collapse all" onClick={() => actions.collapseAll()}>⊟</button>
          </div>
          <div className="v-search">
            <input ref={props.searchInput} placeholder="Search notes…  (tag:#unverified, path:Software)" value={search} onChange={(event) => actions.setSearch(event.target.value)} />
          </div>
          <div className="v-scroll"><LeftBody {...props} /></div>
        </aside>
        <main className="v-center">
          <div className="v-tabbar">
            {tabs.tabs.map((tab, index) => (
              <div key={index} className={`v-tab${index === tabs.active ? ' v-active' : ''}`} onClick={() => actions.activateTab(index)}>
                <span>{tabLabel(tab, titles)}</span>
                <button type="button" className="v-x" onClick={(event) => { event.stopPropagation(); actions.closeTab(index); }}>×</button>
              </div>
            ))}
          </div>
          <div className="v-view"><CenterView {...props} /></div>
        </main>
        <aside className="v-right">
          <div className="v-rtabs">
            {RIGHT_TABS.map(([key, label]) => (
              <button key={key} type="button" className={right === key ? 'v-on' : undefined} onClick={() => actions.setRight(key)}>{label}</button>
            ))}
          </div>
          <div className="v-scroll"><div className="v-rbody"><RightBody {...props} /></div></div>
        </aside>
      </div>
      <StatusBar
        stats={props.stats} activeBody={activeDetail?.note.body ?? null}
        activeDegree={activeDetail === undefined ? 0 : props.degrees.get(activeDetail.note.id) ?? 0} actions={actions}
      />
      {props.paletteOpen && <QuickSwitcher entries={props.index.nodes} actions={actions} />}
      {hover !== null && (
        <HoverCard hover={hover} degree={props.degrees.get(hover.detail.note.id) ?? 0} colors={props.noteColors} nowMs={props.nowMs} actions={actions} />
      )}
      {toast !== null && <div className={`v-toast${toast.error ? ' v-error' : ''}`}>{toast.text}</div>}
    </div>
  );
}
