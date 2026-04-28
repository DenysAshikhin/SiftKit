/**
 * Profile per-iteration overhead of summary vs repo-search tool loops.
 *
 * Goal: confirm the user's observation that summary requests have ~3-4 s gaps
 * between consecutive provider calls while repo-search has ~1-1.5 s gaps. The
 * script is black-box: it submits identical workloads sequentially against an
 * already-running dev server, then parses the dev server's trace log lines to
 * attribute time to phases (LLM call, tokenize, residual).
 *
 * Prerequisites for the dev server (run BEFORE this script):
 *   - SIFTKIT_TRACE_SUMMARY=1
 *   - SIFTKIT_TRACE_REPO_SEARCH=1
 *   - stdout + stderr captured to a file (tee or shell redirection)
 *
 * Usage:
 *   tsx scripts/profile-tool-loop-overhead.ts \
 *     --log <path>                          # log file the dev server writes to
 *     --input <file>                        # text fed to summary --inputText
 *     --question "<text>"                   # prompt for both endpoints
 *     [--repo-root <path>]                  # for repo-search (defaults to cwd)
 *     [--summary-only | --repo-search-only]
 *     [--status-host 127.0.0.1] [--status-port 4765]
 *     [--out <md-path>]                     # write report to file (else stdout)
 *
 * Why this works without source modification:
 *   Trace lines fired by the existing tracers (src/lib/trace.ts) include ms-
 *   resolution ISO timestamps and an explicit elapsed_ms for tokenize and
 *   generate calls. We bracket each request by wall-clock start/end and slice
 *   the log to that window.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

type Cli = {
  log: string;
  input: string | null;
  question: string | null;
  repoRoot: string;
  summaryOnly: boolean;
  repoSearchOnly: boolean;
  statusHost: string;
  statusPort: number;
  out: string | null;
  flushMs: number;
  analyzeOnly: boolean;
};

function parseCli(argv: string[]): Cli {
  const args = argv.slice(2);
  const get = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const log = get('--log');
  if (!log) throw new Error('--log <path> is required (the dev server log file).');

  const analyzeOnly = has('--analyze-only');
  const summaryOnly = has('--summary-only');
  const repoSearchOnly = has('--repo-search-only');
  if (summaryOnly && repoSearchOnly) {
    throw new Error('--summary-only and --repo-search-only are mutually exclusive.');
  }

  const question = get('--question');
  const input = get('--input');

  if (!analyzeOnly) {
    if (!question) throw new Error('--question "<text>" is required (or use --analyze-only).');
    if (!repoSearchOnly && !input) {
      throw new Error('--input <file> is required for summary requests (or use --analyze-only).');
    }
  }

  const flushRaw = get('--flush-ms');
  const flushMs = flushRaw ? Number.parseInt(flushRaw, 10) : 750;

  return {
    log: path.resolve(log),
    input: input ? path.resolve(input) : null,
    question,
    repoRoot: path.resolve(get('--repo-root') || process.cwd()),
    summaryOnly,
    repoSearchOnly,
    statusHost: get('--status-host') || process.env.SIFTKIT_STATUS_HOST || '127.0.0.1',
    statusPort: Number.parseInt(get('--status-port') || process.env.SIFTKIT_STATUS_PORT || '4765', 10),
    out: get('--out'),
    flushMs: Number.isFinite(flushMs) && flushMs > 0 ? flushMs : 750,
    analyzeOnly,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers — minimal, no project imports so the script runs standalone
// ---------------------------------------------------------------------------

type RequestOptions = {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  timeoutMs?: number;
};

function httpRequest(options: RequestOptions): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(options.body) }
          : undefined,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { buf += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: buf }));
      },
    );
    req.on('error', reject);
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${options.timeoutMs} ms`));
      });
    }
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function checkServerReachable(host: string, port: number): Promise<boolean> {
  try {
    const res = await httpRequest({ url: `http://${host}:${port}/health`, method: 'GET', timeoutMs: 2000 });
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Log parsing — two formats coexist in the dev server output:
//   1. status-server stdout:  "YYYY-MM-DD HH:MM:SS request true task=summary ..."
//   2. tracer stderr:         "[siftkit-trace 2026-04-28T01:52:33.123Z] label message"
// ---------------------------------------------------------------------------

type ParsedEvent = {
  timestampMs: number;          // wall-clock ms (epoch)
  kind: 'tokenize_start' | 'tokenize_done' | 'generate_start' | 'generate_done'
       | 'request_true' | 'request_false' | 'notify_running_true' | 'notify_running_false'
       | 'execute_start' | 'execute_completed'
       | 'tokenize_error' | 'generate_error';
  taskKind?: string;             // for request_true/false
  elapsedMs?: number;             // for tokenize_done, generate_done, notify_running_false
  chars?: number;                 // for tokenize_start, generate_start
  tokens?: number;                // for tokenize_done
  raw: string;                    // full log line
};

const TRACE_LINE_RE = /^\[siftkit-trace ([^\]]+)\]\s+(\S+)\s+(.*)$/u;
const STATUS_LINE_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)$/u;
const KV_RE = /(\w+)=(\S+)/gu;

function parseKv(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of message.matchAll(KV_RE)) {
    out[m[1]] = m[2];
  }
  return out;
}

function parseLine(line: string): ParsedEvent | null {
  const traceMatch = TRACE_LINE_RE.exec(line);
  if (traceMatch) {
    const iso = traceMatch[1];
    const label = traceMatch[2];
    const message = traceMatch[3];
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return null;
    const kv = parseKv(message);

    if (label === 'llama-cpp') {
      if (message.startsWith('tokenize start')) {
        return { timestampMs: ts, kind: 'tokenize_start', chars: Number(kv.chars) || 0, raw: line };
      }
      if (message.startsWith('tokenize done')) {
        return { timestampMs: ts, kind: 'tokenize_done', elapsedMs: Number(kv.elapsed_ms) || 0, tokens: Number(kv.tokens) || 0, raw: line };
      }
      if (message.startsWith('tokenize error') || message.startsWith('tokenize http_error')) {
        return { timestampMs: ts, kind: 'tokenize_error', elapsedMs: Number(kv.elapsed_ms) || 0, raw: line };
      }
      if (message.startsWith('generate start')) {
        return { timestampMs: ts, kind: 'generate_start', chars: Number(kv.prompt_chars) || 0, raw: line };
      }
      if (message.startsWith('generate done')) {
        return { timestampMs: ts, kind: 'generate_done', elapsedMs: Number(kv.elapsed_ms) || 0, raw: line };
      }
      if (message.startsWith('generate error') || message.startsWith('generate http_error') || message.startsWith('generate empty_body')) {
        return { timestampMs: ts, kind: 'generate_error', elapsedMs: Number(kv.elapsed_ms) || 0, raw: line };
      }
      return null;
    }

    if (label === 'summary') {
      if (message.startsWith('notify running=true')) {
        return { timestampMs: ts, kind: 'notify_running_true', raw: line };
      }
      if (message.startsWith('notify running=false')) {
        return { timestampMs: ts, kind: 'notify_running_false', elapsedMs: Number(kv.duration_ms) || 0, raw: line };
      }
      return null;
    }

    if (label === 'repo-search') {
      if (message.startsWith('execute start')) {
        return { timestampMs: ts, kind: 'execute_start', raw: line };
      }
      if (message.startsWith('execute completed') || message.startsWith('execute failed')) {
        return { timestampMs: ts, kind: 'execute_completed', elapsedMs: Number(kv.duration_ms) || 0, raw: line };
      }
      return null;
    }

    return null;
  }

  const statusMatch = STATUS_LINE_RE.exec(line);
  if (statusMatch) {
    const ts = Date.parse(statusMatch[1].replace(' ', 'T') + 'Z');
    if (!Number.isFinite(ts)) return null;
    const message = statusMatch[2];
    const kv = parseKv(message);
    if (message.startsWith('request true')) {
      return { timestampMs: ts, kind: 'request_true', taskKind: kv.task, raw: line };
    }
    if (message.startsWith('request false')) {
      return { timestampMs: ts, kind: 'request_false', taskKind: kv.task, raw: line };
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Workload submission
// ---------------------------------------------------------------------------

async function submitSummary(cli: Cli, inputText: string): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  const startedAt = Date.now();
  try {
    const res = await httpRequest({
      url: `http://${cli.statusHost}:${cli.statusPort}/summary`,
      method: 'POST',
      timeoutMs: 10 * 60 * 1000,
      body: JSON.stringify({
        question: cli.question,
        inputText,
        format: 'text',
        policyProfile: 'general',
      }),
    });
    if (res.statusCode >= 400) {
      return { ok: false, durationMs: Date.now() - startedAt, error: `HTTP ${res.statusCode}: ${res.body.slice(0, 500)}` };
    }
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

async function submitRepoSearch(cli: Cli): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  const startedAt = Date.now();
  try {
    const res = await httpRequest({
      url: `http://${cli.statusHost}:${cli.statusPort}/repo-search`,
      method: 'POST',
      timeoutMs: 10 * 60 * 1000,
      body: JSON.stringify({
        prompt: cli.question,
        repoRoot: cli.repoRoot,
      }),
    });
    if (res.statusCode >= 400) {
      return { ok: false, durationMs: Date.now() - startedAt, error: `HTTP ${res.statusCode}: ${res.body.slice(0, 500)}` };
    }
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Log slicing
// ---------------------------------------------------------------------------

function detectEncoding(buf: Buffer): 'utf8' | 'utf16le' | 'utf16be' {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  // Heuristic: if every other byte in the first 64 bytes is 0x00, it's UTF-16 LE without BOM.
  const sample = buf.slice(0, Math.min(64, buf.length));
  if (sample.length >= 8) {
    let zeroEvenCount = 0;
    for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0x00) zeroEvenCount += 1;
    if (zeroEvenCount > sample.length / 4) return 'utf16le';
  }
  return 'utf8';
}

function decodeBuffer(buf: Buffer): string {
  const encoding = detectEncoding(buf);
  if (encoding === 'utf16le') {
    // Strip BOM if present.
    const start = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0;
    return buf.slice(start).toString('utf16le');
  }
  if (encoding === 'utf16be') {
    // Node doesn't have utf16be, swap bytes then decode as utf16le.
    const start = 2;
    const swapped = Buffer.alloc(buf.length - start);
    for (let i = start; i + 1 < buf.length; i += 2) {
      swapped[i - start] = buf[i + 1];
      swapped[i - start + 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  // Strip UTF-8 BOM if present.
  const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  return buf.slice(start).toString('utf8');
}

function readLogTailFromOffset(logPath: string, byteOffset: number): string {
  const stat = fs.statSync(logPath);
  if (stat.size <= byteOffset) return '';
  const fd = fs.openSync(logPath, 'r');
  try {
    const length = stat.size - byteOffset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, byteOffset);
    return decodeBuffer(buf);
  } finally {
    fs.closeSync(fd);
  }
}

function getLogSize(logPath: string): number {
  try {
    return fs.statSync(logPath).size;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Iteration aggregation
// ---------------------------------------------------------------------------

type Iteration = {
  index: number;
  generateStartMs: number;
  generateEndMs: number;
  generateElapsedMs: number;        // from generate done
  promptChars: number;               // from generate start
  // Events between this iteration's generate_done and the next iteration's generate_start.
  // For the last iteration: events between its generate_done and a sentinel end timestamp.
  postIterTokenizeCount: number;
  postIterTokenizeMs: number;
  postIterTokenizeChars: number;
  preIterTokenizeCount: number;     // tokenize calls between prev generate_done and THIS generate_start
  preIterTokenizeMs: number;
  preIterTokenizeChars: number;
  gapBeforeMs: number;               // wall-clock from prev generate_done to this generate_start; null for first
  gapAfterMs: number;                // wall-clock from this generate_done to next generate_start
};

type RequestProfile = {
  taskKind: 'summary' | 'repo-search';
  ok: boolean;
  error?: string;
  wallDurationMs: number;             // outer HTTP request wall time
  windowStartMs: number;
  windowEndMs: number;
  iterations: Iteration[];
  totalGenerateMs: number;
  totalTokenizeCalls: number;
  totalTokenizeMs: number;
  totalGapMs: number;                 // sum of (wallDurationMs of all "between iteration" segments)
  totalResidualMs: number;            // total non-LLM, non-tokenize time inside the request
};

function aggregateProfile(taskKind: 'summary' | 'repo-search', windowStartMs: number, windowEndMs: number, events: ParsedEvent[]): RequestProfile {
  const inWindow = events
    .filter((e) => e.timestampMs >= windowStartMs && e.timestampMs <= windowEndMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  // Build iterations from generate_start / generate_done pairs.
  const iterations: Iteration[] = [];
  let pendingStart: ParsedEvent | null = null;
  for (const e of inWindow) {
    if (e.kind === 'generate_start') {
      pendingStart = e;
    } else if (e.kind === 'generate_done' && pendingStart) {
      iterations.push({
        index: iterations.length,
        generateStartMs: pendingStart.timestampMs,
        generateEndMs: e.timestampMs,
        generateElapsedMs: e.elapsedMs ?? (e.timestampMs - pendingStart.timestampMs),
        promptChars: pendingStart.chars ?? 0,
        postIterTokenizeCount: 0,
        postIterTokenizeMs: 0,
        postIterTokenizeChars: 0,
        preIterTokenizeCount: 0,
        preIterTokenizeMs: 0,
        preIterTokenizeChars: 0,
        gapBeforeMs: 0,
        gapAfterMs: 0,
      });
      pendingStart = null;
    }
  }

  // Attribute tokenize calls to "pre" and "post" buckets relative to neighboring iterations.
  for (let i = 0; i < iterations.length; i += 1) {
    const iter = iterations[i];
    const prevEnd = i === 0 ? windowStartMs : iterations[i - 1].generateEndMs;
    const nextStart = i === iterations.length - 1 ? windowEndMs : iterations[i + 1].generateStartMs;
    iter.gapBeforeMs = iter.generateStartMs - prevEnd;
    iter.gapAfterMs = nextStart - iter.generateEndMs;

    // "Pre" = tokenize calls between prevEnd and this iteration's generate_start.
    // For matching tokenize_start with tokenize_done, walk pairs.
    const tokenizeDoneInPre = inWindow.filter(
      (e) => e.kind === 'tokenize_done' && e.timestampMs >= prevEnd && e.timestampMs < iter.generateStartMs
    );
    iter.preIterTokenizeCount = tokenizeDoneInPre.length;
    iter.preIterTokenizeMs = tokenizeDoneInPre.reduce((sum, e) => sum + (e.elapsedMs ?? 0), 0);
    const tokenizeStartInPre = inWindow.filter(
      (e) => e.kind === 'tokenize_start' && e.timestampMs >= prevEnd && e.timestampMs < iter.generateStartMs
    );
    iter.preIterTokenizeChars = tokenizeStartInPre.reduce((sum, e) => sum + (e.chars ?? 0), 0);

    // "Post" = tokenize calls between this iteration's generate_done and the next start.
    const tokenizeDoneInPost = inWindow.filter(
      (e) => e.kind === 'tokenize_done' && e.timestampMs >= iter.generateEndMs && e.timestampMs < nextStart
    );
    iter.postIterTokenizeCount = tokenizeDoneInPost.length;
    iter.postIterTokenizeMs = tokenizeDoneInPost.reduce((sum, e) => sum + (e.elapsedMs ?? 0), 0);
    const tokenizeStartInPost = inWindow.filter(
      (e) => e.kind === 'tokenize_start' && e.timestampMs >= iter.generateEndMs && e.timestampMs < nextStart
    );
    iter.postIterTokenizeChars = tokenizeStartInPost.reduce((sum, e) => sum + (e.chars ?? 0), 0);
  }

  const totalGenerateMs = iterations.reduce((sum, it) => sum + it.generateElapsedMs, 0);
  const allTokenizeDone = inWindow.filter((e) => e.kind === 'tokenize_done');
  const totalTokenizeCalls = allTokenizeDone.length;
  const totalTokenizeMs = allTokenizeDone.reduce((sum, e) => sum + (e.elapsedMs ?? 0), 0);

  // "Gap" = sum of all between-generate intervals (wall-clock).
  let totalGapMs = 0;
  for (let i = 0; i < iterations.length - 1; i += 1) {
    totalGapMs += iterations[i + 1].generateStartMs - iterations[i].generateEndMs;
  }

  const totalWindowMs = windowEndMs - windowStartMs;
  const totalResidualMs = Math.max(0, totalWindowMs - totalGenerateMs - totalTokenizeMs);

  return {
    taskKind,
    ok: true,
    wallDurationMs: totalWindowMs,
    windowStartMs,
    windowEndMs,
    iterations,
    totalGenerateMs,
    totalTokenizeCalls,
    totalTokenizeMs,
    totalGapMs,
    totalResidualMs,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmtMs(ms: number): string {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function buildPerIterationTable(profile: RequestProfile): string {
  const header = '| iter | gen_ms | prompt_chars | post_tk# | post_tk_ms | post_tk_chars | gap_after_ms | residual_ms (gap − post_tk) |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = profile.iterations.map((it) => {
    const residual = Math.max(0, it.gapAfterMs - it.postIterTokenizeMs);
    return `| ${it.index} | ${fmtMs(it.generateElapsedMs)} | ${fmtInt(it.promptChars)} | ${it.postIterTokenizeCount} | ${fmtMs(it.postIterTokenizeMs)} | ${fmtInt(it.postIterTokenizeChars)} | ${fmtMs(it.gapAfterMs)} | ${fmtMs(residual)} |`;
  });
  return [header, sep, ...rows].join('\n');
}

function buildSummaryTable(profile: RequestProfile, label: string): string {
  const gaps = profile.iterations.map((it) => it.gapAfterMs).slice(0, -1);
  const postTokenizeMs = profile.iterations.map((it) => it.postIterTokenizeMs).slice(0, -1);
  const postTokenizeCounts = profile.iterations.map((it) => it.postIterTokenizeCount).slice(0, -1);
  const generateMs = profile.iterations.map((it) => it.generateElapsedMs);

  const lines = [
    `### ${label}`,
    '',
    `- Total wall-clock: **${fmtMs(profile.wallDurationMs)}**`,
    `- Iterations: **${profile.iterations.length}**`,
    `- Total LLM generate time: **${fmtMs(profile.totalGenerateMs)}** (${((profile.totalGenerateMs / profile.wallDurationMs) * 100).toFixed(1)}%)`,
    `- Total tokenize time: **${fmtMs(profile.totalTokenizeMs)}** across **${profile.totalTokenizeCalls}** calls (${((profile.totalTokenizeMs / profile.wallDurationMs) * 100).toFixed(1)}%)`,
    `- Total gap (between provider calls): **${fmtMs(profile.totalGapMs)}**`,
    `- Residual (window − generate − tokenize): **${fmtMs(profile.totalResidualMs)}**`,
    '',
    '| Phase | mean | p50 | p95 |',
    '| --- | --- | --- | --- |',
    `| LLM generate per iter | ${fmtMs(mean(generateMs))} | ${fmtMs(quantile(generateMs, 0.5))} | ${fmtMs(quantile(generateMs, 0.95))} |`,
    `| Gap between provider calls | ${fmtMs(mean(gaps))} | ${fmtMs(quantile(gaps, 0.5))} | ${fmtMs(quantile(gaps, 0.95))} |`,
    `| Post-iter tokenize total ms | ${fmtMs(mean(postTokenizeMs))} | ${fmtMs(quantile(postTokenizeMs, 0.5))} | ${fmtMs(quantile(postTokenizeMs, 0.95))} |`,
    `| Post-iter tokenize calls | ${mean(postTokenizeCounts).toFixed(2)} | ${quantile(postTokenizeCounts, 0.5).toFixed(0)} | ${quantile(postTokenizeCounts, 0.95).toFixed(0)} |`,
  ];
  return lines.join('\n');
}

function buildComparisonTable(summary: RequestProfile | null, repo: RequestProfile | null): string {
  const rows: Array<{ label: string; summary: string; repo: string }> = [];

  const fmtAvg = (values: number[]): string => values.length === 0 ? '—' : fmtMs(mean(values));
  const fmtAvgInt = (values: number[]): string => values.length === 0 ? '—' : mean(values).toFixed(2);

  const summaryGaps = summary?.iterations.map((it) => it.gapAfterMs).slice(0, -1) ?? [];
  const repoGaps = repo?.iterations.map((it) => it.gapAfterMs).slice(0, -1) ?? [];
  const summaryTokMs = summary?.iterations.map((it) => it.postIterTokenizeMs).slice(0, -1) ?? [];
  const repoTokMs = repo?.iterations.map((it) => it.postIterTokenizeMs).slice(0, -1) ?? [];
  const summaryTokCount = summary?.iterations.map((it) => it.postIterTokenizeCount).slice(0, -1) ?? [];
  const repoTokCount = repo?.iterations.map((it) => it.postIterTokenizeCount).slice(0, -1) ?? [];
  const summaryGen = summary?.iterations.map((it) => it.generateElapsedMs) ?? [];
  const repoGen = repo?.iterations.map((it) => it.generateElapsedMs) ?? [];

  rows.push({ label: 'Iterations', summary: summary ? String(summary.iterations.length) : '—', repo: repo ? String(repo.iterations.length) : '—' });
  rows.push({ label: 'Wall-clock total', summary: summary ? fmtMs(summary.wallDurationMs) : '—', repo: repo ? fmtMs(repo.wallDurationMs) : '—' });
  rows.push({ label: 'LLM generate per iter (mean)', summary: fmtAvg(summaryGen), repo: fmtAvg(repoGen) });
  rows.push({ label: 'Gap between provider calls (mean)', summary: fmtAvg(summaryGaps), repo: fmtAvg(repoGaps) });
  rows.push({ label: 'Post-iter tokenize calls (mean)', summary: fmtAvgInt(summaryTokCount), repo: fmtAvgInt(repoTokCount) });
  rows.push({ label: 'Post-iter tokenize total ms (mean)', summary: fmtAvg(summaryTokMs), repo: fmtAvg(repoTokMs) });
  rows.push({ label: 'Total tokenize calls', summary: summary ? String(summary.totalTokenizeCalls) : '—', repo: repo ? String(repo.totalTokenizeCalls) : '—' });
  rows.push({ label: 'Total tokenize ms', summary: summary ? fmtMs(summary.totalTokenizeMs) : '—', repo: repo ? fmtMs(repo.totalTokenizeMs) : '—' });
  rows.push({ label: 'Residual (wall − gen − tokenize)', summary: summary ? fmtMs(summary.totalResidualMs) : '—', repo: repo ? fmtMs(repo.totalResidualMs) : '—' });

  const lines = [
    '## Summary vs Repo-Search Comparison',
    '',
    '| Metric | Summary | Repo-search |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.label} | ${r.summary} | ${r.repo} |`),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function detectWindowsFromEvents(events: ParsedEvent[]): {
  summary: { startMs: number; endMs: number } | null;
  repoSearch: { startMs: number; endMs: number } | null;
} {
  // Summary window: from first generate_start that follows a "summary notify running=true" trace,
  // up to the last generate_done preceding the matching "summary notify running=false". For a
  // multi-iteration summary request, just bracket from earliest summary-related trace to latest.
  const sortedAsc = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  const summaryNotifyTrue = sortedAsc.filter((e) => e.kind === 'notify_running_true');
  const summaryNotifyFalse = sortedAsc.filter((e) => e.kind === 'notify_running_false');
  let summary: { startMs: number; endMs: number } | null = null;
  if (summaryNotifyTrue.length > 0 && summaryNotifyFalse.length > 0) {
    summary = {
      startMs: summaryNotifyTrue[0].timestampMs - 1000,
      endMs: summaryNotifyFalse[summaryNotifyFalse.length - 1].timestampMs + 500,
    };
  }

  const executeStart = sortedAsc.find((e) => e.kind === 'execute_start');
  const executeEnd = [...sortedAsc].reverse().find((e) => e.kind === 'execute_completed');
  let repoSearch: { startMs: number; endMs: number } | null = null;
  if (executeStart && executeEnd) {
    repoSearch = { startMs: executeStart.timestampMs, endMs: executeEnd.timestampMs };
  }

  return { summary, repoSearch };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv);

  if (!fs.existsSync(cli.log)) {
    throw new Error(
      `Log file not found: ${cli.log}\n`
      + `Make sure the dev server is running with stdout+stderr captured to this path, e.g.:\n`
      + `  $env:SIFTKIT_TRACE_SUMMARY="1"; $env:SIFTKIT_TRACE_REPO_SEARCH="1"; npm run start:dev *> ${cli.log}`
    );
  }

  let summaryWindow: { startMs: number; endMs: number } | null = null;
  let repoWindow: { startMs: number; endMs: number } | null = null;
  let initialOffset = 0;
  let inputText = '';

  if (cli.analyzeOnly) {
    process.stderr.write(`[profile] Analyze-only mode: parsing entire log without submitting requests.\n`);
    // initialOffset stays 0 → read whole file later.
  } else {
    const reachable = await checkServerReachable(cli.statusHost, cli.statusPort);
    if (!reachable) {
      throw new Error(
        `Status server not reachable at http://${cli.statusHost}:${cli.statusPort}/health\n`
        + `Start it with: npm run start:dev (env vars: SIFTKIT_TRACE_SUMMARY=1 SIFTKIT_TRACE_REPO_SEARCH=1)`
      );
    }

    process.stderr.write(
      `[profile] Using log file: ${cli.log}\n`
      + `[profile] Server: http://${cli.statusHost}:${cli.statusPort}\n`
    );

    if (cli.input) {
      inputText = fs.readFileSync(cli.input, 'utf8');
      process.stderr.write(`[profile] Loaded input file: ${cli.input} (${fmtInt(inputText.length)} chars)\n`);
    }

    initialOffset = getLogSize(cli.log);
    process.stderr.write(`[profile] Initial log offset: ${initialOffset} bytes\n`);

    if (!cli.repoSearchOnly) {
      process.stderr.write(`[profile] Submitting summary request...\n`);
      const startMs = Date.now();
      const result = await submitSummary(cli, inputText);
      const endMs = Date.now();
      summaryWindow = { startMs, endMs };
      process.stderr.write(
        `[profile] Summary done in ${fmtMs(result.durationMs)} (ok=${result.ok})${result.error ? ` error=${result.error}` : ''}\n`
      );
      await sleep(cli.flushMs);
    }

    if (!cli.summaryOnly) {
      process.stderr.write(`[profile] Submitting repo-search request...\n`);
      const startMs = Date.now();
      const result = await submitRepoSearch(cli);
      const endMs = Date.now();
      repoWindow = { startMs, endMs };
      process.stderr.write(
        `[profile] Repo-search done in ${fmtMs(result.durationMs)} (ok=${result.ok})${result.error ? ` error=${result.error}` : ''}\n`
      );
      await sleep(cli.flushMs);
    }
  }

  // Read and parse the new tail of the log (or the entire log in analyze-only mode).
  const tail = readLogTailFromOffset(cli.log, initialOffset);
  const lines = tail.split(/\r?\n/u);
  const events: ParsedEvent[] = [];
  for (const line of lines) {
    const ev = parseLine(line);
    if (ev) events.push(ev);
  }
  process.stderr.write(`[profile] Parsed ${events.length} events from ${lines.length} log lines (${fmtInt(tail.length)} chars)\n`);

  if (cli.analyzeOnly) {
    const detected = detectWindowsFromEvents(events);
    if (detected.summary) {
      summaryWindow = detected.summary;
      process.stderr.write(`[profile] Detected summary window: ${new Date(detected.summary.startMs).toISOString()} → ${new Date(detected.summary.endMs).toISOString()}\n`);
    }
    if (detected.repoSearch) {
      repoWindow = detected.repoSearch;
      process.stderr.write(`[profile] Detected repo-search window: ${new Date(detected.repoSearch.startMs).toISOString()} → ${new Date(detected.repoSearch.endMs).toISOString()}\n`);
    }
  }

  const summaryProfile = summaryWindow ? aggregateProfile('summary', summaryWindow.startMs, summaryWindow.endMs, events) : null;
  const repoProfile = repoWindow ? aggregateProfile('repo-search', repoWindow.startMs, repoWindow.endMs, events) : null;

  // Build report.
  const sections: string[] = [];
  sections.push('# Tool-Loop Overhead Profile');
  sections.push('');
  sections.push(`Generated at ${new Date().toISOString()}`);
  sections.push('');
  if (cli.question) sections.push(`- Question: \`${cli.question}\``);
  if (cli.input) sections.push(`- Input: \`${cli.input}\` (${fmtInt(inputText.length)} chars)`);
  sections.push(`- Log: \`${cli.log}\``);
  sections.push('');

  sections.push(buildComparisonTable(summaryProfile, repoProfile));
  sections.push('');

  if (summaryProfile) {
    sections.push(buildSummaryTable(summaryProfile, 'Summary request'));
    sections.push('');
    sections.push('Per-iteration (summary):');
    sections.push('');
    sections.push(buildPerIterationTable(summaryProfile));
    sections.push('');
  }
  if (repoProfile) {
    sections.push(buildSummaryTable(repoProfile, 'Repo-search request'));
    sections.push('');
    sections.push('Per-iteration (repo-search):');
    sections.push('');
    sections.push(buildPerIterationTable(repoProfile));
    sections.push('');
  }

  sections.push('## Notes');
  sections.push('');
  sections.push('- "Iteration" = one `llama-cpp generate start` / `generate done` pair from the trace log.');
  sections.push('- "Gap between provider calls" = wall-clock from one `generate done` to the next `generate start` (includes tool execution, tokenize calls, status notifies).');
  sections.push('- "Post-iter tokenize" = tokenize calls counted between this iteration\'s `generate done` and the next iteration\'s `generate start` — the per-iteration overhead.');
  sections.push('- "Residual" = wall − total LLM generate − total tokenize. If large, the bottleneck is something other than tokenize (likely tool exec or status-backend POSTs).');
  sections.push('');
  sections.push('Hypothesis the user wants confirmed: summary\'s 4 tokenize calls per iteration ([src/summary/planner/mode.ts:165,540,544,550](../src/summary/planner/mode.ts)) cost more than repo-search\'s 3 calls ([src/repo-search/engine.ts:1127,1239,1248](../src/repo-search/engine.ts)).');

  const report = sections.join('\n');
  if (cli.out) {
    fs.writeFileSync(cli.out, report, 'utf8');
    process.stderr.write(`[profile] Wrote report to ${cli.out}\n`);
  } else {
    process.stdout.write(`${report}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[profile] FATAL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
