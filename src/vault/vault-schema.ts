/** Vault notes and their derived indexes (design §3). Links, aliases and tags are rebuilt on every note write. */
export const VAULT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vault_notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL UNIQUE,
    folder TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('entity', 'capture', 'daily', 'chat', 'note')),
    types_json TEXT NOT NULL DEFAULT '[]',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    tags_json TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    is_stub INTEGER NOT NULL CHECK (is_stub IN (0, 1)),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_notes_folder_idx ON vault_notes(folder, title_key);

CREATE TABLE IF NOT EXISTS vault_note_revisions (
    note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    actor TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_ref TEXT,
    title TEXT NOT NULL,
    folder TEXT NOT NULL,
    body TEXT NOT NULL,
    types_json TEXT NOT NULL,
    aliases_json TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    PRIMARY KEY (note_id, revision)
);

CREATE TABLE IF NOT EXISTS vault_links (
    from_note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
    target_key TEXT NOT NULL,
    row_label TEXT,
    line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_links_target_idx ON vault_links(target_key);
CREATE INDEX IF NOT EXISTS vault_links_from_idx ON vault_links(from_note_id);

CREATE TABLE IF NOT EXISTS vault_aliases (
    alias_key TEXT NOT NULL,
    note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
    PRIMARY KEY (alias_key, note_id)
);

CREATE TABLE IF NOT EXISTS vault_tags (
    note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS vault_tags_tag_idx ON vault_tags(tag);

-- The one link-resolution rule: a title beats an alias; among alias owners the oldest note wins.
CREATE VIEW IF NOT EXISTS vault_key_owners AS
SELECT title_key AS key, id AS note_id FROM vault_notes
UNION ALL
SELECT alias_key, note_id FROM (
    SELECT a.alias_key, a.note_id,
        ROW_NUMBER() OVER (PARTITION BY a.alias_key ORDER BY n.created_at_utc, n.id) AS owner_rank
    FROM vault_aliases a JOIN vault_notes n ON n.id = a.note_id
    WHERE a.alias_key NOT IN (SELECT title_key FROM vault_notes)
) WHERE owner_rank = 1;
`;
