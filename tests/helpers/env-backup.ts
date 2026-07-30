/**
 * Captures the given environment variables on construction and puts them back on
 * restore(): re-assigning the ones that were set, deleting the ones that were not.
 *
 * This is a leaf module on purpose. It imports nothing, so helpers that must stay
 * light — tests/helpers/dead-endpoints.ts, for one — can reuse it without pulling in
 * the runtime database and better-sqlite3 that tests/_test-helpers.ts brings along.
 */
export class EnvBackup {
  private readonly previousValues: ReadonlyMap<string, string | undefined>;

  constructor(keys: readonly string[]) {
    this.previousValues = new Map(keys.map((key) => [key, process.env[key]]));
  }

  restore(): void {
    for (const [key, value] of this.previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
