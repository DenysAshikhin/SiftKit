import type { GpuMemory, GpuMemoryProbe } from '../../src/status-server/gpu-memory.ts';

/** Reports one fixed reading; null models a host without a queryable NVIDIA GPU. */
export class FixedGpuMemoryProbe implements GpuMemoryProbe {
  private readonly memory: GpuMemory | null;

  constructor(memory: GpuMemory | null) {
    this.memory = memory;
  }

  async read(): Promise<GpuMemory | null> {
    return this.memory;
  }
}
