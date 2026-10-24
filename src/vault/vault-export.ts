import type { VaultNote } from '@siftkit/contracts';

import { TempArchiveBuilder, type TempArchive } from '../assistant/control/temp-archive.ts';

/** Titles are unique and already exclude path characters, so `folder/title.md` never collides. */
export const vaultExportPath = (note: VaultNote): string => [note.folder, `${note.title}.md`].filter((part) => part.length > 0).join('/');

/** JSON lists are valid YAML, so frontmatter needs no YAML escaping rules of its own. */
export function toMarkdownFile(note: VaultNote): string {
  const frontmatter = [
    `kind: ${note.kind}`,
    `types: ${JSON.stringify(note.types)}`,
    `aliases: ${JSON.stringify(note.aliases)}`,
    `tags: ${JSON.stringify(note.tags)}`,
    `revision: ${note.revision}`,
    `updated: ${note.updatedAtUtc}`,
  ];
  return ['---', ...frontmatter, '---', '', note.body, ''].join('\n');
}

export function exportVault(notes: readonly VaultNote[]): TempArchive {
  const builder = new TempArchiveBuilder('siftkit-vault-export-');
  try {
    for (const note of notes) builder.writer.addBuffer(vaultExportPath(note), Buffer.from(toMarkdownFile(note), 'utf8'));
    return builder.finish();
  } catch (error) {
    builder.cleanup();
    throw error;
  }
}
