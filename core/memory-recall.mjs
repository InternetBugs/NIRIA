import { memoryValidator } from "./store.mjs";
import { memoryRecallIndex, pruneMemoryRecallIndex } from "./memory-recall-index.mjs";
import { permissionBlockedMemoryIds } from "./memory-provenance.mjs";

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

function compareDocuments(a, b) {
  return Number(b.relevance > 0) - Number(a.relevance > 0) ||
    b.relevance - a.relevance || Number(b.memory.confirmed) - Number(a.memory.confirmed) ||
    b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id) ||
    a.position - b.position;
}

// Heap construction is linear; only the next required candidates are ordered.
// Position preserves the old stable sort for distinct IDs that collate equally.
function selectDocuments(documents, limit, remaining) {
  const lengths = new Map();
  let shortest = Infinity;
  for (const { memory } of documents) {
    const length = memory.content.length;
    lengths.set(length, (lengths.get(length) || 0) + 1);
    shortest = Math.min(shortest, length);
  }
  const down = (root) => {
    const value = documents[root];
    while (root * 2 + 1 < documents.length) {
      let child = root * 2 + 1;
      if (child + 1 < documents.length && compareDocuments(documents[child + 1], documents[child]) < 0) child++;
      if (compareDocuments(value, documents[child]) <= 0) break;
      documents[root] = documents[child];
      root = child;
    }
    documents[root] = value;
  };
  for (let root = Math.floor(documents.length / 2) - 1; root >= 0; root--) down(root);
  const selected = [];
  while (documents.length && selected.length < limit && !(remaining < shortest)) {
    const document = documents[0], last = documents.pop();
    if (documents.length) { documents[0] = last; down(0); }
    const length = document.memory.content.length, count = lengths.get(length) - 1;
    if (count) lengths.set(length, count);
    else {
      lengths.delete(length);
      if (length === shortest) {
        shortest = Infinity;
        for (const candidate of lengths.keys()) shortest = Math.min(shortest, candidate);
      }
    }
    if (length > remaining) continue;
    remaining -= length;
    selected.push({ memory: document.memory, reason: document.relevance > 0 ? "related" : document.memory.confirmed ? "confirmed" : "recent" });
  }
  return selected;
}

// Retrieval is entirely local. Invalid/denied memories never enter the index.
export function recallMemories(state, { query = "", limit = 30, budget = 12000, at = Date.now() } = {}) {
  const valid = memoryValidator(state, at);
  const denied = permissionBlockedMemoryIds(state, "allowModel");
  const eligible = state.memories.filter((m) => valid(m) && !denied.has(m.id) && (m.allowModel ?? state.settings.allowModel));
  const queryTerms = recallTerms(query);
  let scores = new Map();
  if (queryTerms.size) scores = memoryRecallIndex(state.memories, eligible, recallTerms).scores(queryTerms);
  else pruneMemoryRecallIndex(state.memories, () => eligible);
  // Oversized valid memories still contribute to topic frequencies above.
  const documents = eligible.filter((memory) => !(memory.content.length > budget))
    .map((memory, position) => ({ memory, position, relevance: scores.get(memory.id) || 0 }));
  return selectDocuments(documents, limit, budget);
}
