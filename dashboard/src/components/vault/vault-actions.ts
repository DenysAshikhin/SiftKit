import type { VaultLocalGraphDepth } from '@siftkit/contracts';
import type { VaultNoteMode } from '../../lib/vault-tabs.ts';

export type VaultSide = 'files' | 'search';
export type VaultRightTab = 'links' | 'outline' | 'graph' | 'history' | 'vault';
export type VaultTriage = 'confirm' | 'drop';

export interface VaultGraphOptions {
  readonly filterText: string;
  readonly hidden: ReadonlySet<string>;
  readonly minDegree: number;
  readonly labels: boolean;
}

export interface VaultAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

/** Every user intent the vault UI can raise; `useVaultController` implements it. */
export interface VaultActions {
  openNote(id: string, newTab: boolean): void;
  followLink(target: string, newTab: boolean): void;
  searchTag(tag: string): void;
  toggleTask(noteId: string, line: number): void;
  triage(noteId: string, line: number, action: VaultTriage): void;
  showFull(): void;
  jumpTo(line: number): void;
  setMode(mode: VaultNoteMode): void;
  saveBody(noteId: string, body: string): void;
  rename(noteId: string, title: string): void;
  linkMention(sourceId: string, title: string): void;
  openDiff(noteId: string, revision: number): void;
  restore(noteId: string, revision: number): void;
  activateTab(index: number): void;
  closeTab(index: number): void;
  openGraph(): void;
  openReview(): void;
  openDaily(): void;
  newNote(): void;
  createNote(title: string): void;
  setSide(side: VaultSide): void;
  setSearch(query: string): void;
  toggleFolder(path: string): void;
  collapseAll(): void;
  toggleStubs(): void;
  setRight(tab: VaultRightTab): void;
  setLocalDepth(depth: VaultLocalGraphDepth): void;
  setGraphOptions(patch: Partial<VaultGraphOptions>): void;
  selectGraphNode(id: string): void;
  rerunLayout(): void;
  openPalette(): void;
  closePalette(): void;
  hoverLink(target: string, rect: VaultAnchorRect): void;
  clearHover(): void;
  exportVault(): void;
}
