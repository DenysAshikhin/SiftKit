const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getStatusPath() {
  const configuredPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }

  return path.join(process.env.USERPROFILE || os.homedir(), '.siftkit', 'status', 'inference.txt');
}

function ensureDirectory(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function writeStatus(targetPath, statusText) {
  ensureDirectory(targetPath);
  fs.writeFileSync(targetPath, statusText, 'utf8');
}

function ensureStatusFile(targetPath) {
  if (fs.existsSync(targetPath)) {
    return;
  }

  writeStatus(targetPath, 'false');
}

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function logStatus(statusText, targetPath) {
  process.stdout.write(`[siftKitStatus] ${formatTimestamp()} ${statusText} -> ${targetPath}\n`);
}

function logIncomingStatus(statusText, targetPath) {
  process.stdout.write(`[siftKitStatus] ${formatTimestamp()} request ${statusText} -> ${targetPath}\n`);
}

function logStartupPath(targetPath) {
  process.stdout.write(`[siftKitStatus] ${formatTimestamp()} path -> ${targetPath}\n`);
}

function readStatus(targetPath) {
  ensureStatusFile(targetPath);
  if (!fs.existsSync(targetPath)) {
    return 'false';
  }

  return fs.readFileSync(targetPath, 'utf8').trim() || 'false';
}

function parseRunning(bodyText) {
  if (!bodyText || !bodyText.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed.running === 'boolean') {
      return parsed.running;
    }
    if (typeof parsed.status === 'string') {
      return parsed.status.trim().toLowerCase() === 'true';
    }
  } catch {
    const normalized = bodyText.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'false') {
      return normalized === 'true';
    }
  }

  return null;
}

function startStatusServer() {
  const host = process.env.SIFTKIT_STATUS_HOST || '127.0.0.1';
  const requestedPort = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const statusPath = getStatusPath();
  logStartupPath(statusPath);
  ensureStatusFile(statusPath);

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, statusPath }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const currentStatus = readStatus(statusPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: currentStatus === 'true', status: currentStatus, statusPath }));
      return;
    }

    if (req.method === 'POST' && req.url === '/status') {
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        const running = parseRunning(Buffer.concat(chunks).toString('utf8'));
        if (running === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Expected running=true|false or status=true|false.' }));
          return;
        }

        const statusText = running ? 'true' : 'false';
        logIncomingStatus(statusText, statusPath);
        writeStatus(statusPath, statusText);
        logStatus(statusText, statusPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, running, status: statusText, statusPath }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(Number.isFinite(requestedPort) ? requestedPort : 4765, host, () => {
    const address = server.address();
    process.stdout.write(`${JSON.stringify({ ok: true, port: address.port, host, statusPath })}\n`);
  });

  return server;
}

module.exports = {
  startStatusServer
};

if (require.main === module) {
  const server = startStatusServer();
  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
