import { getErrorMessage } from '../../src/lib/errors.ts';
import { main } from './runner.ts';

void main().catch((error) => {
  process.stderr.write(`${getErrorMessage(error)}\n`);
  process.exit(1);
});
