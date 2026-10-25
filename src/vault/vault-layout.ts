/** Where the note-writers file their notes and the sections and callouts they own. */
export const CAPTURES_FOLDER = 'Captures';
export const CHATS_FOLDER = 'Chats';
export const DAILY_FOLDER = 'Daily';
export const LEARNED_HEADING = 'Learned';
export const PENDING_CALLOUT_KIND = 'pending';
export const PENDING_CALLOUT = `> [!${PENDING_CALLOUT_KIND}]- Waiting for the note-writer`;

export const captureFolder = (day: string): string => `${CAPTURES_FOLDER}/${day}`;
