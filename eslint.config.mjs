import tseslint from 'typescript-eslint';

// Directories NOT YET cleaned. Each cleanup phase deletes its entries.
// When this array is empty, the gate is hard-fail repo-wide (P8).
const RATCHET_DIRTY = [
  'src/lib/**', 'src/config/**', // P1
  'src/state/**', // P2
  'src/status-server/**', // P3
  'src/llm-protocol/**', 'src/providers/**',
  'src/repo-search/**', 'src/summary/**', // P4
  'src/web-search/**', 'src/capture/**', 'src/cli/**',
  'src/command-output/**', 'src/agent-loop/**', 'src/types/**',
  'src/*.ts', // P5
  'dashboard/src/**', // P6
  'tests/**', 'dashboard/tests/**', 'bench/**',
  'scripts/**', 'eval/**', // P7
];

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
  {
    files: RATCHET_DIRTY,
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  // Gate fixtures must stay clean even while tests/** is ratcheted until P7.
  {
    files: CLEAN_FIXTURES,
    rules: TYPING_RULES,
  },
);
