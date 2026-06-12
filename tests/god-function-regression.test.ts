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
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.executeTools', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.handleForcedFinishAttempt', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.handleToolCallLimit', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.handleDuplicateToolAction', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.executeSingleToolAction', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.executeToolBatch', maxLines: 90 },
  { filePath: 'src/status-server/routes/chat.ts', symbol: 'handleChatRoute', maxLines: 60 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'handleCoreRoute', maxLines: 60 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'StatusPostEndpoint.handle', maxLines: 90 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'StatusPostRequestHandler.handle', maxLines: 90 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'StatusPostRequestHandler.updateStatusMetrics', maxLines: 90 },
  { filePath: 'src/status-server/routes/dashboard.ts', symbol: 'handleDashboardRoute', maxLines: 70 },
  { filePath: 'src/status-server/routes/llama-passthrough.ts', symbol: 'handleLlamaPassthroughRoute', maxLines: 60 },
  { filePath: 'src/summary/core.ts', symbol: 'summarizeRequest', maxLines: 10 },
  { filePath: 'src/summary/core-runner.ts', symbol: 'invokeSummaryCore', maxLines: 10 },
  { filePath: 'src/summary/core-runner.ts', symbol: 'SummaryCoreRunner.run', maxLines: 35 },
  { filePath: 'src/summary/request-runner.ts', symbol: 'SummaryRequestRunner.run', maxLines: 35 },
];

function findClassBody(sourceText: string, className: string): string {
  const classMatch = new RegExp(`class\\s+${className}\\b`, 'u').exec(sourceText);
  assert.ok(classMatch, `Expected ${className} to exist`);
  const bodyStart = sourceText.indexOf('{', classMatch.index);
  assert.notEqual(bodyStart, -1, `Expected ${className} body`);
  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return sourceText.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not find end of ${className}`);
}

function findFunctionBodyStart(sourceText: string, symbol: string): number {
  const [className, methodName] = symbol.split('.');
  const searchText = methodName ? findClassBody(sourceText, className) : sourceText;
  const searchSymbol = methodName || symbol;
  const startPattern = methodName
    ? new RegExp(
      `^\\s*(?:private\\s+|public\\s+|protected\\s+)?(?:async\\s+)?${searchSymbol}\\s*\\(`,
      'mu',
    )
    : new RegExp(
      `^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${searchSymbol}\\b`
        + `|^\\s*(?:export\\s+)?(?:const|let)\\s+${searchSymbol}\\b`,
      'mu',
    );
  const startMatch = startPattern.exec(searchText);
  assert.ok(startMatch, `Expected ${symbol} to exist`);
  const bodyStart = searchText.indexOf('{', startMatch.index);
  assert.notEqual(bodyStart, -1, `Expected ${symbol} body`);
  return bodyStart;
}

function countFunctionLines(sourceText: string, symbol: string): number {
  const methodName = symbol.includes('.');
  const searchText = methodName ? findClassBody(sourceText, symbol.split('.')[0]) : sourceText;
  const bodyStart = findFunctionBodyStart(sourceText, symbol);
  let depth = 0;
  for (let index = bodyStart; index < searchText.length; index += 1) {
    const char = searchText[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return searchText.slice(bodyStart, index + 1).split(/\r?\n/u).length;
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
