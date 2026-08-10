export type MemoryTaskType =
  | 'conversation' | 'coding' | 'planning' | 'troubleshooting'
  | 'recommendation' | 'recall' | 'action';

export type MemoryTemporalIntent =
  | { readonly kind: 'current' }
  | { readonly kind: 'historical' }
  | { readonly kind: 'any' };

export interface MemoryQueryIntent {
  /** Normalized content words, used as FTS seeds. */
  readonly terms: readonly string[];
  readonly temporal: MemoryTemporalIntent;
  readonly taskType: MemoryTaskType;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'about', 'do', 'does', 'did', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'use', 'used', 'was', 'what',
  'when', 'which', 'with', 'you', 'your', 'can', 'should', 'would', 'please', 'tell', 'give',
]);

const HISTORICAL_PATTERN =
  /\b(?:used to|last (?:year|month|week)|previously|before|back then|in \d{4}|did i)\b/i;

const TASK_PATTERNS: readonly { taskType: MemoryTaskType; pattern: RegExp }[] = [
  { taskType: 'recall', pattern: /\b(?:remember|recall|what do you know|about me)\b/i },
  { taskType: 'troubleshooting', pattern: /\b(?:debug|error|stack trace|failing|broken|crash)\b/i },
  { taskType: 'coding', pattern: /\b(?:function|refactor|compile|typescript|code|implement|write a)\b/i },
  { taskType: 'planning', pattern: /\b(?:plan|roadmap|schedule|next steps|design)\b/i },
  { taskType: 'recommendation', pattern: /\b(?:recommend|suggest|which should|best)\b/i },
  { taskType: 'action', pattern: /\b(?:run|deploy|install|open|create|delete)\b/i },
];

/**
 * Â§11.3 stage 1, deterministically. Gate B does not spend a model round-trip on the chat
 * critical path; `query_intent_parser` arrives in Gate C behind explicit configuration.
 */
export class QueryIntentExtractor {
  extract(userMessage: string): MemoryQueryIntent {
    const terms = userMessage
      .toLowerCase()
      .split(/[^a-z0-9+.#-]+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

    return {
      terms: [...new Set(terms)],
      temporal: HISTORICAL_PATTERN.test(userMessage) ? { kind: 'historical' } : { kind: 'current' },
      taskType: this.resolveTaskType(userMessage),
    };
  }

  private resolveTaskType(userMessage: string): MemoryTaskType {
    for (const rule of TASK_PATTERNS) {
      if (rule.pattern.test(userMessage)) {
        return rule.taskType;
      }
    }
    return 'conversation';
  }
}
