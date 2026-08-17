import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { PolicySource, PolicyType } from '../domain/enums.js';
import { normalizeAliasText } from '../domain/keys.js';
import type { IdGenerator } from '../ids.js';
import { PolicyRowSchema, type PolicyRow } from './rows.js';

export interface UpsertPolicyInput {
  readonly ownerId: string;
  readonly policyType: PolicyType;
  readonly key: string;
  readonly value: JsonObject;
  readonly enabled: boolean;
  readonly source: PolicySource;
}

/** Builds the symmetric key for a do-not-merge pair so order never matters. */
function mergePairKey(firstNodeId: string, secondNodeId: string): string {
  return [firstNodeId, secondNodeId].sort().join('|');
}

export class PolicyStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  upsertPolicy(input: UpsertPolicyInput): PolicyRow {
    const normalizedKey = normalizeAliasText(input.key);
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO assistant_policies (
        id, owner_id, policy_type, key, value_json, enabled, source, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, policy_type, key) DO UPDATE SET
        value_json = excluded.value_json,
        enabled = excluded.enabled,
        source = excluded.source,
        updated_at_utc = excluded.updated_at_utc
    `).run(
      this.ids.next('pol'), input.ownerId, input.policyType, normalizedKey,
      JSON.stringify(input.value), input.enabled ? 1 : 0, input.source, nowUtc, nowUtc,
    );
    const stored = this.findPolicy(input.ownerId, input.policyType, normalizedKey);
    if (stored === null) {
      throw new Error(`Policy ${input.policyType}:${normalizedKey} vanished after upsert.`);
    }
    return stored;
  }

  findPolicy(ownerId: string, policyType: PolicyType, key: string): PolicyRow | null {
    const row = this.database.prepare(`
      SELECT * FROM assistant_policies WHERE owner_id = ? AND policy_type = ? AND key = ?
    `).get(ownerId, policyType, normalizeAliasText(key));
    return row === undefined || row === null ? null : PolicyRowSchema.parse(row);
  }

  listPolicies(ownerId: string, policyType?: PolicyType): PolicyRow[] {
    const rows = policyType === undefined
      ? this.database.prepare(`
          SELECT * FROM assistant_policies WHERE owner_id = ? ORDER BY policy_type ASC, key ASC
        `).all(ownerId)
      : this.database.prepare(`
          SELECT * FROM assistant_policies WHERE owner_id = ? AND policy_type = ? ORDER BY key ASC
        `).all(ownerId, policyType);
    return z.array(PolicyRowSchema).parse(rows);
  }

  getPolicyById(ownerId: string, policyId: string): PolicyRow | null {
    const row = this.database.prepare(`
      SELECT * FROM assistant_policies WHERE owner_id = ? AND id = ?
    `).get(ownerId, policyId);
    return row === undefined || row === null ? null : PolicyRowSchema.parse(row);
  }

  setEnabled(ownerId: string, policyType: PolicyType, key: string, enabled: boolean): void {
    this.database.prepare(`
      UPDATE assistant_policies SET enabled = ?, updated_at_utc = ?
      WHERE owner_id = ? AND policy_type = ? AND key = ?
    `).run(enabled ? 1 : 0, this.clock.nowUtc(), ownerId, policyType, normalizeAliasText(key));
  }

  deletePolicy(ownerId: string, policyType: PolicyType, key: string): void {
    this.database.prepare(`
      DELETE FROM assistant_policies WHERE owner_id = ? AND policy_type = ? AND key = ?
    `).run(ownerId, policyType, normalizeAliasText(key));
  }

  isTopicBlockedFromInference(ownerId: string, topic: string): boolean {
    return this.isEnabled(ownerId, 'never_infer_topic', topic);
  }

  blockMerge(ownerId: string, firstNodeId: string, secondNodeId: string, reason: string): PolicyRow {
    return this.upsertPolicy({
      ownerId, policyType: 'do_not_merge_node',
      key: mergePairKey(firstNodeId, secondNodeId),
      value: { reason, nodeIds: [firstNodeId, secondNodeId].sort() },
      enabled: true, source: 'user',
    });
  }

  isMergeBlocked(ownerId: string, firstNodeId: string, secondNodeId: string): boolean {
    return this.isEnabled(ownerId, 'do_not_merge_node', mergePairKey(firstNodeId, secondNodeId));
  }

  lockAssertion(ownerId: string, assertionId: string, reason: string): PolicyRow {
    return this.upsertPolicy({
      ownerId, policyType: 'assertion_lock', key: assertionId,
      value: { reason }, enabled: true, source: 'user',
    });
  }

  isAssertionLocked(ownerId: string, assertionId: string): boolean {
    return this.isEnabled(ownerId, 'assertion_lock', assertionId);
  }

  private isEnabled(ownerId: string, policyType: PolicyType, key: string): boolean {
    const policy = this.findPolicy(ownerId, policyType, key);
    return policy !== null && policy.enabled;
  }
}
