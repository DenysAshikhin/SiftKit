import { z } from 'zod';

export const VAULT_NOTE_KINDS = ['entity', 'capture', 'daily', 'chat', 'note'] as const;
export const VaultNoteKindSchema = z.enum(VAULT_NOTE_KINDS);
export type VaultNoteKind = z.infer<typeof VaultNoteKindSchema>;

export const VaultRevisionNumberSchema = z.number().int().min(1);

/** Who wrote a revision (design §4.2). Closed, so history can render each writer distinctly. */
export const VAULT_ACTORS = ['you', 'capture-intake', 'migration', 'note-writer · screenshot', 'note-writer · chat', 'note-writer · tidy'] as const;
export const VaultActorSchema = z.enum(VAULT_ACTORS);
export type VaultActor = z.infer<typeof VaultActorSchema>;

export const VaultNoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  folder: z.string(),
  kind: VaultNoteKindSchema,
  types: z.array(z.string()),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
  body: z.string(),
  revision: VaultRevisionNumberSchema,
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
  actor: VaultActorSchema,
  summary: z.string(),
  sourceRef: z.string().nullable(),
}).strict();
export type VaultWriteMeta = z.infer<typeof VaultWriteMetaSchema>;

/** For writes whose revision summary the store derives from the operation itself. */
export const VaultWriteSourceSchema = VaultWriteMetaSchema.omit({ summary: true });
export type VaultWriteSource = z.infer<typeof VaultWriteSourceSchema>;

export const VaultRenameResultSchema = z.object({
  note: VaultNoteSchema,
  rewrittenNotes: z.number().int().min(0),
  rewrittenLinks: z.number().int().min(0),
}).strict();
export type VaultRenameResult = z.infer<typeof VaultRenameResultSchema>;

export const VaultRevisionSummarySchema = VaultWriteMetaSchema.extend({
  revision: VaultRevisionNumberSchema,
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

/** A note you create by hand: only the title is required. */
export const VaultCreateNoteRequestSchema = VaultNoteInputSchema.extend({
  folder: VaultNoteInputSchema.shape.folder.default(''),
  kind: VaultNoteInputSchema.shape.kind.default('note'),
  types: VaultNoteInputSchema.shape.types.default([]),
  aliases: VaultNoteInputSchema.shape.aliases.default([]),
  tags: VaultNoteInputSchema.shape.tags.default([]),
  body: VaultNoteInputSchema.shape.body.default(''),
}).strict();

export const VaultUpdateNoteRequestSchema = VaultNotePatchSchema.extend({ expectedRevision: VaultRevisionNumberSchema }).strict();
export const VaultRenameRequestSchema = z.object({ title: VaultNoteSchema.shape.title, expectedRevision: VaultRevisionNumberSchema }).strict();
export const VaultDeleteRequestSchema = z.object({ expectedRevision: VaultRevisionNumberSchema }).strict();
export const VaultRestoreRequestSchema = z.object({ revision: VaultRevisionNumberSchema, expectedRevision: VaultRevisionNumberSchema }).strict();

export const VaultDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type VaultDeleteResponse = z.infer<typeof VaultDeleteResponseSchema>;

/** Upper bound on any list a vault route returns in one response. */
export const VAULT_MAX_PAGE = 1000;
/** A local graph stops growing at this many notes so a hub neighbourhood stays readable. */
export const VAULT_LOCAL_GRAPH_CAP = 160;
const PageLimitSchema = z.coerce.number().int().min(1).max(VAULT_MAX_PAGE);
const QueryFlagSchema = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

export const VaultTreeQuerySchema = z.object({ stubs: QueryFlagSchema }).strict();
export const VaultNoteListQuerySchema = z.object({ folder: z.string().default(''), stubs: QueryFlagSchema, limit: PageLimitSchema.default(500) }).strict();
export const VaultResolveQuerySchema = z.object({ title: z.string() }).strict();
export const VaultSearchQuerySchema = z.object({ q: z.string().default(''), limit: PageLimitSchema.default(50) }).strict();
export const VaultReviewQuerySchema = z.object({ limit: PageLimitSchema.default(200) }).strict();
export const VaultGraphQuerySchema = z.object({
  minLinks: z.coerce.number().int().min(0).default(0),
  hide: z.string().default('').transform((value) => value.split(',').map((folder) => folder.trim()).filter((folder) => folder.length > 0)),
}).strict();

export const VaultLocalGraphDepthSchema = z.union([z.literal(1), z.literal(2)]);
export type VaultLocalGraphDepth = z.infer<typeof VaultLocalGraphDepthSchema>;
export const VaultLocalGraphQuerySchema = z.object({ depth: z.coerce.number().pipe(VaultLocalGraphDepthSchema).default(1) }).strict();
