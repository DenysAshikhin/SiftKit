import type { TokenCounter } from '../domain/tokens.js';
import { isExplicitBasis } from '../domain/enums.js';
import { renderAssertionSentence } from './assertion-sentence.js';
import {
  TIER_TOKEN_LIMIT, compareViewsByValue, isProjectableInPlaintext,
  type AssertionView, type CompiledDocument,
} from './assertion-view.js';

export interface DossierCompileRequest {
  readonly tier: 2 | 3;
  readonly topicKey: string;
  readonly title: string;
  readonly views: readonly AssertionView[];
  readonly relatedTopicKeys: readonly string[];
}

const STABLE_PREDICATES = [
  'CREATED', 'CONTRIBUTED_TO', 'PART_OF', 'HAS_COMPONENT', 'OWNS', 'DRIVES', 'RIDES',
];
const PREFERENCE_PREDICATES = ['PREFERS', 'DISLIKES', 'AVOIDS', 'HAS_CONSTRAINT'];
const GOAL_PREDICATES = ['HAS_GOAL', 'HAS_PLAN', 'WORKS_ON'];
const CHRONOLOGY_PREDICATES = [
  'VISITED', 'READ', 'WATCHED', 'PLAYED', 'OBSERVED_DURING', 'ASKED_ABOUT',
  'COMPARED_WITH', 'TESTED_WITH', 'RESULTED_IN', 'CAUSED_BY', 'MENTIONED_IN',
];

/** Tiers 2 and 3: the §10.3 dossier structure, one renderer, two budgets. */
export class DossierCompiler {
  constructor(private readonly tokens: TokenCounter) {}

  async compile(request: DossierCompileRequest): Promise<CompiledDocument> {
    const eligible = request.views.filter(isProjectableInPlaintext).sort(compareViewsByValue);
    const disputed = eligible.filter(
      (item) => item.status === 'disputed' || !isExplicitBasis(item.basis),
    );
    const settled = eligible.filter((item) => !disputed.includes(item));

    const sections: readonly { heading: string; views: readonly AssertionView[] }[] = [
      { heading: '## Stable facts', views: this.pick(settled, STABLE_PREDICATES) },
      { heading: '## Current state', views: this.rest(settled) },
      { heading: '## Preferences and constraints', views: this.pick(settled, PREFERENCE_PREDICATES) },
      { heading: '## Active goals and open threads', views: this.pick(settled, GOAL_PREDICATES) },
      { heading: '## Relevant chronology', views: this.pick(settled, CHRONOLOGY_PREDICATES) },
      { heading: '## Uncertain or disputed items', views: disputed },
    ];

    const lines: string[] = [
      `# ${request.title}`, '',
      '## Compact summary',
      `${eligible.length} recorded facts about ${request.title}.`, '',
    ];
    const includedAssertionIds: string[] = [];
    for (const section of sections) {
      lines.push(section.heading);
      for (const item of section.views) {
        lines.push(renderAssertionSentence(item));
        includedAssertionIds.push(item.assertionId);
      }
      lines.push('');
    }
    lines.push('## Related memory topics');
    for (const topicKey of [...request.relatedTopicKeys].sort()) {
      lines.push(`- ${topicKey}`);
    }
    lines.push('');

    const limited = await this.enforceLimit(lines, TIER_TOKEN_LIMIT[request.tier]);
    const count = await this.tokens.count(limited.body);
    const survivingIds = includedAssertionIds.filter((id) => limited.body.includes(`[M:${id}]`));
    return {
      tier: request.tier,
      topicKey: request.topicKey,
      title: request.title,
      body: limited.body,
      includedAssertionIds: survivingIds,
      omittedAssertionCount: request.views.length - survivingIds.length,
      sensitivity: 'personal',
      tokenCount: count.tokenCount,
      tokenizerId: count.tokenizerId,
    };
  }

  private pick(views: readonly AssertionView[], predicates: readonly string[]): AssertionView[] {
    return views.filter((item) => predicates.includes(item.predicate));
  }

  private rest(views: readonly AssertionView[]): AssertionView[] {
    const claimed = new Set([
      ...STABLE_PREDICATES, ...PREFERENCE_PREDICATES, ...GOAL_PREDICATES,
      ...CHRONOLOGY_PREDICATES,
    ]);
    return views.filter((item) => !claimed.has(item.predicate));
  }

  private async enforceLimit(
    lines: readonly string[],
    limit: number,
  ): Promise<{ body: string; droppedLines: number }> {
    const working = [...lines];
    let body = working.join('\n');
    let droppedLines = 0;
    while ((await this.tokens.count(body)).tokenCount > limit) {
      const lastCitedIndex = working.map((line) => line.startsWith('- ')).lastIndexOf(true);
      if (lastCitedIndex < 0) break;
      working.splice(lastCitedIndex, 1);
      droppedLines += 1;
      body = working.join('\n');
    }
    return { body, droppedLines };
  }
}