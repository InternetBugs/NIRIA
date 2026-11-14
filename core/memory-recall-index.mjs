// Derived, process-local data only. Each companion's memory array owns its
// index; projections must still reconcile eligibility before using postings.
const indexes = new WeakMap();

export class MemoryRecallIndex {
  constructor(tokenize) {
    this.tokenize = tokenize;
    this.documents = new Map();
    this.postings = new Map();
  }
  remove(id) {
    const document = this.documents.get(id);
    if (!document) return;
    for (const term of document.terms) {
      const ids = this.postings.get(term);
      ids.delete(id);
      if (!ids.size) this.postings.delete(term);
    }
    this.documents.delete(id);
  }
  prune(memories) {
    const current = new Map(memories.map((memory) => [memory.id, memory.content]));
    for (const [id, document] of this.documents) {
      if (!current.has(id) || current.get(id) !== document.content) this.remove(id);
    }
  }
  update(memories) {
    this.prune(memories);
    for (const memory of memories) {
      if (this.documents.has(memory.id)) continue;
      const terms = this.tokenize(memory.content);
      this.documents.set(memory.id, { content: memory.content, terms });
      for (const term of terms) {
        if (!this.postings.has(term)) this.postings.set(term, new Set());
        this.postings.get(term).add(memory.id);
      }
    }
  }
  scores(queryTerms) {
    const scores = new Map();
    for (const term of queryTerms) {
      const ids = this.postings.get(term);
      if (!ids) continue;
      const weight = Math.log(1 + (this.documents.size + 1) / (ids.size + 1)) * (term.length > 1 ? 1 : .4);
      for (const id of ids) scores.set(id, (scores.get(id) || 0) + weight);
    }
    for (const [id, score] of scores) {
      scores.set(id, score / Math.sqrt(1 + this.documents.get(id).terms.size / 50));
    }
    return scores;
  }
  clear() {
    this.documents.clear();
    this.postings.clear();
  }
}

export function memoryRecallIndex(memories, eligible, tokenize) {
  let index = indexes.get(memories);
  if (!index) {
    index = new MemoryRecallIndex(tokenize);
    indexes.set(memories, index);
  }
  index.update(eligible);
  return index;
}

// Saving unrelated chat/call data keeps unchanged tokens. Drop changed,
// withdrawn or invalid documents immediately, and tokenize additions lazily.
export function pruneMemoryRecallIndex(memories, eligible, previousMemories) {
  if (previousMemories && previousMemories !== memories) clearMemoryRecallIndex(previousMemories);
  const index = indexes.get(memories);
  if (index) index.prune(eligible());
}

export function clearMemoryRecallIndex(memories) {
  indexes.get(memories)?.clear();
  indexes.delete(memories);
}
