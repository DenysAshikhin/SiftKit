import { z } from '../lib/zod.ts';

/** A dev launcher's graceful-stop request; Windows cannot deliver SIGINT to a child process. */
export const ShutdownMessageSchema = z.object({ type: z.literal('shutdown') });
export const SHUTDOWN_MESSAGE: z.infer<typeof ShutdownMessageSchema> = { type: 'shutdown' };
