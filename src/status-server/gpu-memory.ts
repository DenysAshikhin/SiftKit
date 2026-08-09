import { spawnDirectCommand } from '../lib/command-spawn.js';
import { z } from '../lib/zod.js';
import { serverLogger } from './server-logger.js';

const NvidiaSmiRowSchema = z.tuple([
  z.coerce.number().int().nonnegative(),
  z.coerce.number().int().nonnegative(),
  z.coerce.number().int().nonnegative(),
]);

export const GpuMemorySchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative(),
});
export type GpuMemory = z.infer<typeof GpuMemorySchema>;

const MIB = 1_048_576;
/** Long enough that a re-render storm cannot spawn a process per frame, short enough to stay live. */
const GPU_MEMORY_CACHE_MS = 2_000;

let cached: { at: number; value: GpuMemory | null } | null = null;

export function parseNvidiaSmiMemory(stdout: string): GpuMemory | null {
  const [firstLine] = String(stdout || '').trim().split('\n');
  if (!firstLine) return null;
  const parsed = NvidiaSmiRowSchema.safeParse(firstLine.split(',').map((field) => field.trim()));
  if (!parsed.success) return null;
  const [total, used, free] = parsed.data;
  return GpuMemorySchema.parse({
    totalBytes: total * MIB,
    usedBytes: used * MIB,
    freeBytes: free * MIB,
  });
}

/**
 * Free VRAM, or null when it cannot be determined - no NVIDIA GPU, nvidia-smi not on PATH, or a
 * non-CUDA backend. **Null means "skip every headroom check", never "warn".** Guessing wrong in
 * the warning direction trains users to ignore the warnings that matter.
 */
export async function readGpuMemory(): Promise<GpuMemory | null> {
  if (cached && Date.now() - cached.at < GPU_MEMORY_CACHE_MS) {
    return cached.value;
  }
  let value: GpuMemory | null = null;
  try {
    const result = await spawnDirectCommand('nvidia-smi', [
      '--query-gpu=memory.total,memory.used,memory.free',
      '--format=csv,noheader,nounits',
    ]);
    value = result.exitCode === 0 ? parseNvidiaSmiMemory(result.stdout) : null;
  } catch {
    value = null;
  }
  if (value === null) {
    serverLogger.debug({
      scope: 'gpu',
      id: 'memory',
      event: 'unavailable',
      fields: 'nvidia-smi_absent_or_unparseable',
    });
  }
  cached = { at: Date.now(), value };
  return value;
}

/** Test seam. */
export function clearGpuMemoryCache(): void {
  cached = null;
}
