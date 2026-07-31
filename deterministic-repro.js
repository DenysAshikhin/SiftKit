const http = require('node:http');
const nonPooling = new http.Agent({ keepAlive: false });
function req(url, agent) {
  return new Promise((resolve, reject) => {
    const t = new URL(url);
    const r = http.request({ protocol: t.protocol, hostname: t.hostname, port: t.port, path: t.pathname, method: 'GET', agent }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; }); res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.setTimeout(2000, () => r.destroy(new Error('request timeout')));
    r.end();
  });
}
async function arm(agent, label) {
  const sockets = new Set();
  const server = http.createServer((rq, rs) => { rs.writeHead(200, {'Content-Type':'application/json'}); rs.end('{"ok":true}'); });
  server.on('connection', (s) => sockets.add(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await req(`${base}/health`, agent);
  // The server drops the idle connection (what keepAliveTimeout does), and the client
  // issues its next request in the same tick, before it can observe the close.
  for (const s of sockets) { s.destroy(); }
  let out;
  try { out = `OK ${await req(`${base}/health`, agent)}`; } catch (e) { out = `FAIL:${e.code || e.message}`; }
  await new Promise((r) => server.close(r));
  console.log(`${label}: ${out}`);
}
(async () => { for (let i = 0; i < 5; i += 1) { await arm(undefined, 'globalAgent   '); await arm(nonPooling, 'keepAlive:false'); } })();
