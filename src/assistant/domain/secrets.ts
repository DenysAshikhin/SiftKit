import type { Sensitivity } from './enums.js';

export const SENSITIVE_TOPICS = ['health', 'finance', 'relationship', 'precise_location'] as const;
export type SensitiveTopic = (typeof SENSITIVE_TOPICS)[number];

export interface SecretScanResult {
  readonly containsSecret: boolean;
  readonly matchedRuleIds: readonly string[];
  readonly topics: readonly SensitiveTopic[];
  /** The lowest sensitivity anything derived from this text may carry. */
  readonly sensitivityFloor: Sensitivity;
}

interface SecretRule {
  readonly id: string;
  readonly pattern: RegExp;
}

/** Ordered so the reported rule ids are stable across runs. */
const SECRET_RULES: readonly SecretRule[] = [
  { id: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'openai_key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}\b/ },
  { id: 'bearer_token', pattern: /\bbearer\s+[A-Za-z0-9._-]{16,}\b/i },
  { id: 'assignment_password', pattern: /\bpassw(?:or)?d\s*[=:]\s*\S{8,}/i },
  { id: 'assignment_api_key', pattern: /\b(?:api[_-]?key|secret|token)\s*[=:]\s*\S{16,}/i },
  { id: 'credentialed_url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@\S+/i },
];

interface TopicRule {
  readonly topic: SensitiveTopic;
  readonly pattern: RegExp;
}

const TOPIC_RULES: readonly TopicRule[] = [
  {
    topic: 'health',
    pattern: /\b(?:doctor|diagnos\w*|prescri\w*|medication|symptom|therapy|surgery|blood pressure|mental health)\b/i,
  },
  {
    topic: 'finance',
    pattern: /\b(?:bank(?: account)?|iban|salary|mortgage|credit card|loan|invest\w*|net worth|tax return)\b/i,
  },
  {
    topic: 'relationship',
    pattern: /\b(?:wife|husband|spouse|girlfriend|boyfriend|partner|divorce|marriage|dating)\b/i,
  },
  {
    topic: 'precise_location',
    pattern: /\b(?:live[sd]? at|home address|postcode|zip code|\d{1,5}\s+[A-Z][a-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr))\b/,
  },
];

/**
 * Deterministic classification of raw evidence text (§7.1). Pure: it decides what the text is,
 * never what to do about it.
 */
export class SecretScanner {
  scan(text: string): SecretScanResult {
    const matchedRuleIds: string[] = [];
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(text)) {
        matchedRuleIds.push(rule.id);
      }
    }
    const topics: SensitiveTopic[] = [];
    for (const rule of TOPIC_RULES) {
      if (rule.pattern.test(text)) {
        topics.push(rule.topic);
      }
    }
    const containsSecret = matchedRuleIds.length > 0;
    return {
      containsSecret,
      matchedRuleIds,
      topics,
      sensitivityFloor: this.resolveFloor(containsSecret, topics),
    };
  }

  private resolveFloor(containsSecret: boolean, topics: readonly SensitiveTopic[]): Sensitivity {
    if (containsSecret) return 'secret_prohibited';
    return topics.length > 0 ? 'sensitive' : 'personal';
  }
}