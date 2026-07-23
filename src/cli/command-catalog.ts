export type CliCommandDefinition = {
  name: string;
  exposed: boolean;
  serverDependent: boolean;
  modelLock: boolean;
};

export type CliCommandInvocation = {
  command: CliCommandDefinition;
  args: string[];
};

const CLI_COMMAND_DEFINITIONS: CliCommandDefinition[] = [
  { name: 'summary', exposed: true, serverDependent: true, modelLock: true },
  { name: 'repo-search', exposed: true, serverDependent: true, modelLock: true },
  { name: 'repo-agent', exposed: true, serverDependent: true, modelLock: true },
  { name: 'preset', exposed: true, serverDependent: true, modelLock: false },
  { name: 'run', exposed: true, serverDependent: false, modelLock: true },
  { name: 'find-files', exposed: true, serverDependent: false, modelLock: false },
  { name: 'internal', exposed: true, serverDependent: false, modelLock: false },
  { name: 'install', exposed: false, serverDependent: true, modelLock: false },
  { name: 'test', exposed: false, serverDependent: true, modelLock: false },
  { name: 'eval', exposed: false, serverDependent: true, modelLock: true },
  { name: 'codex-policy', exposed: false, serverDependent: false, modelLock: false },
  { name: 'install-global', exposed: false, serverDependent: false, modelLock: false },
  { name: 'config-get', exposed: false, serverDependent: true, modelLock: false },
  { name: 'config-set', exposed: false, serverDependent: true, modelLock: false },
  { name: 'capture-internal', exposed: false, serverDependent: true, modelLock: false },
];

export class CliCommandCatalog {
  private readonly definitionsByName = new Map<string, CliCommandDefinition>();
  private readonly summaryDefinition: CliCommandDefinition;
  private readonly repoSearchDefinition: CliCommandDefinition;

  constructor(definitions: readonly CliCommandDefinition[]) {
    for (const definition of definitions) {
      this.definitionsByName.set(definition.name, definition);
    }
    const summaryDefinition = this.definitionsByName.get('summary');
    if (!summaryDefinition) {
      throw new Error('CLI command catalog requires summary.');
    }
    const repoSearchDefinition = this.definitionsByName.get('repo-search');
    if (!repoSearchDefinition) {
      throw new Error('CLI command catalog requires repo-search.');
    }
    this.summaryDefinition = summaryDefinition;
    this.repoSearchDefinition = repoSearchDefinition;
  }

  resolve(argv: string[]): CliCommandInvocation {
    const firstToken = argv[0];
    if (firstToken === '--prompt' || firstToken === '-prompt') {
      return { command: this.repoSearchDefinition, args: argv };
    }
    if (firstToken !== undefined) {
      const explicitDefinition = this.definitionsByName.get(firstToken);
      if (explicitDefinition) {
        return { command: explicitDefinition, args: argv.slice(1) };
      }
    }
    return { command: this.summaryDefinition, args: argv };
  }
}

export const CLI_COMMAND_CATALOG = new CliCommandCatalog(CLI_COMMAND_DEFINITIONS);
