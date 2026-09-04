import { z } from '../../lib/zod.js';

export const NODE_TYPES = [
  'person', 'organization', 'place', 'device', 'software', 'project', 'document',
  'topic', 'goal', 'routine', 'activity', 'episode', 'event', 'preference_context',
  'policy_topic', 'question_topic', 'account', 'vehicle', 'home_asset',
  'financial_account', 'health_topic', 'food_recipe', 'media_work', 'model',
  'inference_backend', 'dataset', 'benchmark', 'configuration_profile',
] as const;

export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;

/**
 * Human-readable definition of every node type, seeded into `graph_node_types`.
 * Adding a type requires a migration step, an entry here, allowed-relation updates,
 * tests, and a projection policy.
 */
export const NODE_TYPE_DEFINITIONS = {
  person: 'A human being, including the assistant owner (canonical key person:owner) and third parties.',
  organization: 'A company, institution, team, or other collective body.',
  place: 'A physical or named location at any granularity, from a city to a room.',
  device: 'A physical computing or peripheral device such as a workstation, phone, or GPU.',
  software: 'An application, library, service, or operating system.',
  project: 'A named body of work with an identity that persists across sessions.',
  document: 'A durable written artifact such as a file, note, specification, or article.',
  topic: 'A subject of interest that is not itself a concrete entity.',
  goal: 'A stated outcome the owner intends to reach.',
  routine: 'A recurring pattern of behaviour with a cadence.',
  activity: 'A category of doing, such as focused coding or gaming.',
  episode: 'A reified multi-participant fact with its own temporal scope, such as an employment.',
  event: 'A point-in-time or short-span occurrence.',
  preference_context: 'A scope under which a preference holds, such as Windows command examples.',
  policy_topic: 'A subject area a user policy applies to, such as health or finance.',
  question_topic: 'A subject the assistant may or may not ask about.',
  account: 'A non-financial account or login identity on a service.',
  vehicle: 'A car, motorcycle, bicycle, or other means of personal transport.',
  home_asset: 'A durable possession belonging to a home, such as an appliance or furnishing.',
  financial_account: 'A bank, brokerage, credit, or other money-holding account.',
  health_topic: 'A health-related subject area. Never a diagnosis.',
  food_recipe: 'A named dish or recipe.',
  media_work: 'A book, film, series, game, album, or other authored work.',
  model: 'A machine-learning model identified by name, family, and quantization.',
  inference_backend: 'A runtime that serves models, such as inference or TabbyAPI.',
  dataset: 'A named collection of data used for evaluation or training.',
  benchmark: 'A named, repeatable measurement procedure.',
  configuration_profile: 'A named bundle of settings applied to software, a model, or a device.',
} as const satisfies Record<NodeType, string>;