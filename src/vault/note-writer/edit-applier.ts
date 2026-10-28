import {
  addRowValues, addTasks, addUnverified, buildEntityBody, findRowValue, replaceLead, sameFactValue, VAULT_OWNER_TAG, VAULT_VALUE_SEPARATOR,
  type VaultActor, type VaultNote, type VaultWriteMeta,
} from '@siftkit/contracts';

import type { SecretScanner } from '../../assistant/domain/secrets.ts';
import type { AuditStore } from '../../assistant/storage/audit-store.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../../state/runtime-db.ts';
import { VaultValidationError } from '../errors.ts';
import { factPointKey, type FactPointKey } from '../fact-points.ts';
import { readVaultNote } from '../note-rows.ts';
import type { VaultNoteStore } from '../note-store.ts';
import { validateVaultTitle } from '../note-store.ts';
import { OwnerIdentity, ensureOwnerNote, findOwnerNote } from '../owner-identity.ts';
import type { VaultEditOp } from './edit-ops.ts';

const PLANS_HEADING = 'Plans';
const LONE_LINK = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/;
/** Entity folders by type, as the migration lays them out. */
const TYPE_FOLDERS: Readonly<Record<string, string>> = {
  person: 'People', software: 'Software', device: 'Devices', project: 'Projects', configuration_profile: 'Setups',
  home_asset: 'Home', topic: 'Topics', organization: 'Organizations', event: 'Events', model: 'Models', vehicle: 'Vehicles',
  goal: 'Goals', place: 'Places', document: 'Documents', media_work: 'Media', preference_context: 'Contexts',
};
const KeyOwnerRowsSchema = z.array(z.object({ key: z.string(), note_id: z.string() }));

type DropReason = 'secret' | 'unknown_note' | 'invalid_title' | 'unknown_fact' | 'out_of_scope' | 'task_not_allowed';
type SetLeadOp = Extract<VaultEditOp, { op: 'set_lead' }>;

export interface VaultEditApplierOptions {
  readonly store: VaultNoteStore;
  readonly database: RuntimeDatabase;
  readonly audit: AuditStore;
  readonly scanner: SecretScanner;
  readonly ownerDisplayName: string;
}

export interface VaultEditRequest {
  readonly ownerId: string;
  readonly operations: readonly VaultEditOp[];
  readonly actor: VaultActor;
  readonly sourceRef: string;
  readonly summary: string;
  /** Notes a review batch may lead-edit without touching them otherwise. */
  readonly scopeNoteIds: readonly string[];
  /** A source that may not add Plans entries has its add_task operations dropped. */
  readonly tasksAllowed: boolean;
}

export interface VaultFlaggedPoint extends FactPointKey {
  readonly noteId: string;
}

export interface VaultEditResult {
  /** `## Learned` lines for the source note. */
  readonly learned: readonly string[];
  readonly touchedNoteIds: readonly string[];
  readonly dropped: number;
  /** Values a flag_doubt marked; a review leaves them unvalidated. */
  readonly flagged: readonly VaultFlaggedPoint[];
}

interface Draft {
  readonly note: VaultNote;
  body: string;
  aliases: string[];
}

export const typeFolder = (type: string): string => {
  const key = type.trim().toLowerCase().replace(/\s+/g, '_');
  return TYPE_FOLDERS[key] ?? `${key.charAt(0).toUpperCase()}${key.slice(1).replace(/_/g, ' ')}s`;
};

/** Title identity ignoring case, whitespace and punctuation, for the near-duplicate guard. */
const looseKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const opStrings = (op: VaultEditOp): string[] => {
  switch (op.op) {
    case 'create_note': return [op.title, op.type, op.lead];
    case 'add_facts': return [op.note, op.label, ...op.values];
    case 'add_aliases': return [op.note, ...op.aliases];
    case 'add_task': return [op.note, op.text];
    case 'set_lead': return [op.note, op.lead];
    case 'flag_conflict': return [op.note, op.label, op.value, op.conflictsWith];
    case 'flag_doubt': return [op.note, op.label, op.value, op.reason];
  }
};

/**
 * Applies one job's edit operations in a single transaction, one revision per touched note. A bad
 * operation (secret, unknown note or fact, invalid title, out-of-scope lead) is dropped and audited.
 */
export class VaultEditApplier {
  private readonly store: VaultNoteStore;
  private readonly database: RuntimeDatabase;
  private readonly audit: AuditStore;
  private readonly scanner: SecretScanner;
  private ownerDisplayName: string;

  constructor(options: VaultEditApplierOptions) {
    this.store = options.store;
    this.database = options.database;
    this.audit = options.audit;
    this.scanner = options.scanner;
    this.ownerDisplayName = options.ownerDisplayName;
  }

  /** The name a missing owner note is recreated under follows the configured display name. */
  refreshOwnerDisplayName(displayName: string): void {
    this.ownerDisplayName = displayName;
  }

  apply(request: VaultEditRequest): VaultEditResult {
    return this.database.transaction((): VaultEditResult => {
      const meta: VaultWriteMeta = { actor: request.actor, summary: request.summary, sourceRef: request.sourceRef };
      const ownerNote = findOwnerNote(this.database);
      const owner = new OwnerIdentity(ownerNote ?? { title: this.ownerDisplayName, aliases: [] });
      const drafts = new Map<string, Draft>();
      const created = new Set<string>();
      const learned: string[] = [];
      const flagged: VaultFlaggedPoint[] = [];
      const leads: SetLeadOp[] = [];
      const touched = new Set<string>();
      let dropped = 0;
      const drop = (op: VaultEditOp, reason: DropReason, ruleIds: readonly string[] = []) => {
        dropped += 1;
        this.audit.recordAuditEvent({
          ownerId: request.ownerId, eventType: 'vault_edit_dropped', targetType: 'vault_edit', targetId: request.sourceRef,
          summary: `Dropped a ${op.op} operation: ${reason}.`, details: { op: op.op, reason, ruleIds: [...ruleIds] },
        });
      };
      const resolveNote = (name: string): VaultNote | null =>
        (owner.matches(name) ? ensureOwnerNote(this.store, this.database, this.ownerDisplayName, meta) : this.store.resolve(name));
      const draftOf = (note: VaultNote): Draft => {
        const existing = drafts.get(note.id);
        if (existing) return existing;
        const draft = { note, body: note.body, aliases: [...note.aliases] };
        drafts.set(note.id, draft);
        return draft;
      };
      const draftFor = (name: string): Draft | null => {
        const note = resolveNote(name);
        return note === null ? null : draftOf(note);
      };
      const linkValue = (value: string): string => {
        const name = value.match(LONE_LINK)?.[1]?.trim() ?? value.trim();
        const target = resolveNote(name);
        return target === null ? name.split(VAULT_VALUE_SEPARATOR).join(', ') : `[[${target.title}]]`;
      };

      for (const op of request.operations) {
        const secretRules = opStrings(op).flatMap((value) => this.scanner.scan(value).matchedRuleIds);
        if (secretRules.length > 0) { drop(op, 'secret', [...new Set(secretRules)]); continue; }
        if (op.op === 'set_lead') { leads.push(op); continue; }
        if (op.op === 'add_task' && !request.tasksAllowed) { drop(op, 'task_not_allowed'); continue; }
        if (op.op === 'create_note') {
          if (owner.matches(op.title) || this.store.resolveId(op.title) !== null) continue;
          const near = this.findNearDuplicate(op.title);
          if (near !== null) {
            const draft = draftOf(near);
            draft.aliases = [...draft.aliases, op.title.trim()];
            this.audit.recordAuditEvent({
              ownerId: request.ownerId, eventType: 'vault_edit_merged', targetType: 'vault_edit', targetId: request.sourceRef,
              summary: `Merged a new note into "${near.title}" as an alias.`, details: { op: op.op, reason: 'merged_into_existing', noteId: near.id },
            });
            continue;
          }
          try {
            const note = this.store.create({
              title: validateVaultTitle(op.title), folder: typeFolder(op.type), kind: 'entity', types: [op.type.trim().toLowerCase()],
              aliases: [], tags: [], body: buildEntityBody({ lead: op.lead, rows: [], taskSections: [], unverified: [] }),
            }, meta);
            touched.add(note.id);
            created.add(note.id);
            learned.push(`- [[${note.title}]]: ${op.lead}`);
          } catch (error) {
            if (!(error instanceof VaultValidationError)) throw error;
            drop(op, 'invalid_title');
          }
          continue;
        }
        const draft = draftFor(op.note);
        if (draft === null) { drop(op, 'unknown_note'); continue; }
        if (op.op === 'add_facts') {
          const fresh = op.values.map(linkValue).filter((value, index, values) =>
            findRowValue(draft.body, op.label, value) === null && values.findIndex((other) => sameFactValue(other, value)) === index);
          if (fresh.length === 0) continue;
          draft.body = addRowValues(draft.body, op.label, fresh);
          learned.push(`- [[${draft.note.title}]]: **${op.label}** ${fresh.join(VAULT_VALUE_SEPARATOR)}`);
        }
        // An owner-like name is only ever an alias of the owner note itself.
        else if (op.op === 'add_aliases') draft.aliases = [...draft.aliases, ...op.aliases.filter((alias) => draft.note.tags.includes(VAULT_OWNER_TAG) || !owner.matches(alias))];
        else if (op.op === 'add_task') {
          const before = draft.body;
          draft.body = addTasks(draft.body, PLANS_HEADING, [op.text]);
          if (draft.body !== before) learned.push(`- [[${draft.note.title}]]: **${PLANS_HEADING}** ${op.text}`);
        }
        else if (op.op === 'flag_conflict') {
          if (findRowValue(draft.body, op.label, op.conflictsWith) === null) { drop(op, 'unknown_fact'); continue; }
          draft.body = addUnverified(draft.body, [{ label: op.label, value: op.value, flag: { kind: 'replaces', value: op.conflictsWith } }]);
        } else {
          // The flagged key is the stored value's, so a review leaves exactly that fact point unvalidated.
          const held = findRowValue(draft.body, op.label, op.value);
          if (held === null) { drop(op, 'unknown_fact'); continue; }
          draft.body = addUnverified(draft.body, [{ label: op.label, value: op.value, flag: { kind: 'doubt', reason: op.reason } }]);
          flagged.push({ noteId: draft.note.id, ...factPointKey(held.label, held.value) });
        }
      }

      const scope = new Set(request.scopeNoteIds);
      for (const op of leads) {
        const target = resolveNote(op.note);
        if (target === null) { drop(op, 'unknown_note'); continue; }
        if (!drafts.has(target.id) && !created.has(target.id) && !scope.has(target.id)) { drop(op, 'out_of_scope'); continue; }
        const draft = draftOf(target);
        draft.body = replaceLead(draft.body, op.lead);
      }

      for (const draft of drafts.values()) {
        const written = this.store.update(draft.note.id, { body: draft.body, aliases: draft.aliases }, draft.note.revision, meta);
        if (written.revision !== draft.note.revision) touched.add(written.id);
      }
      return { learned: [...new Set(learned)], touchedNoteIds: [...touched], dropped, flagged };
    })();
  }

  /** An existing note whose title or alias matches `title` ignoring case, whitespace and punctuation. */
  private findNearDuplicate(title: string): VaultNote | null {
    const key = looseKey(title);
    if (key.length === 0) return null;
    const match = KeyOwnerRowsSchema.parse(this.database.prepare('SELECT key, note_id FROM vault_key_owners').all())
      .find((owner) => looseKey(owner.key) === key);
    return match === undefined ? null : readVaultNote(this.database, match.note_id);
  }
}
