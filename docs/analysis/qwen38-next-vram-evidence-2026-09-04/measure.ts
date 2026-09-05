import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const [tag, staging, target, chunk] = z.tuple([z.string().regex(/^[a-z0-9-]+$/), z.enum(['0', '1']), z.coerce.number().int().positive(), z.coerce.number().int().positive()]).parse(process.argv.slice(2));
const scratch = resolve('docs/analysis/qwen38-next-vram-evidence-2026-09-04');
const base = 'http://127.0.0.1:8098';
const memorySchema = z.tuple([z.coerce.number().nonnegative(), z.coerce.number().nonnegative()]);
function memory() {
  const [used, free] = memorySchema.parse(execFileSync('nvidia-smi', ['--query-gpu=memory.used,memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).trim().split(','));
  return { used, free };
}
async function post(path: string, body: object) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1500)}`);
  return JSON.parse(text);
}
async function encode(text: string) {
  return z.object({ length: z.number().int().positive() }).parse(await post('/v1/token/encode', { text, add_bos_token: false })).length;
}
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('EXL3_') || key.startsWith('TABBY_') || key.startsWith('PYTORCH_')) delete env[key];
Object.assign(env, {
  PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
  TABBY_MEMORY_CUDA_MALLOC_ASYNC: 'true', TORCH_CUDA_ARCH_LIST: '8.9+PTX', EXL3_LOAD_ARENA: '1', EXL3_QC_STAGING: staging,
  TABBY_NETWORK_HOST: '127.0.0.1', TABBY_NETWORK_PORT: '8098',
  TABBY_MODEL_MODEL_DIR: 'D:\\personal\\models\\elx3', TABBY_MODEL_MODEL_NAME: '3.8_27b_sc_5.00bpw_h6',
  TABBY_MODEL_MAX_SEQ_LEN: '155000', TABBY_MODEL_CACHE_SIZE: '155136', TABBY_MODEL_CACHE_MODE: '8,8', TABBY_MODEL_CHUNK_SIZE: String(chunk), TABBY_MODEL_MAX_BATCH_SIZE: '1',
  TABBY_MODEL_VISION: 'true', TABBY_MODEL_VISION_OFFLOAD: 'true', TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
  TABBY_DRAFT_MODEL_DRAFT_MODE: 'mtp', TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: 'Q8', TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: '4', TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: 'true',
  TABBY_MEMORY_SYSMEM_KV_CACHE: '0', TABBY_MEMORY_SYSMEM_RECURRENT_CACHE: '4096', TABBY_LOGGING_LOG_GENERATION_PARAMS: 'false',
});
const idle = memory();
if (idle.used > 1000) throw new Error(`GPU is occupied: ${idle.used} MiB`);
try { await fetch(base + '/v1/models', { signal: AbortSignal.timeout(1000) }); throw new Error('Port 8098 already serves HTTP'); }
catch (error) { if (error instanceof Error && error.message === 'Port 8098 already serves HTTP') throw error; }
const output = createWriteStream(join(scratch, `${tag}.log`));
const child = spawn('C:/envs/rl313-turbo/Scripts/python.exe', ['main.py'], { cwd: 'C:/Users/denys/Documents/GitHub/TabbyAPI', env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(output); child.stderr.pipe(output);
const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
child.once('error', (error) => console.error(error));
console.log(JSON.stringify({ event: 'launched', tag, pid: child.pid, staging, target, chunk, idle }));
const samples: { seconds: number; used: number; free: number }[] = [];
let sampling = false;
let sampler: Promise<void> | undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited during loading: ${child.exitCode}`);
    try { const response = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch { /* Wait for model load. */ }
    await delay(1000);
  }
  if (!ready) throw new Error('Server startup timed out');
  const modelResponse = await fetch(base + '/v1/model');
  await writeFile(join(scratch, `${tag}-model.json`), await modelResponse.text());
  const entries = await readdir(resolve('src'), { recursive: true, withFileTypes: true });
  const paths = entries.filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => join(entry.parentPath, entry.name)).sort();
  let source = '';
  for (const path of paths) { source += `\n\n// FILE: ${path}\n${await readFile(path, 'utf8')}`; if (source.length > target * 5) break; }
  let prompt = source;
  let count = await encode(prompt);
  for (let attempt = 0; attempt < 8 && Math.abs(count - target) > 16; attempt++) { prompt = source.slice(0, Math.floor(prompt.length * target / count)); count = await encode(prompt); }
  if (Math.abs(count - target) > 32) throw new Error(`Prompt size mismatch: ${count} versus ${target}`);
  const afterLoad = memory();
  const started = performance.now();
  sampling = true;
  sampler = (async () => { while (sampling) { samples.push({ seconds: (performance.now() - started) / 1000, ...memory() }); await delay(400); } })();
  console.log(JSON.stringify({ event: 'request', tag, promptTokens: count, afterLoad }));
  let result;
  let failure;
  try {
    result = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable(), reasoning_content: z.string().nullable().optional() }), finish_reason: z.string() })).min(1), usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).passthrough().nullable() }).parse(await post('/v1/chat/completions', {
      model: '3.8_27b_sc_5.00bpw_h6', messages: [{ role: 'system', content: 'You are a senior TypeScript reviewer.' }, { role: 'user', content: prompt + '\n\nSummarize the architecture of this code.' }], stream: false, max_tokens: 32, temperature: 0, seed: 42,
    }));
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const elapsedSeconds = (performance.now() - started) / 1000;
  sampling = false; await sampler;
  const summary = { tag, staging, chunk, context: 155000, cache: 155136, cacheMode: '8,8', promptTokens: count, idle, afterLoad, peakUsedMiB: Math.max(...samples.map(sample => sample.used)), minFreeMiB: Math.min(...samples.map(sample => sample.free)), after: memory(), elapsedSeconds, success: result !== undefined, result, failure };
  await writeFile(join(scratch, `${tag}.json`), JSON.stringify({ summary, samples }, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  sampling = false; await sampler;
  child.kill(); await closed; output.end();
  console.log(JSON.stringify({ event: 'stopped', tag, memory: memory() }));
}
