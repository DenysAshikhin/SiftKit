import { z } from '../../lib/zod.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const NoteRef = text(120);
const Label = text(40);
const Value = text(200);
const MAX_VALUES = 8;
const MAX_OPERATIONS = 30;

/**
 * LLM edit operations (design §4.2). Flat and scalar-bounded on purpose: no recursion and no shared
 * `$ref` definitions, which some backends' grammar compilers cannot follow.
 */
export const VaultEditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_note'), title: NoteRef, type: Label, lead: text(600) }).strict(),
  z.object({ op: z.literal('add_facts'), note: NoteRef, label: Label, values: z.array(Value).min(1).max(MAX_VALUES) }).strict(),
  z.object({ op: z.literal('add_aliases'), note: NoteRef, aliases: z.array(NoteRef).min(1).max(MAX_VALUES) }).strict(),
  z.object({ op: z.literal('add_task'), note: NoteRef, text: text(300) }).strict(),
  z.object({ op: z.literal('learned'), note: NoteRef, label: Label, value: Value }).strict(),
]);
export type VaultEditOp = z.infer<typeof VaultEditOpSchema>;

export const VaultEditResponseSchema = z.object({ operations: z.array(VaultEditOpSchema).max(MAX_OPERATIONS) }).strict();
export type VaultEditResponse = z.infer<typeof VaultEditResponseSchema>;

/** The operation vocabulary, shared by every model-backed writer's instructions. */
export const VAULT_EDIT_INSTRUCTIONS = [
  'Answer with {"operations": [...]}. Each operation is one of:',
  '- create_note {title, type, lead}: a new entity (a tool, project, person, place, topic...). Only when no listed note fits.',
  '- add_facts {note, label, values}: durable facts as a short row label ("Uses", "Works on", "Prefers") and up to 8 values.',
  '- add_aliases {note, aliases}: other names the note goes by.',
  '- add_task {note, text}: something the user plans or wants to do.',
  '- learned {note, label, value}: one line summarising what this source taught about a note.',
  'Refer to notes by their exact title. Refer to the user as "the user".',
  'Report only what is clearly shown. Never record credentials, protected traits, or a medical diagnosis.',
  'Return {"operations": []} when nothing durable is shown.',
].join('\n');
