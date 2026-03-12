import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { spawnSync } from 'node:child_process';
import { type SiftConfig, findOllamaExecutable, initializeRuntime, saveContentAtomically } from '../config.js';

export type OllamaGenerateResponse = {
  response: string;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
};

type LoadedModel = {
  Name: string;
  Id: string | null;
  Size: string | null;
  Processor: string | null;
  Context: number | null;
  Until: string | null;
};

function requestJson<T>(options: {
  url: string;
  method: 'GET' | 'POST';
  timeoutMs: number;
  body?: string;
}): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseText += chunk;
        });
        response.on('end', () => {
          if (!responseText.trim()) {
            resolve({ statusCode: response.statusCode || 0, body: {} as T });
            return;
          }

          try {
            resolve({
              statusCode: response.statusCode || 0,
              body: JSON.parse(responseText) as T,
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    });
    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

export function getOllamaLoadedModels(executablePath: string | null): LoadedModel[] {
  if (!executablePath || !fs.existsSync(executablePath)) {
    return [];
  }

  const result = spawnSync(executablePath, ['ps'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  const lines = result.stdout.split(/\r?\n/u).slice(1).filter((line) => line.trim().length > 0);
  return lines.reduce<LoadedModel[]>((loadedModels, line) => {
    const parts = line.trim().split(/\s{2,}/u);
    if (parts.length < 5) {
      return loadedModels;
    }

    const parsedContext = Number.parseInt(parts[4], 10);
    loadedModels.push({
      Name: parts[0].trim(),
      Id: parts[1]?.trim() || null,
      Size: parts[2]?.trim() || null,
      Processor: parts[3]?.trim() || null,
      Context: Number.isFinite(parsedContext) ? parsedContext : null,
      Until: parts[5]?.trim() || null,
    });
    return loadedModels;
  }, []);
}

export async function listOllamaModels(config: SiftConfig): Promise<string[]> {
  try {
    const response = await requestJson<{ models?: Array<{ name?: string }> }>({
      url: `${config.Ollama.BaseUrl.replace(/\/$/u, '')}/api/tags`,
      method: 'GET',
      timeoutMs: 5000,
    });
    const models = response.body.models?.map((entry) => entry.name).filter((value): value is string => Boolean(value));
    if (models && models.length > 0) {
      return models;
    }
  } catch {
    // Fall back to the executable when the API is unavailable.
  }

  const executablePath = findOllamaExecutable();
  if (!executablePath) {
    return [];
  }

  const result = spawnSync(executablePath, ['list'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.split(/\s{2,}/u)[0]?.trim())
    .filter((value): value is string => Boolean(value));
}

export async function getOllamaProviderStatus(config: SiftConfig): Promise<Record<string, unknown>> {
  const executablePath = findOllamaExecutable();
  const status: Record<string, unknown> = {
    Available: Boolean(executablePath),
    ExecutablePath: executablePath,
    Reachable: false,
    BaseUrl: config.Ollama.BaseUrl,
    Error: null,
    LoadedModelContext: null,
    LoadedModelName: null,
    RuntimeContextMatchesConfig: null,
  };

  try {
    const response = await requestJson<{ models?: Array<unknown> }>({
      url: `${config.Ollama.BaseUrl.replace(/\/$/u, '')}/api/tags`,
      method: 'GET',
      timeoutMs: 3000,
    });
    if (Array.isArray(response.body.models)) {
      status.Reachable = true;
      status.Available = true;
    }
  } catch (error) {
    status.Error = error instanceof Error ? error.message : String(error);
  }

  const loadedModel = getOllamaLoadedModels(executablePath)
    .find((candidate) => candidate.Name === config.Model);
  if (loadedModel) {
    status.LoadedModelName = loadedModel.Name;
    status.LoadedModelContext = loadedModel.Context;
    if (loadedModel.Context !== null) {
      status.RuntimeContextMatchesConfig = Number(loadedModel.Context) === Number(config.Ollama.NumCtx);
    }
  }

  return status;
}

export async function generateOllamaResponse(options: {
  config: SiftConfig;
  model: string;
  prompt: string;
  timeoutSeconds: number;
}): Promise<OllamaGenerateResponse> {
  const paths = initializeRuntime();
  const promptPath = path.join(
    paths.Logs,
    `ollama_prompt_${Date.now()}_${process.pid}_${Math.random().toString(16).slice(2, 10)}.txt`
  );
  saveContentAtomically(promptPath, options.prompt);

  const requestBody = JSON.stringify({
    model: options.model,
    prompt: options.prompt,
    stream: false,
    think: false,
    options: {
      temperature: Number(options.config.Ollama.Temperature),
      top_p: Number(options.config.Ollama.TopP),
      top_k: Number(options.config.Ollama.TopK),
      min_p: Number(options.config.Ollama.MinP),
      presence_penalty: Number(options.config.Ollama.PresencePenalty),
      repeat_penalty: Number(options.config.Ollama.RepetitionPenalty),
      num_ctx: Number(options.config.Ollama.NumCtx),
      ...(options.config.Ollama.NumPredict === undefined || options.config.Ollama.NumPredict === null
        ? {}
        : { num_predict: Number(options.config.Ollama.NumPredict) }),
    },
  });

  const response = await requestJson<OllamaGenerateResponse>({
    url: `${options.config.Ollama.BaseUrl.replace(/\/$/u, '')}/api/generate`,
    method: 'POST',
    timeoutMs: options.timeoutSeconds * 1000,
    body: requestBody,
  });
  if (response.statusCode >= 400) {
    throw new Error(`Ollama generate failed with HTTP ${response.statusCode}. Prompt path: ${promptPath}`);
  }
  if (!response.body.response) {
    throw new Error('Ollama did not return a response body.');
  }

  return response.body;
}
