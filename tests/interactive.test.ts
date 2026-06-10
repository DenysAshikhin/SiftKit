import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveExternalCommand } from '../dist/capture/command-path.js';
import { captureWithTranscript } from '../dist/capture/process.js';
import { CommandOutputAnalyzer } from '../dist/command-output/analyzer.js';
import { withTestEnvAndServer } from './_test-helpers.js';

type InteractiveCaptureTestRequest = {
  Command: string;
  ArgumentList?: string[];
  Question?: string;
  Format?: 'text' | 'json';
  PolicyProfile?: 'general' | 'pass-fail' | 'unique-errors' | 'buried-critical' | 'json-extraction' | 'diff-summary' | 'risky-operation';
};

async function captureInteractiveForTest(request: InteractiveCaptureTestRequest): Promise<{
  ExitCode: number;
  TranscriptPath: string;
  WasSummarized: boolean;
  RawReviewRequired: boolean;
  OutputText: string;
  Summary: string;
  Classification: string;
  PolicyDecision: string;
}> {
  const argumentList = request.ArgumentList || [];
  const captured = captureWithTranscript(resolveExternalCommand(request.Command), argumentList);
  const fallbackTranscript = `Interactive command completed without a captured transcript.\nCommand: ${request.Command} ${argumentList.join(' ')}\nExitCode: ${captured.ExitCode}`;
  const result = await new CommandOutputAnalyzer().analyze({
    outputKind: 'interactive',
    exitCode: captured.ExitCode,
    combinedText: captured.Transcript.trim() ? captured.Transcript : fallbackTranscript,
    commandText: [request.Command, ...argumentList].join(' '),
    question: request.Question,
    format: request.Format,
    policyProfile: request.PolicyProfile,
  });
  return {
    ExitCode: result.ExitCode,
    TranscriptPath: result.RawLogPath,
    WasSummarized: result.WasSummarized,
    RawReviewRequired: result.RawReviewRequired,
    OutputText: `${String(result.Summary || 'No summary generated.').trim()}\nRaw transcript: ${result.RawLogPath}`,
    Summary: result.Summary || '',
    Classification: result.Classification,
    PolicyDecision: result.PolicyDecision,
  };
}

test('interactive capture runs a simple command and produces output', async () => {
  await withTestEnvAndServer(async () => {
    const result = await captureInteractiveForTest({
      Command: 'node',
      ArgumentList: ['-e', 'console.log("hello from interactive capture test")'],
      Question: 'What was the output?',
    });
    assert.equal(typeof result.ExitCode, 'number');
    assert.equal(typeof result.TranscriptPath, 'string');
    assert.equal(typeof result.WasSummarized, 'boolean');
    assert.equal(typeof result.OutputText, 'string');
    assert.ok(result.OutputText.length > 0);
  });
});

test('interactive capture handles nonexistent command', async () => {
  await withTestEnvAndServer(async () => {
    try {
      const result = await captureInteractiveForTest({
        Command: 'nonexistent_command_xyz_test_12345',
        Question: 'What happened?',
      });
      assert.equal(typeof result.ExitCode, 'number');
    } catch (error) {
      assert.match((error as Error).message, /Unable to resolve|ENOENT|not found/u);
    }
  });
});

test('interactive capture with JSON format', async () => {
  await withTestEnvAndServer(async () => {
    const result = await captureInteractiveForTest({
      Command: 'node',
      ArgumentList: ['-e', 'console.log("test output for json format")'],
      Question: 'Extract the output',
      Format: 'json',
    });
    assert.equal(typeof result.OutputText, 'string');
    assert.ok(result.OutputText.length > 0);
  });
});

test('interactive capture with empty output handles gracefully', async () => {
  await withTestEnvAndServer(async () => {
    const result = await captureInteractiveForTest({
      Command: 'node',
      ArgumentList: ['-e', ''],
      Question: 'What happened?',
    });
    assert.equal(typeof result.ExitCode, 'number');
    assert.equal(typeof result.TranscriptPath, 'string');
  });
});

test('interactive capture with custom policy profile', async () => {
  await withTestEnvAndServer(async () => {
    const result = await captureInteractiveForTest({
      Command: 'node',
      ArgumentList: ['-e', 'console.log("pass fail test")'],
      Question: 'Did the test pass or fail?',
      PolicyProfile: 'pass-fail',
    });
    assert.equal(typeof result.PolicyDecision, 'string');
  });
});
