import type { TokenCounter } from '../domain/tokens.js';
import { renderAssertionSentence } from './assertion-sentence.js';
import {
  TIER_TOKEN_LIMIT, compareViewsByValue, isProjectableInPlaintext,
  type AssertionView, type CompiledDocument,
} from './assertion-view.js';

export interface ProfileCompileRequest {
  readonly views: readonly AssertionView[];
  /** The routing map to Tier 2 (§10.3). */
  readonly tier2TopicKeys: readonly string[];
}

interface ProfileSection {
  readonly heading: string;
  readonly predicates: readonly string[];
}

const SECTIONS: readonly ProfileSection[] = [
  { heading: '## Stable identity', predicates: ['HAS_ROLE', 'LIVES_IN', 'EMPLOYED_BY'] },
  { heading: '## Preferences and constraints', predicates: ['PREFERS', 'DISLIKES', 'AVOIDS', 'HAS_CONSTRAINT'] },
  { heading: '## Environment', predicates: ['USES', 'OWNS', 'HAS_COMPONENT', 'RUNS_ON', 'HAS_SETTING'] },
  { heading: '## Active goals', predicates: ['HAS_GOAL', 'HAS_PLAN', 'WORKS_ON'] },
];

/** Tier 1: the single `profile` document (§10.3). */
export class ProfileCompiler {
  constructor(private readonly tokens: TokenCounter) {}

  async compile(request: ProfileCompileRequest): Promise<CompiledDocument> {
    const eligible = request.views.filter(isProjectableInPlaintext).sort(compareViewsByValue);
    const includedAssertionIds: string[] = [];
    const lines: string[] = ['# Profile', ''];
    let omittedAssertionCount = request.views.length - eligible.length;
    const used = new Set<string>();

    for (const section of SECTIONS) {
      const sectionViews = eligible.filter((item) => section.predicates.includes(item.predicate));
      if (sectionViews.length === 0) continue;
      lines.push(section.heading);
      for (const item of sectionViews) {
        lines.push(renderAssertionSentence(item));
        includedAssertionIds.push(item.assertionId);
        used.add(item.assertionId);
      }
      lines.push('');
    }

    omittedAssertionCount += eligible.filter((item) => !used.has(item.assertionId)).length;

    lines.push('## Memory topics');
    for (const topicKey of [...request.tier2TopicKeys].sort()) {
      lines.push(`- ${topicKey}`);
    }
    lines.push('');

    const body = lines.join('\n');
    const trimmed = await this.enforceLimit(body, lines);
    const count = await this.tokens.count(trimmed.body);
    return {
      tier: 1,
      topicKey: 'profile',
      title: 'Profile',
      body: trimmed.body,
      includedAssertionIds: includedAssertionIds.filter(
        (id) => trimmed.body.includes(`[M:${id}]`),
      ),
      omittedAssertionCount: omittedAssertionCount + trimmed.droppedLines,
      sensitivity: 'personal',
      tokenCount: count.tokenCount,
      tokenizerId: count.tokenizerId,
    };
  }

  private async enforceLimit(
    body: string,
    lines: readonly string[],
  ): Promise<{ body: string; droppedLines: number }> {
    let current = body;
    const working = [...lines];
    let droppedLines = 0;
    while ((await this.tokens.count(current)).tokenCount > TIER_TOKEN_LIMIT[1]) {
      const lastCitedIndex = working.map((line) => line.startsWith('- ')).lastIndexOf(true);
      if (lastCitedIndex < 0) break;
      working.splice(lastCitedIndex, 1);
      droppedLines += 1;
      current = working.join('\n');
    }
    return { body: current, droppedLines };
  }
}