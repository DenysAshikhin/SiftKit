const Database = require('better-sqlite3');
const fs = require('fs');

const out = [];
function log(s) { out.push(s); fs.writeFileSync('.tmp/db-sizes.out', out.join('\n')); }

const db = new Database('.siftkit/runtime.sqlite', { readonly: true });

// Page count & freelist tells us how much space is allocated vs used.
const pageCount = db.prepare('PRAGMA page_count').get();
const pageSize = db.prepare('PRAGMA page_size').get();
const freelistCount = db.prepare('PRAGMA freelist_count').get();
log(`page_size=${pageSize.page_size} page_count=${pageCount.page_count} freelist=${freelistCount.freelist_count}`);
log(`total_bytes_in_pages=${(pageCount.page_count * pageSize.page_size / 1024 / 1024).toFixed(0)} MB`);
log(`free_bytes=${(freelistCount.freelist_count * pageSize.page_size / 1024 / 1024).toFixed(0)} MB`);

// Per-table row counts and approx data sizes.
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
log('\n=== per-table sizes ===');
for (const t of tables) {
  try {
    const c = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get();
    log(`${t.name.padEnd(40)} rows=${String(c.n).padStart(10)}`);
  } catch (e) {
    log(`${t.name.padEnd(40)} ERR ${e.message}`);
  }
}

// dbstat virtual table — shows pages per table.
log('\n=== dbstat per-table page consumption ===');
try {
  const rows = db.prepare(`
    SELECT name, SUM(pageno > 0) AS pages
    FROM dbstat
    GROUP BY name
    ORDER BY pages DESC
    LIMIT 25
  `).all();
  for (const r of rows) {
    log(`${String(r.name).padEnd(50)} pages=${String(r.pages).padStart(10)}  bytes=${((r.pages * 4096) / 1024 / 1024).toFixed(1)} MB`);
  }
} catch (e) {
  log('dbstat unavailable: ' + e.message);
}

// Top managed_llama_log_chunks rows by chunk_text length.
log('\n=== top 10 managed_llama_log_chunks rows by size ===');
const rows = db.prepare(`
  SELECT id, run_id, stream_kind, sequence, LENGTH(chunk_text) AS bytes, created_at_utc
  FROM managed_llama_log_chunks
  ORDER BY LENGTH(chunk_text) DESC
  LIMIT 10
`).all();
for (const r of rows) {
  log(`id=${String(r.id).padStart(5)} run=${String(r.run_id).slice(0,8)} stream=${String(r.stream_kind).padEnd(20)} seq=${String(r.sequence).padStart(5)} bytes=${(r.bytes / 1024 / 1024).toFixed(1)}MB created=${r.created_at_utc}`);
}

// Distribution of chunk sizes.
log('\n=== chunk size distribution ===');
const buckets = db.prepare(`
  SELECT
    CASE
      WHEN LENGTH(chunk_text) < 1000 THEN '< 1 KB'
      WHEN LENGTH(chunk_text) < 100000 THEN '1-100 KB'
      WHEN LENGTH(chunk_text) < 1000000 THEN '100KB-1MB'
      WHEN LENGTH(chunk_text) < 10000000 THEN '1-10 MB'
      WHEN LENGTH(chunk_text) < 100000000 THEN '10-100 MB'
      ELSE '> 100 MB'
    END AS bucket,
    COUNT(*) AS rows,
    SUM(LENGTH(chunk_text)) AS total_bytes
  FROM managed_llama_log_chunks
  GROUP BY bucket
  ORDER BY MIN(LENGTH(chunk_text))
`).all();
for (const b of buckets) {
  log(`${b.bucket.padEnd(15)} rows=${String(b.rows).padStart(6)}  total=${(b.total_bytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
}

db.close();
log('done');
