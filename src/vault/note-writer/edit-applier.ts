import {
  addRowValues, addTasks, buildEntityBody, VAULT_OWNER_TAG, VAULT_VALUE_SEPARATOR, type VaultActor, type VaultNote, type VaultWriteMeta,
} from '@siftkit/contracts';

import type { SecretScanner } from '../../assistant/domain/secrets.ts';
import type { AuditStore } from '../../assistant/storage/audit-store.ts';
import type { RuntimeDatabase } from '../../state/runtime-db.ts';
import { VaultValidationError } from '../errors.ts';
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

type DropReason = 'secret' | 'unknown_note' | 'invalid_title';

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
}

export interface VaultEditResult {
  /** `## Learned` lines for the source note. */
  readonly learned: readonly string[];
  readonly touchedNoteIds: readonly string[];
  readonly dropped: number;
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

const opStrings = (op: VaultEditOp): string[] => {
  switch (op.op) {
    case 'create_note': return [op.title, op.type, op.lead];
    case 'add_facts': return [op.note, op.label, ...op.values];
    case 'add_aliases': return [op.note, ...op.aliases];
    case 'add_task': return [op.note, op.text];
    case 'learned': return [op.note, op.label, op.value];
  }
};

/**
 * Applies one job's edit operations in a single transaction, one revision per touched note. A bad
 * operation (secret, unknown note, invalid title) is dropped and audited; it never fails the job.
 */
export class VaultEditApplier {
  private readonly store: VaultNoteStore;
  private readonly database: RuntimeDatabase;
  private readonly audit: AuditStore;
  private readonly scanner: SecretScanner;
  private readonly ownerDisplayName: string;

  constructor(options: VaultEditApplierOptions) {
    this.store = options.store;
    this.database = options.database;
    this.audit = options.audit;
    this.scanner = options.scanner;
    this.ownerDisplayName = options.ownerDisplayName;
  }

  apply(request: VaultEditRequest): VaultEditResult {
    return this.database.transaction((): VaultEditResult => {
      const meta: VaultWriteMeta = { actor: request.actor, summary: request.summary, sourceRef: request.sourceRef };
      const ownerNote = findOwnerNote(this.database);
      const owner = new OwnerIdentity(ownerNote ?? { title: this.ownerDisplayName, aliases: [] });
      const drafts = new Map<string, Draft>();
      const learned: string[] = [];
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
      const draftFor = (name: string): Draft | null => {
        const note = resolveNote(name);
        if (note === null) return null;
        const existing = drafts.get(note.id);
        if (existing) return existing;
        const draft = { note, body: note.body, aliases: [...note.aliases] };
        drafts.set(note.id, draft);
        return draft;
      };
      const linkValue = (value: string): string => {
        const name = value.match(LONE_LINK)?.[1]?.trim() ?? value.trim();
        const target = resolveNote(name);
        return target === null ? name.split(VAULT_VALUE_SEPARATOR).join(', ') : `[[${target.title}]]`;
      };

      for (const op of request.operations) {
        const secretRules = opStrings(op).flatMap((value) => this.scanner.scan(value).matchedRuleIds);
        if (secretRules.length > 0) { drop(op, 'secret', [...new Set(secretRules)]); continue; }
        if (op.op === 'create_note') {
          if (owner.matches(op.title) || this.store.resolveId(op.title) !== null) continue;
          try {
            const note = this.store.create({
              title: validateVaultTitle(op.title), folder: typeFolder(op.type), kind: 'entity', types: [op.type.trim().toLowerCase()],
              aliases: [], tags: [], body: buildEntityBody({ lead: op.lead, rows: [], taskSections: [], unverified: [] }),
            }, meta);
            touched.add(note.id);
          } catch (error) {
            if (!(error instanceof VaultValidationError)) throw error;
            drop(op, 'invalid_title');
          }
          continue;
        }
        const draft = draftFor(op.note);
        if (draft === null) { drop(op, 'unknown_note'); continue; }
        if (op.op === 'add_facts') draft.body = addRowValues(draft.body, op.label, op.values.map(linkValue));
        // An owner-like name is only ever an alias of the owner note itself.
        else if (op.op === 'add_aliases') draft.aliases = [...draft.aliases, ...op.aliases.filter((alias) => draft.note.tags.includes(VAULT_OWNER_TAG) || !owner.matches(alias))];
        else if (op.op === 'add_task') draft.body = addTasks(draft.body, PLANS_HEADING, [op.text]);
        else learned.push(`- [[${draft.note.title}]]: **${op.label}** ${op.value}`);
      }

      for (const draft of drafts.values()) {
        const written = this.store.update(draft.note.id, { body: draft.body, aliases: draft.aliases }, draft.note.revision, meta);
        if (written.revision !== draft.note.revision) touched.add(written.id);
      }
      return { learned: [...new Set(learned)], touchedNoteIds: [...touched], dropped };
    })();
  }
}
