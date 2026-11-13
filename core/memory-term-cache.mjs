let cache = new WeakMap();
export function cachedMemoryTerms(memory, tokenize) {
  const previous = cache.get(memory);
  if (previous?.content === memory.content) return previous.terms;
  const terms = tokenize(memory.content);
  cache.set(memory, { content: memory.content, terms });
  return terms;
}
export function clearMemoryTermCache() {
  // Release old text and tokens after any persisted edit, deletion or withdrawal.
  cache = new WeakMap();
}
