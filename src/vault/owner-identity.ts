import { VAULT_OWNER_TAG, vaultKey, type VaultNote, type VaultWriteSource } from '@siftkit/contracts';

import { editDistanceWithin } from '../assistant/domain/owner-identity.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import type { VaultNoteStore } from './note-store.ts';
import { NoteIdRowSchema, readVaultNote } from './note-rows.ts';

/** Phrases that always mean the owner, whatever the owner is called. */
const OWNER_PRONOUNS: ReadonlySet<string> = new Set([
  'the user', 'user', 'current user', 'local user', 'main person', 'me', 'myself', 'self', 'you', 'i',
]);
const USER_PREFIX = /^user[\s:_-]+/;
/** Possessives ("Denys's laptop") and paths or file names are things the owner has, not the owner. */
const NOT_A_PERSON = /'s\b|[\\/.]/;
const MIN_FUZZY_LENGTH = 4;
const FUZZY_MAX_EDITS = 2;
/** OCR confuses y with v, u and g often enough to allow one more edit when a y is present. */
const FUZZY_MAX_EDITS_WITH_Y = 3;
const DEFAULT_OWNER_TITLE = 'Owner';

const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Decides whether a name the model produced refers to the owner (design §4.2). */
export class OwnerIdentity {
  private readonly keys: ReadonlySet<string>;
  private readonly firstName: string;

  constructor(owner: { readonly title: string; readonly aliases: readonly string[] }) {
    this.keys = new Set([owner.title, ...owner.aliases].map(vaultKey));
    this.firstName = compact(owner.title.trim().split(/\s+/)[0] ?? '');
  }

  matches(name: string): boolean {
    const key = vaultKey(name);
    if (key.length === 0 || NOT_A_PERSON.test(key)) return false;
    if (this.keys.has(key) || OWNER_PRONOUNS.has(key)) return true;
    const stripped = key.replace(USER_PREFIX, '');
    if (this.keys.has(stripped)) return true;
    const candidate = compact(stripped);
    if (candidate.length < MIN_FUZZY_LENGTH || this.firstName.length < MIN_FUZZY_LENGTH || candidate[0] !== this.firstName[0]) return false;
    return editDistanceWithin(candidate, this.firstName, candidate.includes('y') ? FUZZY_MAX_EDITS_WITH_Y : FUZZY_MAX_EDITS);
  }
}

/** The oldest note tagged `#me`, or `null` before the owner note exists. */
export function findOwnerNote(database: RuntimeDatabase): VaultNote | null {
  const row = database.prepare(`
    SELECT t.note_id FROM vault_tags t JOIN vault_notes n ON n.id = t.note_id
    WHERE t.tag = ? ORDER BY n.created_at_utc, n.id LIMIT 1
  `).get(VAULT_OWNER_TAG);
  return row === undefined ? null : readVaultNote(database, NoteIdRowSchema.parse(row).note_id);
}

/** Returns the owner note, tagging a note already titled with the display name or creating one. */
export function ensureOwnerNote(store: VaultNoteStore, database: RuntimeDatabase, displayName: string, source: VaultWriteSource): VaultNote {
  const existing = findOwnerNote(database);
  if (existing !== null) return existing;
  const title = displayName.trim() || DEFAULT_OWNER_TITLE;
  const named = store.resolve(title);
  if (named !== null) {
    return store.update(named.id, { tags: [...named.tags, VAULT_OWNER_TAG] }, named.revision, { ...source, summary: 'Tagged as the owner note' });
  }
  return store.create(
    { title, folder: '', kind: 'entity', types: ['person'], aliases: [], tags: [VAULT_OWNER_TAG], body: 'This is you.' },
    { ...source, summary: 'Created the owner note' },
  );
}

/** Ensures the owner note and keeps its title on the configured name; renaming keeps the old title as an alias. */
export function syncOwnerNote(store: VaultNoteStore, database: RuntimeDatabase, displayName: string, source: VaultWriteSource): VaultNote {
  const owner = ensureOwnerNote(store, database, displayName, source);
  const title = displayName.trim();
  if (title === '' || vaultKey(title) === vaultKey(owner.title)) return owner;
  const holder = store.resolveId(title);
  // Another note already answers to the name; the owner note keeps its title rather than collide.
  if (holder !== null && holder !== owner.id) return owner;
  return store.rename(owner.id, title, owner.revision, source).note;
}
