import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

type FunctionLimit = {
  filePath: string;
  symbol: string;
  maxLines: number;
};

const limits: FunctionLimit[] = [
  { filePath: 'src/summary/planner/mode.ts', symbol: 'invokePlannerMode', maxLines: 180 },
  { filePath: 'src/status-server/routes/chat.ts', symbol: 'handleChatRoute', maxLines: 60 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'handleCoreRoute', maxLines: 60 },
  { filePath: 'src/status-server/routes/dashboard.ts', symbol: 'handleDashboardRoute', maxLines: 70 },
  { filePath: 'src/status-server/routes/llama-passthrough.ts', symbol: 'handleLlamaPassthroughRoute', maxLines: 60 },
  { filePath: 'src/summary/core.ts', symbol: 'summarizeRequest', maxLines: 10 },
  { filePath: 'src/summary/core-runner.ts', symbol: 'invokeSummaryCore', maxLines: 10 },
  { filePath: 'src/summary/core-runner.ts', symbol: 'run', maxLines: 35 },
  { filePath: 'src/summary/request-runner.ts', symbol: 'run', maxLines: 35 },
];

function findFunctionBodyStart(sourceText: string, symbol: string): number {
  const startPattern = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${symbol}\\b`
      + `|(?:export\\s+)?(?:const|let)\\s+${symbol}\\b`
      + `|(?:private\\s+|public\\s+|protected\\s+)?(?:async\\s+)?${symbol}\\s*\\(`,
    'u',
  );
  const startMatch = startPattern.exec(sourceText);
  assert.ok(startMatch, `Expected ${symbol} to exist`);
  const bodyStart = sourceText.indexOf('{', startMatch.index);
  assert.notEqual(bodyStart, -1, `Expected ${symbol} body`);
  return bodyStart;
}

function countFunctionLines(sourceText: string, symbol: string): number {
  const bodyStart = findFunctionBodyStart(sourceText, symbol);
  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return sourceText.slice(bodyStart, index + 1).split(/\r?\n/u).length;
    }
  }
  throw new Error(`Could not find end of ${symbol}`);
}

test('touched planner and route entrypoints stay below god-function limits', () => {
  for (const limit of limits) {
    const absolutePath = path.join(process.cwd(), limit.filePath);
    const lineCount = countFunctionLines(fs.readFileSync(absolutePath, 'utf8'), limit.symbol);
    assert.ok(
      lineCount <= limit.maxLines,
      `${limit.symbol} in ${limit.filePath} has ${lineCount} lines; limit is ${limit.maxLines}`,
    );
  }
});
