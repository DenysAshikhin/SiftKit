const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getRuntimeRoot() {
  const configuredPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
  if (configuredPath && configuredPath.trim()) {
    const statusPath = path.resolve(configuredPath);
    const statusDirectory = path.dirname(statusPath);
    if (path.basename(statusDirectory).toLowerCase() === 'status') {
      return path.dirname(statusDirectory);
    }

    return statusDirectory;
  }

  return path.join(process.env.USERPROFILE || os.homedir(), '.siftkit');
}

function getStatusPath() {
  const configuredPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }

  return path.join(getRuntimeRoot(), 'status', 'inference.txt');
}

function getConfigPath() {
  const configuredPath = process.env.SIFTKIT_CONFIG_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }

  return path.join(getRuntimeRoot(), 'config.json');
}

function ensureDirectory(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function writeText(targetPath, content) {
  ensureDirectory(targetPath);
  fs.writeFileSync(targetPath, content, 'utf8');
}

function ensureStatusFile(targetPath) {
  if (!fs.existsSync(targetPath)) {
    writeText(targetPath, 'false');
  }
}

function getDefaultConfig() {
  return {
    Version: '0.1.0',
    Backend: 'ollama',
    Model: 'qwen3.5:9b-q4_K_M',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    Ollama: {
      BaseUrl: 'http://127.0.0.1:11434',
      ExecutablePath: null,
      NumCtx: 128000,
      Temperature: 0.2,
      TopP: 0.95,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 0.0,
      RepetitionPenalty: 1.0
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
      ChunkThresholdRatio: 0.92
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: ['git', 'less', 'vim', 'sqlite3'],
      IdleTimeoutMs: 900000,
      MaxTranscriptCharacters: 60000,
      TranscriptRetention: true
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeConfig(baseValue, patchValue) {
  if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
    return patchValue.slice();
  }

  if (
    baseValue &&
    patchValue &&
    typeof baseValue === 'object' &&
    typeof patchValue === 'object' &&
    !Array.isArray(baseValue) &&
    !Array.isArray(patchValue)
  ) {
    const merged = { ...baseValue };
    for (const [key, value] of Object.entries(patchValue)) {
      if (key === 'Paths') {
        continue;
      }

      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    return merged;
  }

  return patchValue;
}

function normalizeConfig(input) {
  const merged = mergeConfig(getDefaultConfig(), input || {});
  delete merged.Paths;
  if (merged.Thresholds && typeof merged.Thresholds === 'object') {
    delete merged.Thresholds.MaxInputCharacters;
  }
  return merged;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return normalizeConfig({});
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return normalizeConfig(parsed);
  } catch {
    return normalizeConfig({});
  }
}

function writeConfig(configPath, config) {
  writeText(configPath, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
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

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(Math.floor(milliseconds / 1000), 0);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function buildStatusRequestLogMessage({
  running,
  statusPath,
  characterCount = null,
  promptCharacterCount = null,
  rawInputCharacterCount = null,
  chunkInputCharacterCount = null,
  chunkIndex = null,
  chunkTotal = null,
  elapsedMs = null,
  totalElapsedMs = null
}) {
  const statusText = running ? 'true' : 'false';
  let logMessage = `request ${statusText}`;

  if (running) {
    const resolvedPromptCharacterCount = promptCharacterCount ?? characterCount;
    if (rawInputCharacterCount !== null) {
      logMessage += ` raw_chars=${rawInputCharacterCount}`;
    }
    if (chunkInputCharacterCount !== null) {
      logMessage += ` chunk_input_chars=${chunkInputCharacterCount}`;
    }
    if (resolvedPromptCharacterCount !== null) {
      logMessage += ` prompt_chars=${resolvedPromptCharacterCount}`;
    }
    if (chunkIndex !== null && chunkTotal !== null) {
      logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
    }
  } else if (totalElapsedMs !== null) {
    logMessage += ` total_elapsed=${formatElapsed(totalElapsedMs)}`;
  } else if (elapsedMs !== null) {
    logMessage += ` elapsed=${formatElapsed(elapsedMs)}`;
  }

  return logMessage;
}

function logLine(message) {
  process.stdout.write(`${formatTimestamp()} ${message}\n`);
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

function parseStatusMetadata(bodyText) {
  const metadata = {
    promptCharacterCount: null,
    rawInputCharacterCount: null,
    chunkInputCharacterCount: null,
    chunkIndex: null,
    chunkTotal: null
  };

  if (!bodyText || !bodyText.trim()) {
    return metadata;
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (Number.isFinite(parsed.promptCharacterCount) && parsed.promptCharacterCount >= 0) {
      metadata.promptCharacterCount = parsed.promptCharacterCount;
    } else if (Number.isFinite(parsed.characterCount) && parsed.characterCount >= 0) {
      metadata.promptCharacterCount = parsed.characterCount;
    }
    if (Number.isFinite(parsed.rawInputCharacterCount) && parsed.rawInputCharacterCount >= 0) {
      metadata.rawInputCharacterCount = parsed.rawInputCharacterCount;
    }
    if (Number.isFinite(parsed.chunkInputCharacterCount) && parsed.chunkInputCharacterCount >= 0) {
      metadata.chunkInputCharacterCount = parsed.chunkInputCharacterCount;
    }
    if (Number.isFinite(parsed.chunkIndex) && parsed.chunkIndex > 0) {
      metadata.chunkIndex = parsed.chunkIndex;
    }
    if (Number.isFinite(parsed.chunkTotal) && parsed.chunkTotal > 0) {
      metadata.chunkTotal = parsed.chunkTotal;
    }
  } catch {
    return metadata;
  }

  return metadata;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function startStatusServer() {
  const host = process.env.SIFTKIT_STATUS_HOST || '127.0.0.1';
  const requestedPort = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const statusPath = getStatusPath();
  const configPath = getConfigPath();
  ensureStatusFile(statusPath);
  writeConfig(configPath, readConfig(configPath));
  const activeRunsByStatusPath = new Map();

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        statusPath,
        configPath,
        runtimeRoot: getRuntimeRoot()
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const currentStatus = fs.readFileSync(statusPath, 'utf8').trim() || 'false';
      sendJson(res, 200, { running: currentStatus === 'true', status: currentStatus, statusPath, configPath });
      return;
    }

    if (req.method === 'POST' && req.url === '/status') {
      const bodyText = await readBody(req);
      const running = parseRunning(bodyText);
      if (running === null) {
        sendJson(res, 400, { error: 'Expected running=true|false or status=true|false.' });
        return;
      }

      const statusText = running ? 'true' : 'false';
      const metadata = parseStatusMetadata(bodyText);
      let elapsedMs = null;
      let totalElapsedMs = null;
      if (running) {
        const now = Date.now();
        const existingRun = activeRunsByStatusPath.get(statusPath);
        const isChunkedRequest = metadata.chunkIndex !== null && metadata.chunkTotal !== null;
        let runState = existingRun;

        if (!runState) {
          runState = {
            overallStartedAt: now,
            currentRequestStartedAt: now,
            sawChunked: false,
            lastChunkIndex: null,
            lastChunkTotal: null,
            pendingFinalMerge: false
          };
        } else {
          runState.currentRequestStartedAt = now;
        }

        if (isChunkedRequest) {
          runState.sawChunked = true;
          runState.lastChunkIndex = metadata.chunkIndex;
          runState.lastChunkTotal = metadata.chunkTotal;
          runState.pendingFinalMerge = false;
        } else if (runState.sawChunked) {
          runState.pendingFinalMerge = true;
        }

        activeRunsByStatusPath.set(statusPath, runState);
      } else {
        const runState = activeRunsByStatusPath.get(statusPath);
        if (runState && Number.isFinite(runState.currentRequestStartedAt)) {
          const now = Date.now();
          elapsedMs = now - runState.currentRequestStartedAt;
          if (runState.sawChunked) {
            if (runState.pendingFinalMerge) {
              totalElapsedMs = now - runState.overallStartedAt;
              activeRunsByStatusPath.delete(statusPath);
            }
          } else {
            activeRunsByStatusPath.delete(statusPath);
          }
        }
      }
      const logMessage = buildStatusRequestLogMessage({
        running,
        statusPath,
        promptCharacterCount: metadata.promptCharacterCount,
        rawInputCharacterCount: metadata.rawInputCharacterCount,
        chunkInputCharacterCount: metadata.chunkInputCharacterCount,
        chunkIndex: metadata.chunkIndex,
        chunkTotal: metadata.chunkTotal,
        elapsedMs,
        totalElapsedMs
      });
      logLine(logMessage);
      writeText(statusPath, statusText);
      sendJson(res, 200, { ok: true, running, status: statusText, statusPath, configPath });
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      sendJson(res, 200, readConfig(configPath));
      return;
    }

    if (req.method === 'PUT' && req.url === '/config') {
      let parsedBody;
      try {
        parsedBody = JSON.parse(await readBody(req) || '{}');
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }

      const nextConfig = normalizeConfig(mergeConfig(readConfig(configPath), parsedBody));
      writeConfig(configPath, nextConfig);
      sendJson(res, 200, nextConfig);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  server.listen(Number.isFinite(requestedPort) ? requestedPort : 4765, host, () => {
    const address = server.address();
    process.stdout.write(`${JSON.stringify({ ok: true, port: address.port, host, statusPath, configPath })}\n`);
  });

  return server;
}

module.exports = {
  buildStatusRequestLogMessage,
  formatElapsed,
  getConfigPath,
  getStatusPath,
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
