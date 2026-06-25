import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isClassDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isMethodDeclaration,
  isVariableStatement,
  ScriptTarget,
  type Node,
  type SourceFile,
} from 'typescript';

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
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.requestProviderAction', maxLines: 90 },
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

function findFunctionBody(source: SourceFile, symbol: string): Node | null {
  const [ownerName, methodName] = symbol.split('.');
  let body: Node | null = null;
  const visit = (node: Node): void => {
    if (body) return;
    if (methodName) {
      if (isClassDeclaration(node) && node.name?.text === ownerName) {
        for (const member of node.members) {
          if (isMethodDeclaration(member) && member.name.getText(source) === methodName && member.body) {
            body = member.body;
          }
        }
      }
    } else {
      if (isFunctionDeclaration(node) && node.name?.text === ownerName && node.body) {
        body = node.body;
      }
      if (isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (
            declaration.name.getText(source) === ownerName
            && declaration.initializer
            && (isArrowFunction(declaration.initializer) || isFunctionExpression(declaration.initializer))
          ) {
            body = declaration.initializer.body;
          }
        }
      }
    }
    if (!body) forEachChild(node, visit);
  };
  forEachChild(source, visit);
  return body;
}

function countFunctionLines(sourceText: string, symbol: string): number {
  const source = createSourceFile(symbol, sourceText, ScriptTarget.Latest, true);
  const body = findFunctionBody(source, symbol);
  assert.ok(body, `Expected ${symbol} to exist`);
  const startLine = source.getLineAndCharacterOfPosition(body.getStart(source)).line;
  const endLine = source.getLineAndCharacterOfPosition(body.getEnd()).line;
  return endLine - startLine + 1;
}

test('line counter measures the body, not an inline object parameter', () => {
  const fixture = [
    'class Fixture {',
    '  method(override?: {',
    '    a: string;',
    '    b: number;',
    '  }): void {',
    '    const x = 1;',
    '    const y = 2;',
    '    return;',
    '  }',
    '}',
  ].join('\n');
  // Body spans the `{` on the `}): void {` line through its closing `}` = 5 lines.
  // The brace-matching heuristic locked onto the parameter object `{` and reported 4,
  // letting arbitrarily long bodies bypass the guard.
  assert.equal(countFunctionLines(fixture, 'Fixture.method'), 5);
});

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
