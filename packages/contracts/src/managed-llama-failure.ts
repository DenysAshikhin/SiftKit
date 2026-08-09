import { z } from 'zod';

export const ManagedLlamaStartupFailureSchema = z.object({
  kind: z.literal('gpu_memory_oom'),
  requiredMiB: z.number().nullable(),
  availableMiB: z.number().nullable(),
});
export type ManagedLlamaStartupFailure = z.infer<typeof ManagedLlamaStartupFailureSchema>;
