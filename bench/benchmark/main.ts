import { getErrorMessage } from '../../src/lib/errors.js';
import { main } from './runner.js';

void main().catch((error) => {
  process.stderr.write(`${getErrorMessage(error)}\n`);
  process.exit(1);
});
