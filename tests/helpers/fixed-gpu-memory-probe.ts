import type { GpuMemory, GpuMemoryProbe } from '../../src/status-server/gpu-memory.js';

/** Reports one fixed reading; null models a host without a queryable NVIDIA GPU. */
export class FixedGpuMemoryProbe implements GpuMemoryProbe {
  constructor(private readonly memory: GpuMemory | null) {}

  async read(): Promise<GpuMemory | null> {
    return this.memory;
  }
}
