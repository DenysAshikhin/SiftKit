import { z } from 'zod';

export const JsonDataSchema = z.json();
export type JsonData = z.infer<typeof JsonDataSchema>;

export const JsonObjectSchema = z.record(z.string(), JsonDataSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
