import type { LlamaCppChatMessage } from '../../providers/llama-cpp.js';
import { PresetSystemPromptComposer } from '../../preset-system-prompt.js';
import type { PresetSystemContext } from '../../preset-system-context.js';
import { getSourceInstructions } from '../prompt.js';
import type { SummarySourceKind } from '../types.js';
import type { PlannerToolDefinition } from '../../planner-protocol/json-schema.js';
import { buildSingleAssistantToolCallMessage as buildSharedAssistantToolCallMessage } from '../../tool-call-messages.js';
import { parseJsonValueText } from '../../lib/json.js';
import { getRecord, MAX_JSON_FALLBACK_PREVIEW_CHARACTERS } from './json-filter.js';
import { truncatePlannerText } from './formatters.js';
import type { SummaryNativeToolCall } from '../../planner-protocol/summary-tools.js';

const MAX_PLANNER_PREVIEW_CHARACTERS = 600;
// Keep the preview-length constant local here but re-export so the
// json-filter module's MAX_JSON_FALLBACK_PREVIEW_CHARACTERS stays the only
// home for the *other* preview cap.
export { MAX_JSON_FALLBACK_PREVIEW_CHARACTERS };

export function buildPlannerDocumentProfile(inputText: string): string {
  const lines = inputText.replace(/\r\n/gu, '\n').split('\n');
  const profileLines = [
    `chars=${inputText.length}`,
    `lines=${inputText.trim() ? lines.length : 0}`,
  ];
  const preview = truncatePlannerText(inputText.slice(0, MAX_PLANNER_PREVIEW_CHARACTERS));

  try {
    const parsed = parseJsonValueText(inputText);
    const parsedRecord = getRecord(parsed);
    if (Array.isArray(parsed)) {
      profileLines.push('json=parseable');
      profileLines.push('top_level=array');
      profileLines.push(`array_length=${parsed.length}`);
      const firstRecord = parsed.length > 0 ? getRecord(parsed[0]) : null;
      const sampleKeys = firstRecord ? Object.keys(firstRecord).slice(0, 10) : [];
      if (sampleKeys.length > 0) {
        profileLines.push(`sample_keys=${sampleKeys.join(',')}`);
      }
    } else if (parsedRecord) {
      profileLines.push('json=parseable');
      profileLines.push('top_level=object');
      const objectKeys = Object.keys(parsedRecord).slice(0, 10);
      if (objectKeys.length > 0) {
        profileLines.push(`object_keys=${objectKeys.join(',')}`);
      }
      const objectArrayPaths = objectKeys.filter((key) => Array.isArray(parsedRecord[key]));
      if (objectArrayPaths.length > 0) {
        profileLines.push(`object_array_paths=${objectArrayPaths.join(',')}`);
        const firstArrayPath = objectArrayPaths[0];
        const firstArray = parsedRecord[firstArrayPath];
        const sampleItem = Array.isArray(firstArray) ? getRecord(firstArray[0]) : null;
        if (sampleItem) {
          const sampleItemKeys = Object.keys(sampleItem).slice(0, 10);
          if (sampleItemKeys.length > 0) {
            profileLines.push(`${firstArrayPath}_sample_keys=${sampleItemKeys.join(',')}`);
          }
        }
      }
    } else {
      profileLines.push('json=parseable');
      profileLines.push(`top_level=${typeof parsed}`);
    }
  } catch {
    profileLines.push('json=unparseable');
    profileLines.push('top_level=text');
  }

  profileLines.push('preview:');
  profileLines.push(preview);
  return profileLines.join('\n');
}

export function buildPlannerSystemPrompt(options: {
  presetPromptPrefix: string;
  additionalPromptPrefix: string;
  systemContext: PresetSystemContext;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  rawReviewRequired: boolean;
  toolDefinitions: readonly PlannerToolDefinition[];
}): string {
  const sections = [
    'You are SiftKit, a conservative shell-output compressor for Codex workflows.',
    '',
    'Planner mode:',
    '- The full input is too large for a direct pass, so inspect only the minimum evidence needed.',
    '- If the document profile or current tool results are already sufficient, finish immediately.',
    '- Use the provided tools. When multiple independent calls are genuinely useful, you may call them in the same response.',
    '- Complete the task only by calling `finish` with the final classification, raw-review decision, and output.',
    '- Use separate filters for gte/lte bounds in json_filter; do not combine multiple operators inside one filter value.',
    '- Do not use "value":{"gte":3200,"lte":3215}. Use one filter per bound with a scalar value.',
    '- When the document profile shows top_level=object with object_array_paths=..., use collectionPath to target that array and filter item fields relative to each array element.',
    '- Use concrete literal tool arguments, never JSON schema fragments.',
    '- Regex patterns must be valid JavaScript regex source for find_text. Do not add unnecessary escapes for ordinary quotes.',
    '- After `find_text` identifies a useful anchor, default to one larger contiguous `read_lines` window rather than multiple tiny nearby slices.',
    '- If you already used `read_lines` once, do another `find_text` search before requesting a second nearby `read_lines` slice.',
    '',
    'Source handling:',
    getSourceInstructions(options.sourceKind, options.commandExitCode),
    '',
    'Risk handling:',
    options.rawReviewRequired
      ? 'Raw-log review is likely required. Set raw_review_required to true unless the visible evidence clearly proves otherwise.'
      : 'Set raw_review_required to false unless the output contains genuine errors, failures, or incomplete results that warrant manual inspection.',
  ];

  return new PresetSystemPromptComposer(
    options.presetPromptPrefix,
    options.systemContext,
  ).compose(sections.join('\n'), options.additionalPromptPrefix);
}

export function buildPlannerInputSection(options: {
  question: string;
  inputText: string;
}): string {
  return [
    'Question:',
    options.question,
    '',
    'Document profile:',
    buildPlannerDocumentProfile(options.inputText),
    '',
    'Use tools to inspect the full input when needed.',
  ].join('\n');
}

export function buildPlannerInvalidResponseUserPrompt(message: string): string {
  return [
    `Previous response was invalid: ${message.trim().replace(/\s+/gu, ' ')}`,
    'Call one of the provided tools with valid arguments. Call `finish` only when the final answer is ready.',
  ].join('\n');
}

export function buildPlannerForcedFinishUserPrompt(reason?: string): string {
  return [
    'You have used all available tool calls.',
    reason || 'Using only the evidence gathered so far, produce your final answer now.',
  ].join('\n');
}

export function renderPlannerTranscript(messages: LlamaCppChatMessage[]): string {
  return messages.map((message) => {
    const sections: string[] = [];
    if (typeof message.content === 'string' && message.content) {
      sections.push(message.content);
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        sections.push(`Tool call: ${toolCall.function?.name ?? ''} ${String(toolCall.function?.arguments ?? '')}`.trim());
      }
    }
    if (message.role === 'tool' && typeof message.content === 'string' && message.content) {
      return `[tool]\nTool result:\n${message.content}`;
    }
    return sections.join('\n');
  }).join('\n\n');
}

export function buildPlannerAssistantToolMessage(
  action: SummaryNativeToolCall,
  toolCallId: string
): LlamaCppChatMessage {
  return buildSharedAssistantToolCallMessage(action, toolCallId);
}
