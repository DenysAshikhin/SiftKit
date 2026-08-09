import fs from 'node:fs';
import os from 'node:os';

import { parseMinAgeMinutes, purgeTempDirectories } from './purge-temp-dirs.js';

const minAgeMinutes = parseMinAgeMinutes(process.argv.slice(2));
const tempRoot = fs.realpathSync(os.tmpdir());
const result = purgeTempDirectories(tempRoot, Date.now() - minAgeMinutes * 60_000);
process.stdout.write(
  `purge-temp-dirs: removed=${result.removed} skipped=${result.skipped} `
  + `failed=${result.failed} root=${tempRoot}\n`,
);
