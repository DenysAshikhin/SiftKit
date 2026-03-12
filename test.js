const fs = require('fs');
const http = require('http');
const path = require('path');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) {
    continue;
  }
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) {
    args.set(key, 'true');
    continue;
  }
  args.set(key, next);
  i += 1;
}

const defaultPromptPath = path.join(
  process.env.TEMP || process.env.TMP || '.',
  'siftkit-num-predict-10k-experiment',
  'window-0000-prompt.txt'
);

const promptFile = args.get('prompt-file') || defaultPromptPath;
const model = args.get('model') || 'qwen3.5:9b-q4_K_M';
const host = args.get('host') || '127.0.0.1';
const port = Number(args.get('port') || '11434');
const numCtx = Number(args.get('num-ctx') || '140000');
const numPredict = Number(args.get('num-predict') || '1000');
const timeoutSeconds = Number(args.get('timeout-seconds') || '180');
const useSmallPrompt = args.get('small') === 'true';

function logStep(label, detail) {
  const suffix = detail ? `: ${detail}` : '';
  process.stdout.write(`${label}${suffix}\n`);
}

function timed(label, fn) {
  const started = Date.now();
  const value = fn();
  logStep(`${label} ms`, String(Date.now() - started));
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const startedAt = Date.now();
logStep('Reading prompt', useSmallPrompt ? 'inline small prompt' : promptFile);

let prompt;
if (useSmallPrompt) {
  prompt = 'Summarize this briefly: hello world hello world hello world';
} else {
  if (!fs.existsSync(promptFile)) {
    fail(`Prompt file not found: ${promptFile}`);
  }
  prompt = timed('Read prompt', () => fs.readFileSync(promptFile, 'utf8'));
}
if (useSmallPrompt) {
  logStep('Read prompt ms', '0');
}

logStep('Prompt chars', String(prompt.length));

const requestBodyObject = {
  model,
  prompt,
  stream: false,
  think: false,
  options: {
    temperature: 0.2,
    top_p: 0.95,
    top_k: 20,
    min_p: 0.0,
    presence_penalty: 0.0,
    repeat_penalty: 1.0,
    num_ctx: numCtx,
    num_predict: numPredict,
  },
};

logStep('Serializing request');
const requestBody = timed('Serialize request', () => JSON.stringify(requestBodyObject));
logStep('Request bytes', String(Buffer.byteLength(requestBody, 'utf8')));

const requestStartedAt = Date.now();
let firstByteAt = null;
const req = http.request(
  {
    hostname: host,
    port,
    path: '/api/generate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody, 'utf8'),
    },
    timeout: timeoutSeconds * 1000,
  },
  (res) => {
    let responseText = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      if (firstByteAt === null) {
        firstByteAt = Date.now();
        logStep('First byte ms', String(firstByteAt - requestStartedAt));
      }
      responseText += chunk;
    });
    res.on('end', () => {
      const responseEndAt = Date.now();
      const elapsedMs = responseEndAt - requestStartedAt;
      logStep('HTTP status', String(res.statusCode || 0));
      logStep('Request ms', String(elapsedMs));
      logStep('Response bytes', String(Buffer.byteLength(responseText, 'utf8')));
      if (firstByteAt !== null) {
        logStep('Read response ms', String(responseEndAt - firstByteAt));
      }
      logStep('Total ms', String(Date.now() - startedAt));

      if (!responseText) {
        fail('Empty response body.');
      }

      let parsed;
      try {
        parsed = timed('Parse response', () => JSON.parse(responseText));
      } catch (error) {
        process.stdout.write(responseText + '\n');
        fail(`Response was not valid JSON: ${error.message}`);
      }

      process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
      if (res.statusCode && res.statusCode >= 400) {
        process.exit(1);
      }
    });
  }
);

req.on('timeout', () => {
  req.destroy(new Error(`Request timed out after ${timeoutSeconds} seconds.`));
});

req.on('error', (error) => {
  fail(`Request failed: ${error.message}`);
});

logStep('Posting request', `http://${host}:${port}/api/generate`);
req.write(requestBody);
req.end();
