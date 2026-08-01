// Prefix-cache regression tests assert that volatile prompt inputs never shorten the
// shared head of two composed prompts below the systemContext block, which is what
// llama.cpp's cache_prompt reuses.
export function longestCommonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}
