// A stand-in for the status server: it starts one agent command and waits, so a test can force-kill it.
import { runAgentCommand } from '../../src/repo-search/engine/agent-command.ts';

const command = process.argv[2];
if (command === undefined) throw new Error('The host needs a command.');
await runAgentCommand(command, { cwd: process.cwd(), timeoutMs: 120_000 });
