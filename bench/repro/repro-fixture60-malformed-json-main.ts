import { getErrorMessage } from '../../src/lib/errors.js';
import { runFixture60MalformedJsonRepro } from './repro-fixture60-malformed-json.js';

void runFixture60MalformedJsonRepro(process.argv.slice(2)).then(
  (result) => { process.exit(result.exitCode); },
  (error) => {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exit(1);
  },
);
