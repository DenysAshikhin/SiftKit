import { z } from '../lib/zod.ts';

/** A dev launcher's graceful-stop request; Windows cannot deliver SIGINT to a child process. */
export const ShutdownMessageSchema = z.object({ type: z.literal('shutdown') });
export const SHUTDOWN_MESSAGE: z.infer<typeof ShutdownMessageSchema> = { type: 'shutdown' };

/** A dev launcher asking, before a restart, what live work the restart would cut short. */
export const BusyQueryMessageSchema = z.object({ type: z.literal('busy_query') });
export const BUSY_QUERY_MESSAGE: z.infer<typeof BusyQueryMessageSchema> = { type: 'busy_query' };

/** The server's answer: one label per live run; empty when a restart would interrupt nothing. */
export const BusyReplyMessageSchema = z.object({ type: z.literal('busy_reply'), busy: z.array(z.string()) });
export type BusyReplyMessage = z.infer<typeof BusyReplyMessageSchema>;
