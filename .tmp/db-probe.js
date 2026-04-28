const Database = require('better-sqlite3');
const fs = require('fs');

const out = [];
function log(s) { out.push(s); fs.writeFileSync('.tmp/db-probe.out', out.join('\n')); }

try {
  const db = new Database('.siftkit/runtime.sqlite', { readonly: true });
  log('opened');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  log('tables: ' + tables.map(t => t.name).join(', '));

  const tName = 'managed_llama_log_chunks';
  const exists = tables.find(t => t.name === tName);
  if (exists) {
    log('--- schema ---');
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=?").all(tName);
    for (const r of schema) log(r.sql);

    log('--- count (full table) ---');
    const t0 = Date.now();
    const c = db.prepare("SELECT COUNT(*) AS n FROM " + tName).get();
    log('rows: ' + c.n + ' took ' + (Date.now() - t0) + ' ms');

    log('--- distinct run_ids ---');
    const t1 = Date.now();
    const runs = db.prepare("SELECT run_id, COUNT(*) AS n, SUM(LENGTH(chunk_text)) AS chars FROM " + tName + " GROUP BY run_id ORDER BY chars DESC LIMIT 5").all();
    log('took ' + (Date.now() - t1) + ' ms');
    for (const r of runs) log('  run_id=' + String(r.run_id).slice(0, 30) + ' chunks=' + r.n + ' chars=' + r.chars);

    if (runs.length > 0) {
      const topRunId = runs[0].run_id;
      log('--- query for top run_id (mimics /status route handler) ---');
      const t2 = Date.now();
      const rows = db.prepare("SELECT stream_kind, chunk_text FROM " + tName + " WHERE run_id = ? ORDER BY stream_kind ASC, sequence ASC, id ASC").all(topRunId);
      const elapsed = Date.now() - t2;
      const chars = rows.reduce((acc, r) => acc + (r.chunk_text || '').length, 0);
      log('rows=' + rows.length + ' chars=' + chars + ' took ' + elapsed + ' ms');
    }
  } else {
    log('table does not exist!');
  }

  db.close();
  log('done');
} catch (e) {
  log('ERROR: ' + e.message + '\n' + (e.stack || ''));
}
