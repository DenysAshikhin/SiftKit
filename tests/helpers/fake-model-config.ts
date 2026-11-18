import fs from 'node:fs';
import path from 'node:path';

/** Writes a fake model's config.json with a small dense geometry, so default presets can auto-size their RAM tiers. */
export function writeFakeModelConfig(modelPath: string): void {
  fs.writeFileSync(path.join(modelPath, 'config.json'), JSON.stringify({
    architectures: ['FakeForCausalLM'], num_hidden_layers: 2, num_attention_heads: 4, num_key_value_heads: 2, hidden_size: 256,
  }), 'utf8');
}
