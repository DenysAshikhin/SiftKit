import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getPromptLabel } from '../bench/benchmark/args.js';
import { SummaryReproPromptBuilder } from '../bench/repro/summary-prompt-builder.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import {
  buildCompactSummaryPrompt,
  buildSummaryInputSection,
  buildSummaryPrompt,
  buildSummarySystemInstructions,
} from '../src/summary/prompt.js';
import {
  buildPlannerInputSection,
  buildPlannerSystemPrompt,
} from '../src/summary/planner/prompts.js';
import type { PresetSystemContext } from '../src/preset-system-context.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const PRESET = 'PRESET_INSTRUCTIONS';
const ADDITIONAL = 'ADDITIONAL_INSTRUCTIONS';
const BASE = 'You are SiftKit';
const STARTUP = 'STARTUP_CONTEXT';
const QUESTION = 'USER_QUESTION';
const INPUT = 'USER_INPUT';

const SYSTEM_CONTEXT: PresetSystemContext = {
  content: STARTUP,
  warnings: [],
  hasAgentsMd: true,
  hasRepoFileListing: false,
  loadedFiles: [],
};

function assertOrderedOnce(text: string, sentinels: readonly string[]): void {
  let previousIndex = -1;
  for (const sentinel of sentinels) {
    const index = text.indexOf(sentinel);
    assert.ok(index > previousIndex, `${sentinel} is out of order`);
    assert.equal(text.split(sentinel).length - 1, 1, `${sentinel} appears more than once`);
    previousIndex = index;
  }
}

function directOptions(phase: 'leaf' | 'merge' = 'leaf') {
  return {
    question: QUESTION,
    inputText: INPUT,
    format: 'text' as const,
    policyProfile: 'general' as const,
    rawReviewRequired: false,
    sourceKind: 'standalone' as const,
    phase,
    presetPromptPrefix: PRESET,
    additionalPromptPrefix: ADDITIONAL,
    systemContext: SYSTEM_CONTEXT,
  };
}

test('summary prompt exposes separate instruction and input sections in exact order', () => {
  const options = directOptions();
  const instructions = buildSummarySystemInstructions(options);
  const input = buildSummaryInputSection(options);
  const prompt = buildSummaryPrompt(options);

  assert.doesNotMatch(instructions, new RegExp(INPUT, 'u'));
  assert.match(input, new RegExp(INPUT, 'u'));
  assertOrderedOnce(prompt, [PRESET, ADDITIONAL, BASE, STARTUP, QUESTION, INPUT]);
});

test('compact summary prompt composes preset and startup context exactly once', () => {
  const prompt = buildCompactSummaryPrompt({
    question: QUESTION,
    inputText: INPUT,
    presetPromptPrefix: PRESET,
    additionalPromptPrefix: ADDITIONAL,
    systemContext: SYSTEM_CONTEXT,
  });

  assertOrderedOnce(prompt, [PRESET, ADDITIONAL, 'Summarize the input', STARTUP, QUESTION, INPUT]);
});

test('chunk and merge summary prompts independently compose every section once', () => {
  const chunkPrompt = buildSummaryPrompt({
    ...directOptions(),
    chunkContext: {
      isGeneratedChunk: true,
      mayBeTruncated: true,
      chunkPath: '1/2',
      retryMode: 'default',
    },
  });
  const mergePrompt = buildSummaryPrompt(directOptions('merge'));

  assertOrderedOnce(chunkPrompt, [PRESET, ADDITIONAL, BASE, STARTUP, QUESTION, INPUT]);
  assertOrderedOnce(mergePrompt, [PRESET, ADDITIONAL, 'You are merging', STARTUP, QUESTION, INPUT]);
});

test('planner summary request keeps composed system instructions before user input', () => {
  const systemPrompt = buildPlannerSystemPrompt({
    presetPromptPrefix: PRESET,
    additionalPromptPrefix: ADDITIONAL,
    systemContext: SYSTEM_CONTEXT,
    sourceKind: 'standalone',
    rawReviewRequired: false,
    toolDefinitions: [],
  });
  const inputSection = buildPlannerInputSection({
    question: QUESTION,
    inputText: INPUT,
  });
  const request = [systemPrompt, inputSection].join('\n\n');

  assertOrderedOnce(request, [PRESET, ADDITIONAL, BASE, STARTUP, QUESTION, INPUT]);
});

test('benchmark prompt label is fixture metadata rather than a fabricated model prompt', () => {
  assert.equal(getPromptLabel({
    fixture: {
      Name: 'Fixture',
      File: 'fixture.txt',
      Question: 'Which branch failed?',
      Format: 'text',
      PolicyProfile: 'pass-fail',
    },
  }), 'Which branch failed?');
});

test('summary repro prompt uses configured preset instructions and startup context', () => {
  const repoRoot = createManagedTempDir('siftkit-summary-repro-prompt-');
  try {
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), 'REPRO_AGENT_RULE', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'repro-policy.md'), 'REPRO_AUTOLOAD_RULE', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'tracked.ts'), 'export const tracked = true;\n', 'utf8');
    const config = getDefaultConfigObject();
    const summaryPreset = config.Presets.find((preset) => preset.id === 'summary');
    if (!summaryPreset) {
      throw new Error('Default summary preset is required.');
    }
    summaryPreset.promptPrefix = 'REPRO_PRESET_RULE';
    summaryPreset.autoloadFiles = ['repro-policy.md'];

    const prompt = new SummaryReproPromptBuilder(
      config,
      repoRoot,
      'REPRO_ADDITIONAL_RULE',
    ).buildPrompt({
      question: QUESTION,
      inputText: INPUT,
      format: 'text',
      policyProfile: 'general',
      rawReviewRequired: false,
      sourceKind: 'standalone',
    });

    assertOrderedOnce(prompt, [
      'REPRO_PRESET_RULE',
      'REPRO_ADDITIONAL_RULE',
      BASE,
      'REPRO_AGENT_RULE',
      'Repository file listing',
      'REPRO_AUTOLOAD_RULE',
      QUESTION,
      INPUT,
    ]);
  } finally {
    fs.rmSync(repoRoot, { force: true, recursive: true });
  }
});
