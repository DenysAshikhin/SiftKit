import { z } from 'zod';

export const VAULT_NOTE_KINDS = ['entity', 'capture', 'daily', 'chat', 'note'] as const;
export const VaultNoteKindSchema = z.enum(VAULT_NOTE_KINDS);
export type VaultNoteKind = z.infer<typeof VaultNoteKindSchema>;

export const VaultNoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  folder: z.string(),
  kind: VaultNoteKindSchema,
  types: z.array(z.string()),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
  body: z.string(),
  revision: z.number().int().min(1),
  isStub: z.boolean(),
  createdAtUtc: z.string(),
  updatedAtUtc: z.string(),
}).strict();
export type VaultNote = z.infer<typeof VaultNoteSchema>;

export const VaultNoteSummarySchema = VaultNoteSchema.pick({
  id: true, title: true, folder: true, kind: true, isStub: true, updatedAtUtc: true,
});
export type VaultNoteSummary = z.infer<typeof VaultNoteSummarySchema>;

export const VaultNoteInputSchema = VaultNoteSchema.pick({
  title: true, folder: true, kind: true, types: true, aliases: true, tags: true, body: true,
});
export type VaultNoteInput = z.infer<typeof VaultNoteInputSchema>;

export const VaultNotePatchSchema = VaultNoteInputSchema.pick({
  body: true, folder: true, types: true, aliases: true, tags: true,
}).partial();
export type VaultNotePatch = z.infer<typeof VaultNotePatchSchema>;

export const VaultWriteMetaSchema = z.object({
  actor: z.string(),
  summary: z.string(),
  sourceRef: z.string().nullable(),
}).strict();
export type VaultWriteMeta = z.infer<typeof VaultWriteMetaSchema>;

export const VaultRenameResultSchema = z.object({
  note: VaultNoteSchema,
  rewrittenNotes: z.number().int().min(0),
  rewrittenLinks: z.number().int().min(0),
}).strict();
export type VaultRenameResult = z.infer<typeof VaultRenameResultSchema>;

export const VaultRevisionSummarySchema = VaultWriteMetaSchema.extend({
  revision: z.number().int().min(1),
  createdAtUtc: z.string(),
}).strict();
export type VaultRevisionSummary = z.infer<typeof VaultRevisionSummarySchema>;

export const VaultRevisionSchema = VaultRevisionSummarySchema.extend({
  title: z.string(),
  folder: z.string(),
  body: z.string(),
  types: z.array(z.string()),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
}).strict();
export type VaultRevision = z.infer<typeof VaultRevisionSchema>;

export const VaultFolderSchema = z.object({
  path: z.string(),
  name: z.string(),
  depth: z.number().int().min(0),
  count: z.number().int().min(0),
}).strict();
export type VaultFolder = z.infer<typeof VaultFolderSchema>;

export const VaultBacklinkSchema = z.object({
  note: VaultNoteSummarySchema,
  labels: z.array(z.string()),
}).strict();
export type VaultBacklink = z.infer<typeof VaultBacklinkSchema>;

export const VaultOutgoingSchema = z.object({
  resolved: z.array(VaultNoteSummarySchema),
  unresolved: z.array(z.string()),
}).strict();
export type VaultOutgoing = z.infer<typeof VaultOutgoingSchema>;

export const VaultReviewItemSchema = z.object({
  note: VaultNoteSummarySchema,
  line: z.number().int().min(0),
  label: z.string().nullable(),
  value: z.string(),
}).strict();
export type VaultReviewItem = z.infer<typeof VaultReviewItemSchema>;

export const VaultReviewSchema = z.object({
  total: z.number().int().min(0),
  items: z.array(VaultReviewItemSchema),
}).strict();
export type VaultReview = z.infer<typeof VaultReviewSchema>;

export const VaultStatsSchema = z.object({
  notes: z.number().int().min(0),
  links: z.number().int().min(0),
  tags: z.number().int().min(0),
  stubs: z.number().int().min(0),
  notesWithUnverified: z.number().int().min(0),
  byKind: z.record(VaultNoteKindSchema, z.number().int().min(0)),
}).strict();
export type VaultStats = z.infer<typeof VaultStatsSchema>;

export const VaultSearchHitSchema = z.object({
  note: VaultNoteSummarySchema,
  score: z.number(),
  snippet: z.string().nullable(),
}).strict();
export type VaultSearchHit = z.infer<typeof VaultSearchHitSchema>;

export const VaultSearchResultSchema = z.object({
  total: z.number().int().min(0),
  hits: z.array(VaultSearchHitSchema),
}).strict();
export type VaultSearchResult = z.infer<typeof VaultSearchResultSchema>;

export const VaultGraphNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  folder: z.string(),
  topFolder: z.string(),
  kind: VaultNoteKindSchema,
  degree: z.number().int().min(0),
}).strict();
export type VaultGraphNode = z.infer<typeof VaultGraphNodeSchema>;

export const VaultGraphSchema = z.object({
  nodes: z.array(VaultGraphNodeSchema),
  edges: z.array(z.object({ source: z.string(), target: z.string() }).strict()),
}).strict();
export type VaultGraph = z.infer<typeof VaultGraphSchema>;

const ExpectedRevisionSchema = z.number().int().min(1);

export const VaultTreeResponseSchema = z.object({ folders: z.array(VaultFolderSchema) }).strict();
export type VaultTreeResponse = z.infer<typeof VaultTreeResponseSchema>;

export const VaultNoteListResponseSchema = z.object({ notes: z.array(VaultNoteSummarySchema) }).strict();
export type VaultNoteListResponse = z.infer<typeof VaultNoteListResponseSchema>;

export const VaultNoteDetailSchema = z.object({
  note: VaultNoteSchema,
  backlinks: z.array(VaultBacklinkSchema),
  outgoing: VaultOutgoingSchema,
}).strict();
export type VaultNoteDetail = z.infer<typeof VaultNoteDetailSchema>;

export const VaultResolveResponseSchema = z.object({ id: z.string().nullable() }).strict();
export type VaultResolveResponse = z.infer<typeof VaultResolveResponseSchema>;

export const VaultRevisionListResponseSchema = z.object({ revisions: z.array(VaultRevisionSummarySchema) }).strict();
export type VaultRevisionListResponse = z.infer<typeof VaultRevisionListResponseSchema>;

export const VaultCreateNoteRequestSchema = z.object({
  title: z.string(),
  folder: z.string().default(''),
  body: z.string().default(''),
}).strict();

export const VaultUpdateNoteRequestSchema = VaultNotePatchSchema.extend({ expectedRevision: ExpectedRevisionSchema }).strict();
export const VaultRenameRequestSchema = z.object({ title: z.string(), expectedRevision: ExpectedRevisionSchema }).strict();
export const VaultDeleteRequestSchema = z.object({ expectedRevision: ExpectedRevisionSchema }).strict();
export const VaultRestoreRequestSchema = z.object({ revision: z.number().int().min(1), expectedRevision: ExpectedRevisionSchema }).strict();

export const VaultDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type VaultDeleteResponse = z.infer<typeof VaultDeleteResponseSchema>;
