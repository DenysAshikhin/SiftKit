import { StatusServerApiClient } from './status-server-api-client.js';

export async function runPresetList(options: {
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const result = await new StatusServerApiClient().listPresets();
  for (const preset of result.presets) {
    options.stdout.write(
      `${preset.id}\t${preset.presetKind}\t${preset.operationMode}\t${preset.deletable ? 'custom' : 'builtin'}\t${preset.label}\n`,
    );
  }
  return 0;
}
