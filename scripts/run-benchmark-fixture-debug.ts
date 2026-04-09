// @ts-nocheck
import * as fs from 'node:fs';
import * as path from 'node:path';

function requireCompiledSummary(): {
  summarizeRequest: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
} {
  const candidates = [
    path.resolve(__dirname, '..', 'dist', 'summary.js'),
    path.resolve(__dirname, '..', '..', 'dist', 'summary.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(candidate) as { summarizeRequest: (request: Record<string, unknown>) => Promise<Record<string, unknown>> };
    }
  }
  throw new Error('Unable to locate dist/summary.js. Run npm run build first.');
}

const { summarizeRequest } = requireCompiledSummary();

export function parseArgs(argv: string[]): {
  fixtureIndex: number;
  fixtureRoot: string;
  requestTimeoutSeconds: number;
  file: string;
  question: string;
  format: string;
  policyProfile: string;
  outputRoot: string;
  traceSummary: boolean;
} {
  const parsed = {
    fixtureIndex: 48,
    fixtureRoot: path.join(process.cwd(), 'eval', 'fixtures', 'ai_core_60_tests'),
    requestTimeoutSeconds: 600,
    file: '',
    question: '',
    format: 'text',
    policyProfile: 'general',
    outputRoot: '',
    traceSummary: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--fixture-index':
        parsed.fixtureIndex = Number(argv[++index]);
        break;
      case '--fixture-root':
        parsed.fixtureRoot = path.resolve(String(argv[++index] || ''));
        break;
      case '--request-timeout-seconds':
        parsed.requestTimeoutSeconds = Number(argv[++index]);
        break;
      case '--file':
        parsed.file = path.resolve(String(argv[++index] || ''));
        break;
      case '--question':
        parsed.question = String(argv[++index] || '');
        break;
      case '--format':
        parsed.format = String(argv[++index] || '');
        break;
      case '--policy-profile':
        parsed.policyProfile = String(argv[++index] || '');
        break;
      case '--output-root':
        parsed.outputRoot = path.resolve(String(argv[++index] || ''));
        break;
      case '--trace-summary':
        parsed.traceSummary = String(argv[++index] || '') !== '0';
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!Number.isFinite(parsed.requestTimeoutSeconds) || parsed.requestTimeoutSeconds <= 0) {
    throw new Error('request-timeout-seconds must be a positive number.');
  }
  if (parsed.file) {
    if (!parsed.question.trim()) {
      throw new Error('Direct file mode requires --question.');
    }
  } else if (!Number.isInteger(parsed.fixtureIndex) || parsed.fixtureIndex <= 0) {
    throw new Error('fixture-index must be a positive integer.');
  }

  return parsed;
}

function getTimestamp(): string {
  const current = new Date();
  const yyyy = current.getFullYear();
  const MM = String(current.getMonth() + 1).padStart(2, '0');
  const dd = String(current.getDate()).padStart(2, '0');
  const hh = String(current.getHours()).padStart(2, '0');
  const mm = String(current.getMinutes()).padStart(2, '0');
  const ss = String(current.getSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}_${hh}${mm}${ss}`;
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs.toFixed(1)}ms`;
  }
  return `${(durationMs / 1000).toFixed(3)}s`;
}

function createLogger(
  logPath: string,
  stdoutTarget: { write: (text: string) => unknown } = process.stdout,
  stderrTarget: { write: (text: string) => unknown } = process.stderr,
): { log: (message: string) => void; restore: () => void } {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '', 'utf8');
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    fs.appendFileSync(logPath, text, 'utf8');
    if (stderrTarget && stderrTarget !== process.stderr && typeof stderrTarget.write === 'function') {
      stderrTarget.write(text);
      return true;
    }
    return originalStderrWrite(chunk as never, encoding, callback as never);
  }) as typeof process.stderr.write;

  return {
    log(message: string) {
      const line = `[fixture-debug ${new Date().toISOString()}] ${message}`;
      stdoutTarget.write(`${line}\n`);
      fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    },
    restore() {
      process.stderr.write = originalStderrWrite;
    },
  };
}

export function resolveWorkItem(args: {
  file: string;
  fixtureRoot: string;
  fixtureIndex: number;
  question: string;
  format: string;
  policyProfile: string;
}): {
  label: string;
  sourcePath: string;
  question: string;
  format: string;
  policyProfile: string;
  inputText: string;
} {
  if (args.file) {
    return {
      label: path.basename(args.file),
      sourcePath: args.file,
      question: args.question,
      format: args.format,
      policyProfile: args.policyProfile,
      inputText: fs.readFileSync(args.file, 'utf8'),
    };
  }

  const manifestPath = path.join(args.fixtureRoot, 'fixtures.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Array<Record<string, unknown>>;
  const fixture = manifest[args.fixtureIndex - 1];
  if (!fixture) {
    throw new Error(`Fixture ${args.fixtureIndex} not found in ${manifestPath}.`);
  }
  const sourcePath = path.join(args.fixtureRoot, String(fixture.File || ''));
  return {
    label: String(fixture.Name || ''),
    sourcePath,
    question: String(fixture.Question || ''),
    format: String(fixture.Format || 'text'),
    policyProfile: String(fixture.PolicyProfile || 'general'),
    inputText: fs.readFileSync(sourcePath, 'utf8'),
  };
}

export async function runDebugRequest(
  argv: string[],
  options: {
    stdout?: { write: (text: string) => unknown };
    stderr?: { write: (text: string) => unknown };
  } = {},
): Promise<{
  exitCode: number;
  artifactPath: string;
  artifact: Record<string, unknown>;
}> {
  const args = parseArgs(argv);
  const repoRoot = path.resolve(__dirname, '..');
  const outputRoot = args.outputRoot || path.join(repoRoot, 'tmp-find', `fixture_debug_${getTimestamp()}`);
  const logPath = path.join(outputRoot, 'debug.log');
  const artifactPath = path.join(outputRoot, 'result.json');
  const summaryPath = path.join(outputRoot, 'summary.txt');
  const stdoutTarget = options.stdout || process.stdout;
  const stderrTarget = options.stderr || process.stderr;
  const logger = createLogger(logPath, stdoutTarget, stderrTarget);
  const workItem = resolveWorkItem(args);

  if (args.traceSummary) {
    process.env.SIFTKIT_TRACE_SUMMARY = '1';
  }

  logger.log(`Output root: ${outputRoot}`);
  logger.log(`Log path: ${logPath}`);
  logger.log(`Source path: ${workItem.sourcePath}`);
  logger.log(`Input chars: ${workItem.inputText.length}`);
  logger.log(`Question: ${workItem.question}`);
  logger.log(`Format: ${workItem.format}`);
  logger.log(`Policy profile: ${workItem.policyProfile}`);
  logger.log(`Request timeout seconds: ${args.requestTimeoutSeconds}`);
  logger.log('Calling summarizeRequest...');

  const startedAt = process.hrtime.bigint();
  try {
    const result = await summarizeRequest({
      question: workItem.question,
      inputText: workItem.inputText,
      format: workItem.format,
      policyProfile: workItem.policyProfile,
      requestTimeoutSeconds: args.requestTimeoutSeconds,
    }) as Record<string, unknown>;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const summary = String(result.Summary || '');
    const artifact = {
      ok: true,
      requestId: result.RequestId,
      durationMs,
      label: workItem.label,
      sourcePath: workItem.sourcePath,
      classification: result.Classification,
      rawReviewRequired: result.RawReviewRequired,
      modelCallSucceeded: result.ModelCallSucceeded,
      summary,
      summaryPreview: summary.slice(0, 1000),
      providerError: result.ProviderError,
    };

    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(summaryPath, summary, 'utf8');
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    logger.log(`summarizeRequest completed in ${formatDurationMs(durationMs)}`);
    logger.log(`Request id: ${String(result.RequestId || '')}`);
    logger.log(`Result classification: ${String(result.Classification || '')}`);
    logger.log(`Summary path: ${summaryPath}`);
    logger.log(`Artifact path: ${artifactPath}`);
    stdoutTarget.write(summary.endsWith('\n') ? summary : `${summary}\n`);
    return { exitCode: 0, artifactPath, artifact };
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    const artifact = {
      ok: false,
      durationMs,
      label: workItem.label,
      sourcePath: workItem.sourcePath,
      error: message,
    };
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    logger.log(`summarizeRequest failed in ${formatDurationMs(durationMs)}`);
    logger.log(`Artifact path: ${artifactPath}`);
    stderrTarget.write(`${message}\n`);
    return { exitCode: 1, artifactPath, artifact };
  } finally {
    logger.restore();
  }
}

async function main(): Promise<void> {
  const result = await runDebugRequest(process.argv.slice(2));
  process.exit(result.exitCode);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
