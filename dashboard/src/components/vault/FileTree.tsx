import type { VaultFolder, VaultNoteSummary } from '@siftkit/contracts';

import type { VaultActions } from './vault-actions.ts';

export const FOLDER_LIMIT = 200;
const NEWEST_FIRST_FOLDERS: ReadonlySet<string> = new Set(['Captures', 'Daily']);
const FOLDER_ICON: Readonly<Record<string, string>> = {
  People: '👤', Software: '⌨', Devices: '🖥', Projects: '📁', Topics: '💡', Media: '🎬', Captures: '📷', Daily: '📅', Chats: '💬',
  Places: '📍', Vehicles: '🚗', Goals: '🎯', Setups: '⚙', Documents: '📄', Contexts: '🧭', Datasets: '🗃', Events: '📌', Models: '🧠',
  Home: '🏠', Accounts: '🔑', Organizations: '🏢', Activities: '🏃',
};
const folderIcon = (folder: string): string => FOLDER_ICON[folder] ?? '•';
const INDENT_PX = 14;

export interface StarredNote {
  readonly note: VaultNoteSummary;
  readonly owner: boolean;
}

export interface FileTreeProps {
  readonly folders: readonly VaultFolder[];
  readonly folderNotes: ReadonlyMap<string, readonly VaultNoteSummary[]>;
  readonly expanded: ReadonlySet<string>;
  readonly starred: readonly StarredNote[];
  readonly showStubs: boolean;
  readonly stubCount: number;
  readonly activeNoteId: string | null;
  readonly actions: VaultActions;
}

function childrenOf(folders: readonly VaultFolder[], parent: VaultFolder | null): VaultFolder[] {
  const children = folders.filter((folder) => (parent === null ? folder.depth === 0 : folder.depth === parent.depth + 1 && folder.path.startsWith(`${parent.path}/`)));
  return parent !== null && NEWEST_FIRST_FOLDERS.has(parent.name)
    ? children.sort((left, right) => right.name.localeCompare(left.name))
    : children.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function NoteRows(props: { readonly notes: readonly VaultNoteSummary[]; readonly total: number; readonly depth: number; readonly tree: FileTreeProps }) {
  const { notes, total, depth, tree } = props;
  const shown = notes.slice(0, FOLDER_LIMIT);
  const indent = { paddingLeft: 20 + depth * INDENT_PX };
  return (
    <>
      {shown.map((note) => (
        <div key={note.id} className={`v-row${tree.activeNoteId === note.id ? ' v-active' : ''}`} style={indent} onClick={(event) => tree.actions.openNote(note.id, event.ctrlKey || event.metaKey)}>
          <span className="v-name">{note.title}</span>
        </div>
      ))}
      {total > shown.length && <div className="v-more" style={indent}>+ {(total - shown.length).toLocaleString('en-US')} more — search or use Ctrl+O</div>}
    </>
  );
}

function FolderRows(props: { readonly parent: VaultFolder | null; readonly depth: number; readonly tree: FileTreeProps }) {
  const { parent, depth, tree } = props;
  return childrenOf(tree.folders, parent).map((folder) => {
    const open = tree.expanded.has(folder.path);
    const children = childrenOf(tree.folders, folder);
    const direct = folder.count - children.reduce((sum, child) => sum + child.count, 0);
    return (
      <div key={folder.path}>
        <div className="v-row v-folder" style={{ paddingLeft: 6 + depth * INDENT_PX }} onClick={() => tree.actions.toggleFolder(folder.path)}>
          <span className="v-chev">{open ? '▾' : '▸'}</span>
          <span className="v-ico">{depth === 0 ? folderIcon(folder.name) : ''}</span>
          <span className="v-name">{folder.name}</span>
          <span className="v-count">{folder.count.toLocaleString('en-US')}</span>
        </div>
        {open && (
          <>
            <FolderRows parent={folder} depth={depth + 1} tree={tree} />
            <NoteRows notes={tree.folderNotes.get(folder.path) ?? []} total={direct} depth={depth} tree={tree} />
          </>
        )}
      </div>
    );
  });
}

export function FileTree(props: FileTreeProps) {
  const { starred, activeNoteId, actions, showStubs, stubCount, folderNotes } = props;
  const rootNotes = folderNotes.get('') ?? [];
  return (
    <div className="v-tree">
      <div className="v-tree-sec">Starred</div>
      {starred.map(({ note, owner }) => (
        <div key={note.id} className={`v-row${activeNoteId === note.id ? ' v-active' : ''}`} style={{ paddingLeft: 8 }} onClick={(event) => actions.openNote(note.id, event.ctrlKey || event.metaKey)}>
          <span className="v-ico">{owner ? '★' : folderIcon(note.folder.split('/')[0] ?? '')}</span>
          <span className="v-name">{owner ? `${note.title} (you)` : note.title}</span>
        </div>
      ))}
      <div className="v-tree-sec">Folders</div>
      <FolderRows parent={null} depth={0} tree={props} />
      {rootNotes.length > 0 && <NoteRows notes={rootNotes} total={rootNotes.length} depth={-1} tree={props} />}
      <div className="v-more" style={{ paddingLeft: 8, marginTop: 8 }} onClick={() => actions.toggleStubs()}>
        {showStubs ? `Hide ${stubCount.toLocaleString('en-US')} link-only notes` : `+ ${stubCount.toLocaleString('en-US')} link-only notes hidden (no facts of their own)`}
      </div>
    </div>
  );
}
