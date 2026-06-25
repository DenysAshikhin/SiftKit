import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { JsonValueSchema } from '../../src/lib/json-types.js';

// The repo root package.json is read by several E2E tests that assert on packed
// files and script wiring. Validating through a schema yields an inferred DTO so
// callers read `manifest.scripts`/`manifest.files` without a boundary cast.
const PackageManifestSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    files: z.array(z.string()),
    scripts: z.record(z.string(), z.string()),
  })
  .catchall(JsonValueSchema);

export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export function readPackageJson(
  filePath: string = path.resolve(process.cwd(), 'package.json'),
): PackageManifest {
  return PackageManifestSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}
