import { runAutoApprovalVerdictProbeCli } from '../src/cli/run-auto-approval-probe.js';

async function main(): Promise<void> {
  process.exitCode = await runAutoApprovalVerdictProbeCli({
    argv: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
