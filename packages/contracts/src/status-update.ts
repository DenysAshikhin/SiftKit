import { z } from 'zod';

/** What a run said it was doing, for the person watching; never part of its own history. */
export const StatusUpdateFieldsSchema = z.object({ updateId: z.string().uuid(), text: z.string().min(1), createdAtUtc: z.string().datetime() });
export type StatusUpdateFields = z.infer<typeof StatusUpdateFieldsSchema>;
