import { memoryValidator } from "./store.mjs";
import { cachedMemoryTerms } from "./memory-term-cache.mjs";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const stop = new Set([
  "我", "你", "她", "他", "它", "我们", "你们", "他们", "这个", "那个", "这些", "那些", "一个", "一下",
  "的", "了", "是", "在", "有", "和", "也", "就", "都", "会", "吗", "呢", "吧", "啊", "着", "过", "还",
  "可以", "能", "不能", "已经", "没有", "不是", "什么", "怎么", "为什么", "如何", "是否", "记得", "知道", "之前",
  "please", "the", "a", "an", "is", "are", "i", "you", "my", "your", "to", "and", "of", "it", "do", "does", "remember"
]);
export function recallTerms(text) {
  const words = new Set();
  for (const part of segmenter.segment(String(text || "").normalize("NFKC").toLocaleLowerCase("en"))) {
    if (!part.isWordLike || stop.has(part.segment)) continue;
    const word = part.segment;
    if (/^[\p{L}\p{N}][\p{L}\p{N}'_-]*$/u.test(word)) words.add(word);
    if (/^[\p{Script=Han}]{3,}$/u.test(word)) {
      const characters = [...word];
      for (let i = 0; i < characters.length - 1; i++) {
        const gram = characters.slice(i, i + 2).join("");
        if (!stop.has(gram)) words.add(gram);
      }
    }
    if (words.size >= 512) break;
  }
  return words;
}

// Retrieval is entirely local. Invalid/denied memories never enter the index.
export function recallMemories(state, { query = "", limit = 30, budget = 12000, at = Date.now() } = {}) {
  const valid = memoryValidator(state, at);
  const eligible = state.memories.filter((m) => valid(m) && (m.allowModel ?? state.settings.allowModel));
  const queryTerms = recallTerms(query);
  const documents = eligible.map((memory) => ({ memory, terms: queryTerms.size ? cachedMemoryTerms(memory, recallTerms) : new Set() }));
  const frequencies = new Map();
  for (const term of queryTerms) frequencies.set(term, documents.reduce((n, d) => n + Number(d.terms.has(term)), 0));
  for (const document of documents) {
    let relevance = 0;
    for (const term of queryTerms) if (document.terms.has(term)) {
      const idf = Math.log(1 + (documents.length + 1) / ((frequencies.get(term) || 0) + 1));
      relevance += idf * (term.length > 1 ? 1 : .4);
    }
    document.relevance = relevance / Math.sqrt(1 + document.terms.size / 50);
  }
  documents.sort((a, b) => Number(b.relevance > 0) - Number(a.relevance > 0) ||
    b.relevance - a.relevance || Number(b.memory.confirmed) - Number(a.memory.confirmed) ||
    b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
  const selected = [];
  let remaining = budget;
  for (const doc of documents) {
    if (selected.length >= limit) break;
    if (doc.memory.content.length > remaining) continue;
    remaining -= doc.memory.content.length;
    selected.push({ memory: doc.memory, reason: doc.relevance > 0 ? "related" : doc.memory.confirmed ? "confirmed" : "recent" });
  }
  return selected;
}
