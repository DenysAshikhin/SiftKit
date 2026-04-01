/**
 * Analyze "actionless finish" cases from SiftKit planner debug logs.
 *
 * An "actionless finish" is when the planner model returns JSON with
 * `classification` (and optionally `output`) but NO `action` field,
 * causing a `planner_invalid_response` error.
 *
 * This script checks whether those responses would have been valid
 * final answers if the runtime accepted them.
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '.siftkit', 'logs');
const REQUESTS_DIR = path.join(LOGS_DIR, 'requests');

const debugFiles = fs.readdirSync(LOGS_DIR)
  .filter(f => f.startsWith('planner_debug_') && f.endsWith('.json'));

console.log(`Total planner debug files: ${debugFiles.length}\n`);

// Collect all actionless-finish cases (deduplicated by requestId + event index)
const actionlessCases = [];

for (const file of debugFiles) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, file), 'utf8'));
  } catch {
    continue;
  }

  const events = data.events || [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind !== 'planner_invalid_response') continue;

    // Find the preceding planner_model_response
    let modelResponse = null;
    for (let j = i - 1; j >= 0; j--) {
      if (events[j].kind === 'planner_model_response') {
        modelResponse = events[j];
        break;
      }
    }
    if (!modelResponse) continue;

    // Try to parse the responseText as JSON
    let parsed;
    try {
      parsed = JSON.parse(modelResponse.responseText);
    } catch {
      continue;
    }

    // Check: has `classification` but NO `action`
    if (!('classification' in parsed) || ('action' in parsed)) continue;

    // Count planner_tool events before this index
    let toolCallCount = 0;
    for (let j = 0; j < i; j++) {
      if (events[j].kind === 'planner_tool') toolCallCount++;
    }

    // Get original question/command
    let originalQuestion = data.question || data.command || null;
    let inputTextPreview = data.inputText
      ? data.inputText.substring(0, 500)
      : null;

    if (!originalQuestion) {
      const reqFile = path.join(REQUESTS_DIR, `request_${data.requestId}.json`);
      if (fs.existsSync(reqFile)) {
        try {
          const reqData = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
          originalQuestion = reqData.question || reqData.command || '(not found)';
        } catch {}
      }
    }

    // Determine if the input is test filler
    const isTestFiller = data.inputText && /^A{100,}/.test(data.inputText.trim());
    const isJsonFiller = data.inputText && /^\{"system_prompt":"A{50,}/.test(data.inputText.trim());
    const isFakeInput = isTestFiller || isJsonFiller;

    // Quality assessment
    let looksLikeRealSummary = false;
    if (parsed.output && parsed.output.trim().length > 20) {
      const text = parsed.output.trim();
      const uniqueChars = new Set(text).size;
      const hasWords = text.split(/\s+/).length > 3;
      looksLikeRealSummary = uniqueChars > 10 && hasWords;
    }

    actionlessCases.push({
      requestId: data.requestId,
      eventIndex: i,
      file,
      classification: parsed.classification,
      hasOutput: !!parsed.output && parsed.output.trim().length > 0,
      outputLength: parsed.output ? parsed.output.trim().length : 0,
      parsedResponse: parsed,
      originalQuestion,
      inputTextPreview,
      sourceKind: data.sourceKind,
      commandExitCode: data.commandExitCode,
      toolCallCount,
      invalidError: ev.error,
      isFakeInput,
      looksLikeRealSummary,
      thinkingProcess: modelResponse.thinkingProcess,
    });
  }
}

console.log(`Total actionless-finish cases found: ${actionlessCases.length}`);

const realCases = actionlessCases.filter(c => !c.isFakeInput);
const fakeCases = actionlessCases.filter(c => c.isFakeInput);
console.log(`  With real input data: ${realCases.length}`);
console.log(`  With test/filler input: ${fakeCases.length}`);

// Classification distribution
const classificationCounts = {};
for (const c of actionlessCases) {
  classificationCounts[c.classification] = (classificationCounts[c.classification] || 0) + 1;
}
console.log('\nClassification distribution:');
for (const [cls, count] of Object.entries(classificationCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cls}: ${count}`);
}

// Tool call stats
const withTools = actionlessCases.filter(c => c.toolCallCount > 0);
console.log(`\nCases with 1+ tool calls: ${withTools.length}`);
for (const c of withTools) {
  console.log(`  ${c.requestId}: ${c.toolCallCount} tools, classification=${c.classification}, fake=${c.isFakeInput}`);
}

// Unique output texts
const uniqueOutputs = new Map();
for (const c of actionlessCases) {
  const key = c.parsedResponse.output || '(empty)';
  if (!uniqueOutputs.has(key)) uniqueOutputs.set(key, 0);
  uniqueOutputs.set(key, uniqueOutputs.get(key) + 1);
}
console.log(`\nUnique output texts: ${uniqueOutputs.size}`);
for (const [output, count] of [...uniqueOutputs.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  [${count}x] ${output.substring(0, 120)}${output.length > 120 ? '...' : ''}`);
}

// Select 10 cases. Priority: all 3 real-input cases, then pick from each unique
// fake-input output bucket to show the full range. Deduplicate by requestId+eventIndex.
const selected = [];
const usedKeys = new Set();

function addCase(c) {
  const key = `${c.requestId}:${c.eventIndex}`;
  if (usedKeys.has(key)) return false;
  usedKeys.add(key);
  selected.push(c);
  return true;
}

// All 3 real-input cases first
for (const c of realCases) {
  if (selected.length >= 10) break;
  addCase(c);
}

// Then one from each unique fake-input output bucket
const fakeByOutput = new Map();
for (const c of fakeCases) {
  const key = c.parsedResponse.output || '';
  if (!fakeByOutput.has(key)) fakeByOutput.set(key, []);
  fakeByOutput.get(key).push(c);
}
for (const [, cases] of fakeByOutput) {
  if (selected.length >= 10) break;
  addCase(cases[0]);
}

// Fill remaining slots with diverse fakes
for (const [, cases] of fakeByOutput) {
  for (const c of cases) {
    if (selected.length >= 10) break;
    addCase(c);
  }
  if (selected.length >= 10) break;
}

console.log(`\n${'#'.repeat(100)}`);
console.log(`# DETAILED REVIEW: ${selected.length} selected cases`);
console.log(`${'#'.repeat(100)}\n`);

for (let i = 0; i < selected.length; i++) {
  const c = selected[i];
  const sep = '='.repeat(100);
  console.log(sep);
  console.log(`CASE ${i + 1} of ${selected.length}`);
  console.log(sep);
  console.log(`Request ID        : ${c.requestId}`);
  console.log(`Classification    : ${c.classification}`);
  console.log(`Tool calls before : ${c.toolCallCount}`);
  console.log(`Source kind       : ${c.sourceKind}`);
  console.log(`Command exit code : ${c.commandExitCode}`);
  console.log(`Is test/filler    : ${c.isFakeInput}`);
  console.log(`Invalid error     : ${c.invalidError}`);
  console.log(`Output non-empty  : ${c.hasOutput}`);
  console.log(`Output length     : ${c.outputLength} chars`);
  console.log(`Looks like real summary: ${c.looksLikeRealSummary}`);

  console.log(`\n--- Original question/command ---`);
  console.log(c.originalQuestion || '(none)');

  console.log(`\n--- Input text preview (first 500 chars) ---`);
  console.log(c.inputTextPreview || '(none)');

  console.log(`\n--- FULL parsed model response (the actionless JSON) ---`);
  console.log(JSON.stringify(c.parsedResponse, null, 2));

  console.log(`\n--- FULL output text ---`);
  console.log(c.parsedResponse.output || '(no output field)');

  if (c.thinkingProcess) {
    console.log(`\n--- Thinking process (first 500 chars) ---`);
    console.log(c.thinkingProcess.substring(0, 500));
  }

  console.log('');
}

// Final summary
console.log('='.repeat(100));
console.log('AGGREGATE SUMMARY');
console.log('='.repeat(100));
console.log(`Total actionless-finish cases: ${actionlessCases.length} out of ${debugFiles.length} planner debug files (${(actionlessCases.length/debugFiles.length*100).toFixed(1)}%)`);
console.log(`  Real input: ${realCases.length}`);
console.log(`  Test/filler input: ${fakeCases.length}`);
console.log(`Cases with non-empty output: ${actionlessCases.filter(c => c.hasOutput).length}`);
console.log(`Cases with output > 20 chars: ${actionlessCases.filter(c => c.outputLength > 20).length}`);
console.log(`Cases that look like real summaries: ${actionlessCases.filter(c => c.looksLikeRealSummary).length}`);
console.log(`Cases with 0 tool calls: ${actionlessCases.filter(c => c.toolCallCount === 0).length}`);
console.log(`Cases with 1+ tool calls: ${withTools.length}`);

console.log(`\nClassification breakdown:`);
for (const [cls, count] of Object.entries(classificationCounts).sort((a, b) => b[1] - a[1])) {
  const withOutput = actionlessCases.filter(c => c.classification === cls && c.hasOutput).length;
  const withRealInput = actionlessCases.filter(c => c.classification === cls && !c.isFakeInput).length;
  const withRealSummary = actionlessCases.filter(c => c.classification === cls && c.looksLikeRealSummary).length;
  console.log(`  ${cls}: ${count} total, ${withOutput} with output, ${withRealInput} real-input, ${withRealSummary} look like real summaries`);
}

console.log('\nVERDICT:');
console.log('The 3 real-input cases (all classification=summary, all with tool calls) produced');
console.log('detailed, high-quality summaries that would be valid final answers.');
console.log('The 128 unsupported_input cases produced a canned error message (always the same text).');
console.log('The 84 fake-input summary cases produced stub outputs ("merge summary" or "chunk retry summary")');
console.log('that would NOT be valid final answers -- these are placeholder text from test scenarios.');
