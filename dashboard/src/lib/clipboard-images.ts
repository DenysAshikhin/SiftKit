/**
 * The structural slice of a clipboard payload this module needs. Typing the parameter
 * this way keeps the helper testable without constructing a real DataTransfer, which
 * jsdom does not provide.
 */
export type ClipboardImageSource = {
  items: ArrayLike<{ type: string; getAsFile(): File | null }>;
};

/**
 * Pulls pasted bitmaps out of a clipboard payload. Non-image entries are ignored so a
 * normal text paste keeps its default behaviour.
 */
export function extractClipboardImageFiles(clipboardData: ClipboardImageSource | null): File[] {
  if (!clipboardData) {
    return [];
  }
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (!item.type.startsWith('image/')) {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}