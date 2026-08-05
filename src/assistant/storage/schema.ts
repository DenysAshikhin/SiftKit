import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import { NODE_TYPE_DEFINITIONS, NODE_TYPES } from '../domain/node-types.js';
import { RELATION_DEFINITIONS, RELATION_TYPES } from '../domain/relation-types.js';

/** The single owner row id. One human user per installation (design: out of scope, multi-user). */
export const LOCAL_OWNER_ID = 'own_local';
/** Placeholder shown until the user names themselves; the owner row is created before any UI. */
const LOCAL_OWNER_DISPLAY_NAME = 'Local user';
/** Placeholder for this machine's device row, named on the same terms as the owner row. */
const LOCAL_DEVICE_DISPLAY_NAME = 'This device';
/** Runtime metadata key holding the monotonic graph version. */
export const GRAPH_VERSION_METADATA_KEY = 'assistant.graph_version';
/** Runtime metadata key holding the id of this machine's device row. */
export const LOCAL_DEVICE_METADATA_KEY = 'assistant.local_device_id';
/** Canonical key identifying the owner's own person node. */
export const OWNER_PERSON_CANONICAL_KEY = 'person:owner';

export const ASSISTANT_CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS assistant_owners (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_devices (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    display_name TEXT NOT NULL,
    public_key TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_node_types (
    name TEXT PRIMARY KEY,
    definition TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_relation_types (
    name TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    type TEXT NOT NULL REFERENCES graph_node_types(name),
    canonical_key TEXT,
    display_name TEXT NOT NULL,
    description TEXT,
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    status TEXT NOT NULL CHECK (status IN ('active', 'merged', 'archived', 'deleted')),
    properties_json TEXT NOT NULL DEFAULT '{}',
    merged_into_node_id TEXT REFERENCES graph_nodes(id),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    deleted_at_utc TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_nodes_owner_type_key_uq
  ON graph_nodes(owner_id, type, canonical_key)
  WHERE canonical_key IS NOT NULL AND status <> 'deleted';
CREATE INDEX IF NOT EXISTS graph_nodes_owner_type_idx ON graph_nodes(owner_id, type, status);

CREATE TABLE IF NOT EXISTS graph_node_aliases (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    alias_type TEXT NOT NULL CHECK (
        alias_type IN ('name', 'handle', 'model', 'path', 'identifier', 'user_supplied')),
    source_evidence_id TEXT,
    created_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_node_aliases_lookup_idx
  ON graph_node_aliases(owner_id, normalized_alias);

CREATE TABLE IF NOT EXISTS evidence_blobs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    storage_uri TEXT NOT NULL,
    encrypted INTEGER NOT NULL CHECK (encrypted IN (0, 1)),
    key_id TEXT,
    created_at_utc TEXT NOT NULL,
    deleted_at_utc TEXT,
    UNIQUE(owner_id, content_hash)
);

CREATE TABLE IF NOT EXISTS evidence_records (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES assistant_devices(id) ON DELETE SET NULL,
    source_event_id TEXT NOT NULL,
    parent_evidence_id TEXT REFERENCES evidence_records(id) ON DELETE SET NULL,
    blob_id TEXT REFERENCES evidence_blobs(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL CHECK (source_type IN (
        'conversation_message', 'question_answer', 'manual_correction', 'manual_import',
        'desktop_activity', 'screenshot', 'accessibility_snapshot', 'ocr_result', 'mobile_event')),
    source_ref TEXT,
    captured_at_utc TEXT NOT NULL,
    source_timezone TEXT,
    ingested_at_utc TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mime_type TEXT,
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    retention_until_utc TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'quarantined', 'deleted')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    UNIQUE(owner_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS evidence_owner_hash_idx
  ON evidence_records(owner_id, content_hash, source_type, captured_at_utc);
CREATE INDEX IF NOT EXISTS evidence_retention_idx
  ON evidence_records(status, retention_until_utc);

CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
    observation_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    extractor_name TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_evidence_idx ON observations(evidence_id);

CREATE TABLE IF NOT EXISTS candidate_assertions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
    candidate_fingerprint TEXT NOT NULL,
    subject_ref_json TEXT NOT NULL,
    predicate TEXT NOT NULL REFERENCES graph_relation_types(name),
    object_ref_json TEXT NOT NULL,
    scope_ref_json TEXT,
    basis TEXT NOT NULL CHECK (basis IN (
        'explicit_user_statement', 'explicit_question_answer', 'manual_import',
        'passive_observation', 'derived_aggregation', 'assistant_inference')),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    valid_from_utc TEXT,
    valid_to_utc TEXT,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'accepted', 'rejected', 'needs_confirmation', 'superseded')),
    rejection_reason TEXT,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidate_assertions_status_idx
  ON candidate_assertions(owner_id, status, created_at_utc);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_assertions_fingerprint_uq
  ON candidate_assertions(owner_id, candidate_fingerprint, observation_id);

CREATE TABLE IF NOT EXISTS graph_assertions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    assertion_key TEXT NOT NULL,
    subject_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
    predicate TEXT NOT NULL REFERENCES graph_relation_types(name),
    object_kind TEXT NOT NULL CHECK (object_kind IN ('node', 'literal')),
    object_node_id TEXT REFERENCES graph_nodes(id),
    object_value_type TEXT CHECK (object_value_type IN (
        'string', 'integer', 'number', 'boolean', 'date', 'datetime',
        'duration', 'quantity', 'json')),
    object_value_json TEXT,
    object_normalized_text TEXT,
    scope_node_id TEXT REFERENCES graph_nodes(id),
    status TEXT NOT NULL CHECK (status IN (
        'active', 'disputed', 'superseded', 'rejected', 'expired', 'deleted')),
    basis TEXT NOT NULL CHECK (basis IN (
        'explicit_user_statement', 'explicit_question_answer', 'manual_import',
        'passive_observation', 'derived_aggregation', 'assistant_inference')),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    valid_from_utc TEXT,
    valid_to_utc TEXT,
    first_observed_at_utc TEXT NOT NULL,
    last_observed_at_utc TEXT NOT NULL,
    recorded_at_utc TEXT NOT NULL,
    retired_at_utc TEXT,
    supersedes_assertion_id TEXT REFERENCES graph_assertions(id),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    CHECK (
        (object_kind = 'node' AND object_node_id IS NOT NULL AND object_value_json IS NULL)
        OR
        (object_kind = 'literal' AND object_node_id IS NULL AND object_value_json IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_assertions_active_key_uq
  ON graph_assertions(owner_id, assertion_key) WHERE status IN ('active', 'disputed');
CREATE INDEX IF NOT EXISTS graph_assertions_subject_idx
  ON graph_assertions(owner_id, subject_node_id, predicate, status);
CREATE INDEX IF NOT EXISTS graph_assertions_object_node_idx
  ON graph_assertions(owner_id, object_node_id, predicate, status)
  WHERE object_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS graph_assertions_scope_idx
  ON graph_assertions(owner_id, scope_node_id, status) WHERE scope_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS graph_assertions_current_idx
  ON graph_assertions(owner_id, status, valid_to_utc, last_observed_at_utc);

CREATE TABLE IF NOT EXISTS assertion_evidence (
    assertion_id TEXT NOT NULL REFERENCES graph_assertions(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
    stance TEXT NOT NULL CHECK (stance IN ('supports', 'contradicts', 'context')),
    weight REAL NOT NULL CHECK (weight >= 0.0 AND weight <= 1.0),
    created_at_utc TEXT NOT NULL,
    PRIMARY KEY (assertion_id, evidence_id, stance)
);

CREATE TABLE IF NOT EXISTS graph_entity_merges (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
    target_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
    basis TEXT NOT NULL,
    reversible INTEGER NOT NULL DEFAULT 1 CHECK (reversible IN (0, 1)),
    created_at_utc TEXT NOT NULL,
    reversed_at_utc TEXT
);

CREATE TABLE IF NOT EXISTS graph_mutation_log (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    actor_type TEXT NOT NULL CHECK (
        actor_type IN ('user', 'system', 'assistant_proposal', 'migration')),
    actor_ref TEXT,
    operation TEXT NOT NULL CHECK (operation IN (
        'create_node', 'update_node', 'merge_node', 'unmerge_node', 'create_assertion',
        'confirm_assertion', 'update_assertion', 'supersede_assertion', 'dispute_assertion',
        'reject_assertion', 'expire_assertion', 'delete_assertion', 'delete_evidence',
        'update_policy')),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reason TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_mutation_target_idx
  ON graph_mutation_log(owner_id, target_type, target_id, created_at_utc);

CREATE TABLE IF NOT EXISTS assistant_policies (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    policy_type TEXT NOT NULL CHECK (policy_type IN (
        'blocked_question_topic', 'never_infer_topic', 'capture_exclusion',
        'do_not_merge_node', 'assertion_lock')),
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    source TEXT NOT NULL CHECK (source IN ('default', 'user', 'migration')),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    UNIQUE(owner_id, policy_type, key)
);

CREATE TABLE IF NOT EXISTS assistant_audit_events (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    summary TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at_utc TEXT NOT NULL
);
`;

export const ASSISTANT_FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
    node_id UNINDEXED, owner_id UNINDEXED,
    display_name, aliases, description, tokenize = 'unicode61');

CREATE VIRTUAL TABLE IF NOT EXISTS graph_assertions_fts USING fts5(
    assertion_id UNINDEXED, owner_id UNINDEXED,
    subject_text, predicate_text, object_text, scope_text, tokenize = 'unicode61');
`;

/**
 * Gate B (migration v41): memory projections and the durable job queue. Projections are rows,
 * not files — `relative_path` exists only so a future export can render a stable .md tree.
 */
export const ASSISTANT_MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_projections (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
    topic_key TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    tokenizer_id TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    included_assertion_ids_json TEXT NOT NULL,
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    generated_at_utc TEXT NOT NULL,
    last_retrieved_at_utc TEXT,
    retrieval_count INTEGER NOT NULL DEFAULT 0,
    utility_score REAL NOT NULL DEFAULT 0.0,
    status TEXT NOT NULL CHECK (status IN ('active', 'demoted', 'archived', 'deleted')),
    UNIQUE(owner_id, tier, topic_key)
);
CREATE INDEX IF NOT EXISTS memory_projections_tier_idx
  ON memory_projections(owner_id, tier, status, utility_score DESC);

CREATE TABLE IF NOT EXISTS assistant_jobs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    priority INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'dead_letter')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    available_at_utc TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at_utc TEXT,
    last_error TEXT,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_jobs_pending_idempotency_uq
  ON assistant_jobs(owner_id, idempotency_key)
  WHERE status IN ('queued', 'running', 'paused');
CREATE INDEX IF NOT EXISTS assistant_jobs_claim_idx
  ON assistant_jobs(status, priority DESC, available_at_utc, created_at_utc);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_projections_fts USING fts5(
    projection_id UNINDEXED, owner_id UNINDEXED, tier UNINDEXED,
    topic_key, content, tokenize = 'unicode61');
`;

/**
 * Seeds the registry tables, the single owner row, and this machine's device row from the
 * TypeScript registries. The registry constants are the source of truth; these rows are their
 * projection, so seeding is a full upsert and is safe to re-run.
 */
export function seedAssistantRegistries(
  database: RuntimeDatabase,
  clock: Clock,
  localDeviceId: string,
): void {
  const nowUtc = clock.nowUtc();

  const insertNodeType = database.prepare(`
    INSERT INTO graph_node_types (name, definition, created_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET definition = excluded.definition
  `);
  for (const nodeType of NODE_TYPES) {
    insertNodeType.run(nodeType, NODE_TYPE_DEFINITIONS[nodeType], nowUtc);
  }

  const insertRelationType = database.prepare(`
    INSERT INTO graph_relation_types (name, definition_json, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      definition_json = excluded.definition_json,
      updated_at_utc = excluded.updated_at_utc
  `);
  for (const predicate of RELATION_TYPES) {
    insertRelationType.run(
      predicate,
      JSON.stringify(RELATION_DEFINITIONS[predicate]),
      nowUtc,
      nowUtc,
    );
  }

  database.prepare(`
    INSERT INTO assistant_owners (id, display_name, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(LOCAL_OWNER_ID, LOCAL_OWNER_DISPLAY_NAME, nowUtc, nowUtc);

  database.prepare(`
    INSERT INTO assistant_devices (
      id, owner_id, platform, display_name, public_key, status, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    localDeviceId, LOCAL_OWNER_ID, process.platform, LOCAL_DEVICE_DISPLAY_NAME, nowUtc, nowUtc,
  );

  database.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(GRAPH_VERSION_METADATA_KEY, '0', nowUtc);

  database.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(LOCAL_DEVICE_METADATA_KEY, localDeviceId, nowUtc);
}