/**
 * Planner Debug Log Failure Analyzer
 *
 * Reads all planner_debug_*.json files from .siftkit/logs/
 * and categorizes + prints full details of every parsing failure.
 */

import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(__dirname, '..', '.siftkit', 'logs');
const MAX_EXAMPLES_PER_CATEGORY = 3;

interface PlannerEvent {
  kind: string;
  error?: string;
  responseText?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  command?: string;
  output?: { text?: string; error?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface PlannerDebugData {
  question?: string;
  events?: PlannerEvent[];
  final?: { reason?: string; status?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface InvalidRecord {
  file: string;
  error: string;
  rawModelText: string | null;
  toolCall: { action: string; tool_name: string; args: unknown } | null;
  finalStatus: string | undefined;
  question: string | undefined;
}

interface ToolFailureRecord {
  file: string;
  toolName: string;
  args: Record<string, unknown> | undefined;
  command: string | undefined;
  output: unknown;
  question: string | undefined;
}

interface RegexFailureRecord {
  file: string;
  toolName: string;
  args: Record<string, unknown> | undefined;
  command: string | undefined;
  outputText: string;
  outputError: string | undefined;
  question: string | undefined;
}

function separator(title: string): void {
  const line = '='.repeat(100);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function subSeparator(title: string): void {
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(90));
}

function printFull(label: string, value: unknown): void {
  console.log(`\n  [${label}]:`);
  if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

const allFiles = fs
  .readdirSync(LOG_DIR)
  .filter((f) => f.startsWith('planner_debug_') && f.endsWith('.json'));

console.log(`Found ${allFiles.length} planner debug files in ${LOG_DIR}\n`);

interface Category {
  label: string;
  items: InvalidRecord[];
}

const categories: Record<string, Category> = {
  json_parse_error: {
    label: 'JSON Parse Error (malformed JSON from model)',
    items: [],
  },
  unknown_action: {
    label: 'Unknown Planner Action (valid JSON but unrecognized action)',
    items: [],
  },
  json_filter_validation: {
    label: 'json_filter Validation Error (valid tool call, bad args for json_filter)',
    items: [],
  },
  tool_execution_error: {
    label: 'Tool Execution Error (valid tool call, tool itself failed)',
    items: [],
  },
  out_of_tool_calls: {
    label: 'Out of Tool Calls (budget exhausted)',
    items: [],
  },
  other: {
    label: 'Other / Uncategorized',
    items: [],
  },
};

const jsonFilterFailures: ToolFailureRecord[] = [];
const regexFailures: RegexFailureRecord[] = [];
const allInvalidEvents: InvalidRecord[] = [];

let filesWithInvalid = 0;
let totalInvalid = 0;

for (const fileName of allFiles) {
  let data: PlannerDebugData;
  try {
    data = JSON.parse(fs.readFileSync(path.join(LOG_DIR, fileName), 'utf8')) as PlannerDebugData;
  } catch {
    continue;
  }

  const events = data.events || [];
  let fileHasInvalid = false;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    if (ev.kind === 'planner_invalid_response') {
      fileHasInvalid = true;
      totalInvalid++;

      const error = ev.error || '(no error message)';

      let precedingModelText: string | null = null;
      let precedingToolCall: { action: string; tool_name: string; args: unknown } | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (events[j].kind === 'planner_model_response') {
          precedingModelText = events[j].responseText ?? null;
          break;
        }
      }

      if (precedingModelText) {
        try {
          const parsed = JSON.parse(precedingModelText) as Record<string, unknown>;
          if (parsed.action === 'tool' || parsed.tool_name) {
            precedingToolCall = {
              action: parsed.action as string,
              tool_name: parsed.tool_name as string,
              args: parsed.args,
            };
          }
        } catch {
          // not valid JSON
        }
      }

      const record: InvalidRecord = {
        file: fileName,
        error,
        rawModelText: precedingModelText,
        toolCall: precedingToolCall,
        finalStatus: data.final?.status,
        question: data.question,
      };

      allInvalidEvents.push(record);

      if (error.includes('json_filter')) {
        categories.json_filter_validation.items.push(record);
      } else if (error.startsWith('Provider returned an invalid planner payload:')) {
        categories.json_parse_error.items.push(record);
      } else if (error === 'Provider returned an unknown planner action.') {
        categories.unknown_action.items.push(record);
      } else if (error.includes('Out of tool calls')) {
        categories.out_of_tool_calls.items.push(record);
      } else {
        categories.other.items.push(record);
      }
    }

    if (ev.kind === 'planner_tool' && ev.toolName === 'json_filter') {
      const outText = ev.output?.text || '';
      const outError = ev.output?.error;
      if (
        outError ||
        outText.includes('Error') ||
        outText.includes('error') ||
        outText.includes('invalid') ||
        outText.includes('fail')
      ) {
        if (
          outError ||
          outText.startsWith('json_filter') ||
          outText.includes('json_filter error') ||
          outText.includes('json_filter invalid')
        ) {
          jsonFilterFailures.push({
            file: fileName,
            toolName: ev.toolName,
            args: ev.args,
            command: ev.command,
            output: ev.output,
            question: data.question,
          });
        }
      }
    }

    if (ev.kind === 'planner_tool' && ev.toolName === 'find_text') {
      const outText = ev.output?.text || '';
      const outError = ev.output?.error;
      if (
        outText.includes('invalid regex') ||
        outText.includes('Invalid regular expression') ||
        outText.includes('SyntaxError') ||
        outError?.includes('regex') ||
        outError?.includes('Invalid regular expression')
      ) {
        regexFailures.push({
          file: fileName,
          toolName: ev.toolName,
          args: ev.args,
          command: ev.command,
          outputText: outText,
          outputError: outError,
          question: data.question,
        });
      }
    }

    if (ev.kind === 'planner_tool' && ev.toolName === 'find_text' && ev.output?.error) {
      const already = regexFailures.some(
        (r) => r.file === fileName && r.args?.query === ev.args?.query
      );
      if (!already) {
        regexFailures.push({
          file: fileName,
          toolName: ev.toolName,
          args: ev.args,
          command: ev.command,
          outputText: ev.output.text ?? '',
          outputError: ev.output.error,
          question: data.question,
        });
      }
    }
  }

  if (fileHasInvalid) filesWithInvalid++;
}

// REPORT
separator('SUMMARY');
console.log(`  Total planner debug files analyzed: ${allFiles.length}`);
console.log(`  Files containing invalid responses:  ${filesWithInvalid}`);
console.log(`  Total planner_invalid_response events: ${totalInvalid}`);
console.log(`  json_filter tool-level failures: ${jsonFilterFailures.length}`);
console.log(`  Regex (find_text) invalid pattern failures: ${regexFailures.length}`);

console.log('\n  Breakdown by category:');
for (const [, cat] of Object.entries(categories)) {
  console.log(`    ${cat.label}: ${cat.items.length}`);
}

for (const [, cat] of Object.entries(categories)) {
  if (cat.items.length === 0) continue;

  separator(`CATEGORY: ${cat.label}  (${cat.items.length} occurrences)`);

  const uniqueTexts = new Map<string, { item: InvalidRecord; count: number }>();
  for (const item of cat.items) {
    const key = item.rawModelText || item.error;
    if (!uniqueTexts.has(key)) {
      uniqueTexts.set(key, { item, count: 1 });
    } else {
      uniqueTexts.get(key)!.count++;
    }
  }

  console.log(`\n  Unique failure patterns: ${uniqueTexts.size}`);

  let shown = 0;
  for (const [, { item, count }] of uniqueTexts) {
    if (shown >= MAX_EXAMPLES_PER_CATEGORY) {
      console.log(
        `\n  ... and ${uniqueTexts.size - shown} more unique patterns not shown.`
      );
      break;
    }
    shown++;

    subSeparator(`Example ${shown} (appears ${count}x) — File: ${item.file}`);

    console.log(`\n  Error message: ${item.error}`);

    if (item.question) {
      console.log(`\n  Original question/command: ${item.question}`);
    }

    if (item.rawModelText !== null && item.rawModelText !== undefined) {
      console.log(`\n  ┌─── FULL RAW MODEL TEXT ───┐`);
      console.log(item.rawModelText);
      console.log(`  └─── END RAW MODEL TEXT ───┘`);
    } else {
      console.log(`\n  (No preceding model response found)`);
    }

    if (item.toolCall) {
      console.log(`\n  Parsed tool call attempt:`);
      console.log(`    action:    ${item.toolCall.action}`);
      console.log(`    tool_name: ${item.toolCall.tool_name}`);
      console.log(`    args:      ${JSON.stringify(item.toolCall.args, null, 2)}`);
    }

    console.log(`\n  Final status: ${item.finalStatus}`);
  }
}

// json_filter FAILURES (tool-level)
separator(`json_filter TOOL-LEVEL FAILURES  (${jsonFilterFailures.length} occurrences)`);

if (jsonFilterFailures.length === 0) {
  console.log('\n  No json_filter tool-level failures found.');
  console.log('  Note: json_filter validation errors appear as planner_invalid_response events instead.');
  console.log("  See the 'json_filter Validation Error' category above.");
} else {
  const shown = jsonFilterFailures.slice(0, MAX_EXAMPLES_PER_CATEGORY);
  for (let i = 0; i < shown.length; i++) {
    const ex = shown[i];
    subSeparator(`json_filter failure ${i + 1} — File: ${ex.file}`);
    printFull('Full error / output text', ex.output);
    printFull('Args the model provided', ex.args);
    if (ex.command) printFull('Raw command string', ex.command);
  }
}

// json_filter as planner_invalid_response
const jsonFilterInvalids = categories.json_filter_validation.items;
if (jsonFilterInvalids.length > 0) {
  separator(`json_filter VALIDATION ERRORS (via planner_invalid_response)  (${jsonFilterInvalids.length} occurrences)`);

  const uniqueJsonFilter = new Map<string, { item: InvalidRecord; count: number }>();
  for (const item of jsonFilterInvalids) {
    const key = item.rawModelText || item.error;
    if (!uniqueJsonFilter.has(key)) {
      uniqueJsonFilter.set(key, { item, count: 1 });
    } else {
      uniqueJsonFilter.get(key)!.count++;
    }
  }

  console.log(`  Unique patterns: ${uniqueJsonFilter.size}`);

  let shown = 0;
  for (const [, { item, count }] of uniqueJsonFilter) {
    if (shown >= MAX_EXAMPLES_PER_CATEGORY) break;
    shown++;

    subSeparator(`json_filter validation error ${shown} (appears ${count}x) — File: ${item.file}`);

    console.log(`\n  Error: ${item.error}`);

    console.log(`\n  ┌─── FULL RAW MODEL TEXT (the tool call that failed validation) ───┐`);
    console.log(item.rawModelText);
    console.log(`  └─── END RAW MODEL TEXT ───┘`);

    if (item.toolCall) {
      console.log(`\n  Parsed args the model provided:`);
      console.log(JSON.stringify(item.toolCall.args, null, 2));
    }
  }
}

// REGEX FAILURES
separator(`REGEX / find_text INVALID PATTERN FAILURES  (${regexFailures.length} occurrences)`);

if (regexFailures.length === 0) {
  console.log('\n  No regex failures found.');
} else {
  const uniqueRegex = new Map<string, { item: RegexFailureRecord; count: number }>();
  for (const item of regexFailures) {
    const key = (item.args?.query || '') + '|' + (item.outputText || item.outputError || '');
    if (!uniqueRegex.has(key as string)) {
      uniqueRegex.set(key as string, { item, count: 1 });
    } else {
      uniqueRegex.get(key as string)!.count++;
    }
  }

  console.log(`  Unique regex failure patterns: ${uniqueRegex.size}`);

  let shown = 0;
  for (const [, { item, count }] of uniqueRegex) {
    if (shown >= MAX_EXAMPLES_PER_CATEGORY) {
      console.log(
        `\n  ... and ${uniqueRegex.size - shown} more unique patterns not shown.`
      );
      break;
    }
    shown++;

    subSeparator(`Regex failure ${shown} (appears ${count}x) — File: ${item.file}`);

    console.log(`\n  ┌─── FULL ERROR ───┐`);
    console.log(item.outputText || item.outputError || '(no error text)');
    console.log(`  └─── END ERROR ───┘`);

    console.log(`\n  ┌─── PATTERN THE MODEL TRIED ───┐`);
    console.log(item.args?.query || '(no query)');
    console.log(`  └─── END PATTERN ───┘`);

    console.log(`\n  Full args: ${JSON.stringify(item.args, null, 2)}`);
    if (item.command) console.log(`  Raw command: ${item.command}`);
    if (item.question) console.log(`  Original question: ${item.question}`);
  }
}

// CROSS-REFERENCE: files that failed entirely due to invalid responses
separator('FILES THAT FAILED DUE TO planner_invalid_response_limit');

let limitFailCount = 0;
for (const fileName of allFiles) {
  let data: PlannerDebugData;
  try {
    data = JSON.parse(fs.readFileSync(path.join(LOG_DIR, fileName), 'utf8')) as PlannerDebugData;
  } catch {
    continue;
  }
  if (
    data.final?.reason === 'planner_invalid_response_limit' ||
    data.final?.status === 'failed'
  ) {
    const invalidCount = (data.events || []).filter(
      (e) => e.kind === 'planner_invalid_response'
    ).length;
    if (invalidCount > 0) {
      limitFailCount++;
    }
  }
}
console.log(
  `\n  ${limitFailCount} files failed entirely because the planner could not produce a valid response.`
);

separator('END OF ANALYSIS');
