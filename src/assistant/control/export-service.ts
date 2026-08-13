import type { AssistantExportRequest } from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import { ZipWriter } from '../../lib/zip.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { CURRENT_SCHEMA_VERSION } from '../../state/runtime-db.js';
import type { AssistantGraph } from '../assistant-graph.js';
import {
  AliasRowSchema, AssertionEvidenceRowSchema, AssertionRowSchema, AuditEventRowSchema,
  EvidenceRowSchema, NodeRowSchema, PolicyRowSchema, QuestionRowSchema,
} from '../storage/rows.js';

/**
 * One owner-scoped table rendered as JSON Lines. Rows are exported as stored (snake_case) so the
 * archive stays a faithful dump rather than a lossy view; each is validated on the way out.
 */
interface TableExport {
  readonly entryName: string;
  readonly sql: string;
  readonly schema: z.ZodType;
}

const TABLE_EXPORTS: readonly TableExport[] = [
  {
    entryName: 'graph/nodes.jsonl',
    sql: 'SELECT * FROM graph_nodes WHERE owner_id = ? ORDER BY id',
    schema: NodeRowSchema,
  },
  {
    entryName: 'graph/assertions.jsonl',
    sql: 'SELECT * FROM graph_assertions WHERE owner_id = ? ORDER BY id',
    schema: AssertionRowSchema,
  },
  {
    entryName: 'graph/aliases.jsonl',
    sql: 'SELECT * FROM graph_node_aliases WHERE owner_id = ? ORDER BY id',
    schema: AliasRowSchema,
  },
  {
    // `assertion_evidence` carries no owner column, so ownership comes from its assertion.
    entryName: 'graph/evidence-links.jsonl',
    sql: `
      SELECT link.* FROM assertion_evidence AS link
      JOIN graph_assertions AS assertion ON assertion.id = link.assertion_id
      WHERE assertion.owner_id = ? ORDER BY link.assertion_id, link.evidence_id
    `,
    schema: AssertionEvidenceRowSchema,
  },
  {
    entryName: 'evidence/metadata.jsonl',
    sql: 'SELECT * FROM evidence_records WHERE owner_id = ? ORDER BY id',
    schema: EvidenceRowSchema,
  },
  {
    entryName: 'questions.jsonl',
    sql: 'SELECT * FROM assistant_questions WHERE owner_id = ? ORDER BY id',
    schema: QuestionRowSchema,
  },
  {
    entryName: 'audit.jsonl',
    sql: 'SELECT * FROM assistant_audit_events WHERE owner_id = ? ORDER BY id',
    schema: AuditEventRowSchema,
  },
];

/**
 * §16.3 export: the user's memory as a portable zip — graph tables as JSON Lines, projections as
 * the markdown they already are, and evidence bytes only when explicitly asked for. Everything is
 * built in memory; an export never leaves plaintext in a temp file.
 */
export class ExportService {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly database: RuntimeDatabase,
    private readonly ownerId: string,
  ) {}

  async export(request: AssistantExportRequest): Promise<Buffer> {
    const writer = new ZipWriter();
    writer.add('manifest.json', Buffer.from(JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAtUtc: this.graph.nowUtc(),
      includesDecryptedBlobs: request.includeDecryptedBlobs,
    }, null, 2), 'utf8'));

    for (const table of TABLE_EXPORTS) {
      writer.add(table.entryName, this.jsonLines(table));
    }
    writer.add('policies.json', Buffer.from(JSON.stringify(
      z.array(PolicyRowSchema).parse(this.database
        .prepare('SELECT * FROM assistant_policies WHERE owner_id = ? ORDER BY id')
        .all(this.ownerId)),
      null,
      2,
    ), 'utf8'));

    for (const projection of this.graph.projections.listAllRows(this.ownerId)) {
      if (projection.status !== 'active') continue;
      writer.add(`projections/${projection.relative_path}`, Buffer.from(projection.content, 'utf8'));
    }

    if (request.includeDecryptedBlobs) {
      this.addDecryptedBlobs(writer);
    }
    return writer.build();
  }

  private jsonLines(table: TableExport): Buffer {
    const rows = z.array(table.schema).parse(this.database.prepare(table.sql).all(this.ownerId));
    return Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
  }

  /** Plaintext evidence, content-addressed exactly as the record names it. Always audited. */
  private addDecryptedBlobs(writer: ZipWriter): void {
    const rows = z.array(EvidenceRowSchema).parse(this.database.prepare(`
      SELECT * FROM evidence_records
      WHERE owner_id = ? AND status <> 'deleted' AND blob_id IS NOT NULL ORDER BY id
    `).all(this.ownerId));

    let exported = 0;
    for (const row of rows) {
      if (row.blob_id === null) continue;
      writer.add(
        `evidence/blobs/${row.content_hash}`,
        this.graph.evidence.readBlobBytes(row.blob_id),
      );
      exported += 1;
    }
    this.graph.audit.recordAuditEvent({
      ownerId: this.ownerId,
      eventType: 'decrypted_export',
      targetType: 'evidence',
      targetId: null,
      summary: `Exported ${exported} evidence blobs in plaintext at the user's request.`,
      details: { blobCount: exported },
    });
  }
}
