import { getErrorMessage } from '../../src/lib/errors.js';
import { runDebugRequest } from './run-benchmark-fixture-debug.js';

void runDebugRequest(process.argv.slice(2)).then(
  (result) => { process.exit(result.exitCode); },
  (error) => {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exit(1);
  },
);
