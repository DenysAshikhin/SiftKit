import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { JsonValueSchema } from '../../src/lib/json-types.ts';

// The repo root package.json is read by E2E tests that assert on script wiring;
// the schema yields an inferred DTO so callers read `manifest.scripts` without a cast.
const PackageManifestSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    scripts: z.record(z.string(), z.string()),
  })
  .catchall(JsonValueSchema);

export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export function readPackageJson(
  filePath: string = path.resolve(process.cwd(), 'package.json'),
): PackageManifest {
  return PackageManifestSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}
