import { VAULT_EDIT_INSTRUCTIONS } from '../edit-ops.ts';

const EXPLORE = [
  'You maintain a personal knowledge vault of linked notes about the user.',
  'Before editing, explore: search_notes for each entity the source mentions, read_note to see what a note already holds,',
  'neighbors to check how notes relate, day_context for what earlier sources today already recorded.',
  'Never create a note another name already covers; add an alias instead. Never repeat a value a row already holds.',
  'Put each fact on the note it is about. Link known notes as [[Title]] values.',
].join('\n');

const SOURCE = {
  capture: "The image is a screenshot of the user's screen. Record what it shows about the user: tools, projects, people, places, plans and preferences.",
  chat: "Below is one chat turn. Record durable facts the user states about themselves. Skip questions, hypotheticals, quotations and requests; the assistant's reply is context only.",
  review: [
    'This is a review pass over the notes below, listed stalest values first. For each note check:',
    '- Plausibility: does each fact make common sense? Flag anything impossible, absurd, a joke, a misread or a hallucination with flag_doubt, reason "implausible: …".',
    '- Connections: does each link point to the right note, and does the relation make sense for both ends\' types? Flag a wrong one with flag_doubt, reason "bad link: …". Add links that clearly belong.',
    '- Consistency: do facts agree with each other, with neighbours and with the owner note? Flag contradictions with flag_conflict. Merge duplicates by adding an alias. Rewrite a wrong or stale lead with set_lead.',
    'Delete nothing. Submit {"operations": []} when every note checks out.',
  ].join('\n'),
} as const;

export type VaultWriterSourceKind = keyof typeof SOURCE;

export function writerInstructions(source: VaultWriterSourceKind): string {
  return [EXPLORE, SOURCE[source], VAULT_EDIT_INSTRUCTIONS].join('\n\n');
}
