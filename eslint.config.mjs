import tseslint from 'typescript-eslint';

// Directories NOT YET cleaned. Each cleanup phase deletes its entries.
// When this array is empty, the gate is hard-fail repo-wide (P8).
const RATCHET_DIRTY = [];

const CLEAN_FIXTURES = ['tests/fixtures/eslint-gate/**'];

const TYPING_RULES = {
  '@typescript-eslint/consistent-type-assertions': [
    'error', { assertionStyle: 'never' },
  ],
  '@typescript-eslint/no-explicit-any': 'error',
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ImportNamespaceSpecifier',
      message: 'Namespace imports (import * as) are banned; use named imports.',
    },
    {
      selector: 'TSUnknownKeyword',
      message: 'Explicit unknown is banned; validate at the boundary with a schema-derived DTO.',
    },
    {
      selector: 'TSUnionType > TSTypeReference[typeName.name="JsonValue"]',
      message: 'Broad JsonValue unions are banned; parse boundary input into a schema-derived DTO.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dashboard/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '.siftkit/**',
      '.npm-cache/**',
      'eval/**/fixtures/**',
      'tests/fixtures/eslint-gate/cast.ts',
      'tests/fixtures/eslint-gate/namespace.ts',
      'tests/fixtures/eslint-gate/explicit-any.ts',
      'tests/fixtures/eslint-gate/explicit-unknown.ts',
      'tests/fixtures/eslint-gate/broad-json-union.ts',
      'tests/fixtures/eslint-gate/declaration.d.ts',
    ],
  },
  // tseslint.configs.base wires up the TS parser + plugin with NO rules and NO
  // type information requirement. Our rules are syntactic, so this is enough.
  tseslint.configs.base,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: TYPING_RULES,
  },
  // Ratchet: silence the typing rules for not-yet-cleaned dirs so CI stays green.
  // Empty once every phase is done (P8): the gate is then hard-fail repo-wide.
  ...(RATCHET_DIRTY.length > 0
    ? [{
      files: RATCHET_DIRTY,
      rules: {
        '@typescript-eslint/consistent-type-assertions': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        'no-restricted-syntax': 'off',
      },
    }]
    : []),
  // Gate fixtures must stay clean even while tests/** is ratcheted until P7.
  {
    files: CLEAN_FIXTURES,
    rules: TYPING_RULES,
  },
  // Sanctioned `unknown` boundaries: caught throwables (errors.ts,
  // error-response.ts) and the JSON-object validator (json-record-reader.ts)
  // take arbitrary runtime values that are immediately normalized/validated into
  // a concrete type (an Error via toError, or a JsonObject via asObject).
  // llm-protocol/types.ts's LlamaCppToolParameterSchema carries a
  // `[key: string]: unknown` index so a JSON-schema fragment can hold arbitrary
  // schema keywords while still exposing typed `.enum`/`.properties` accessors
  // and staying a structural supertype of JsonObject for dynamic construction.
  // better-sqlite3.d.ts is the third-party driver's type surface: bind params
  // are arbitrary JS values and .get()/.all() return unparsed rows that callers
  // immediately validate with a zod row schema, so `unknown` is the honest type.
  // `unknown` is the only honest input for these parse/fragment boundaries;
  // namespace-import and JsonValue-union bans stay in force here.
  {
    files: ['src/lib/errors.ts', 'src/lib/json-record-reader.ts', 'src/status-server/error-response.ts', 'src/llm-protocol/types.ts', 'src/types/better-sqlite3.d.ts', 'dashboard/src/ambient.d.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportNamespaceSpecifier',
          message: 'Namespace imports (import * as) are banned; use named imports.',
        },
        {
          selector: 'TSUnionType > TSTypeReference[typeName.name="JsonValue"]',
          message: 'Broad JsonValue unions are banned; parse boundary input into a schema-derived DTO.',
        },
      ],
    },
  },
);
