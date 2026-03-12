import * as fs from 'node:fs';
import { type SiftConfig } from './config.js';
import { generateOllamaResponse } from './providers/ollama.js';

type ArgMap = Map<string, string>;

function parseArgs(argv: string[]): ArgMap {
  const parsed = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed.set(key, 'true');
      continue;
    }
    parsed.set(key, next);
    i += 1;
  }
  return parsed;
}

function getRequiredArg(args: ArgMap, key: string): string {
  const value = args.get(key);
  if (!value) {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

function getOptionalNumber(args: ArgMap, key: string): number | null {
  const value = args.get(key);
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric argument for --${key}: ${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'generate') {
    throw new Error('Only the generate command is supported.');
  }

  const args = parseArgs(process.argv.slice(3));
  const promptFile = getRequiredArg(args, 'prompt-file');
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const numPredict = getOptionalNumber(args, 'num-predict');

  const config: SiftConfig = {
    Version: '0.1.0',
    Backend: 'ollama',
    Model: getRequiredArg(args, 'model'),
    PolicyMode: 'conservative',
    RawLogRetention: true,
    Ollama: {
      BaseUrl: getRequiredArg(args, 'base-url'),
      ExecutablePath: null,
      NumCtx: Number(getRequiredArg(args, 'num-ctx')),
      Temperature: Number(getRequiredArg(args, 'temperature')),
      TopP: Number(getRequiredArg(args, 'top-p')),
      TopK: Number(getRequiredArg(args, 'top-k')),
      MinP: Number(getRequiredArg(args, 'min-p')),
      PresencePenalty: Number(getRequiredArg(args, 'presence-penalty')),
      RepetitionPenalty: Number(getRequiredArg(args, 'repeat-penalty')),
      ...(numPredict === null ? {} : { NumPredict: numPredict }),
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
      ChunkThresholdRatio: 0.92,
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: [],
      IdleTimeoutMs: 900000,
      MaxTranscriptCharacters: 60000,
      TranscriptRetention: true,
    },
  };

  const response = await generateOllamaResponse({
    config,
    model: config.Model,
    prompt,
    timeoutSeconds: Number(getRequiredArg(args, 'timeout-seconds')),
  });

  process.stdout.write(JSON.stringify(response));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
