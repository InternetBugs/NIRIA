import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CompanionStore, defaults, memoryValidator, messageHash } from "../core/store.mjs";
import { recallMemories, recallTerms } from "../core/memory-recall.mjs";
import { memoryRecallIndex, pruneMemoryRecallIndex } from "../core/memory-recall-index.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const folder = join(root, "artifacts", `recall-benchmark-${Date.now()}`);
await mkdir(folder, { recursive: true });
const state = defaults(), at = new Date().toISOString();
state.settings.autoMemory = false;
for (let i = 0; i < 20000; i++) state.messages.push({
  id: randomUUID(), role: "user", content: `隔离召回测试消息 ${i}，今天一起聊了日常生活。`,
  revision: 1, status: "completed", deleted: false, createdAt: at, updatedAt: at
});
const topics = ["下午的公园散步", "周末的桂花乌龙茶", "窗边听雨读书", "旅行时的海边风景", "周五做饭和音乐"];
for (let i = 0; i < 4000; i++) {
  const source = state.messages[i * 5];
  state.memories.push({
    id: randomUUID(), content: i === 0 ? "用户的猫栗子生日在三月十四日。" : `共同经历 ${i}：用户喜欢${topics[i % topics.length]}。`,
    kind: "experience", sources: [{ id: source.id, revision: 1, hash: messageHash(source) }],
    expiresAt: null, confirmed: true, allowModel: null, allowSync: null,
    deleted: false, invalidated: false, revision: 1, createdAt: at, updatedAt: at
  });
}
let previousTerms = new WeakMap(), previousTokenizations = 0, indexedTokenizations = 0;
// Preserve the previous implementation, including its warm per-memory cache,
// for an equivalent selection comparison. Real saves used to clear this cache.
function scanRecall(state, query) {
  const valid = memoryValidator(state), queryTerms = recallTerms(query);
  const documents = state.memories.filter((memory) => valid(memory) && (memory.allowModel ?? state.settings.allowModel)).map((memory) => {
    let terms = previousTerms.get(memory);
    if (!terms) {
      previousTokenizations++;
      terms = recallTerms(memory.content);
      previousTerms.set(memory, terms);
    }
    return { memory, terms, score: 0 };
  });
  const frequencies = new Map();
  for (const term of queryTerms) frequencies.set(term, documents.reduce((count, document) => count + Number(document.terms.has(term)), 0));
  for (const document of documents) {
    for (const term of queryTerms) if (document.terms.has(term)) {
      document.score += Math.log(1 + (documents.length + 1) / (frequencies.get(term) + 1)) * (term.length > 1 ? 1 : .4);
    }
    document.score /= Math.sqrt(1 + document.terms.size / 50);
  }
  documents.sort((a, b) => Number(b.score > 0) - Number(a.score > 0) || b.score - a.score ||
    Number(b.memory.confirmed) - Number(a.memory.confirmed) ||
    b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
  const selected = [];
  let budget = 12000;
  for (const { memory, score } of documents) {
    if (selected.length >= 30) break;
    if (memory.content.length > budget) continue;
    budget -= memory.content.length;
    selected.push({ id: memory.id, reason: score > 0 ? "related" : memory.confirmed ? "confirmed" : "recent" });
  }
  return selected;
}
// Preserve 0.29's indexed complete sort, so ranking changes can be compared
// without attributing the earlier tokenizer/index improvement to this version.
function indexedSortRecall(state, query) {
  const valid = memoryValidator(state), terms = recallTerms(query);
  const eligible = state.memories.filter((memory) => valid(memory) && (memory.allowModel ?? state.settings.allowModel));
  let scores = new Map();
  if (terms.size) scores = memoryRecallIndex(state.memories, eligible, recallTerms).scores(terms);
  else pruneMemoryRecallIndex(state.memories, () => eligible);
  const documents = eligible.map((memory) => ({ memory, relevance: scores.get(memory.id) || 0 }));
  documents.sort((a, b) => Number(b.relevance > 0) - Number(a.relevance > 0) ||
    b.relevance - a.relevance || Number(b.memory.confirmed) - Number(a.memory.confirmed) ||
    b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
  const selected = [];
  let remaining = 12000;
  for (const { memory, relevance } of documents) {
    if (selected.length >= 30) break;
    if (memory.content.length > remaining) continue;
    remaining -= memory.content.length;
    selected.push({ id: memory.id, reason: relevance > 0 ? "related" : memory.confirmed ? "confirmed" : "recent" });
  }
  return selected;
}
const queries = [
  "",
  "栗子的生日是哪一天？",
  "还记得我们在周末下午喝桂花乌龙茶、去公园散步、听雨读书，聊旅行海边风景和做饭音乐吗？",
  "周五做饭音乐",
  "没有出现过的星座话题"
];
const measure = (run) => {
  const start = performance.now(), value = run();
  return { ms: performance.now() - start, value };
};
const round = (value) => Math.round(value * 100) / 100;
const store = new CompanionStore(join(folder, "companion.sqlite"));
try {
  store.restore(state);
  const index = memoryRecallIndex(store.state.memories, [], (text) => { indexedTokenizations++; return recallTerms(text); });
  let warmSample = 0;
  const compare = (query, alternate = false) => {
    const previous = measure(() => scanRecall(store.state, query));
    let indexed, indexedSort;
    const runs = [
      () => { indexed = measure(() => recallMemories(store.state, { query }).map(({ memory, reason }) => ({ id: memory.id, reason }))); },
      () => { indexedSort = measure(() => indexedSortRecall(store.state, query)); }
    ];
    if (alternate && warmSample++ % 2) runs.reverse();
    for (const run of runs) run();
    assert.deepEqual(indexed.value, previous.value);
    assert.deepEqual(indexed.value, indexedSort.value);
    return { queryTerms: recallTerms(query).size, previousMs: round(previous.ms),
      indexedSortMs: round(indexedSort.ms), indexedMs: round(indexed.ms) };
  };
  const cold = compare(queries[1]);
  const warm = [];
  for (let i = 0; i < 5; i++) for (const query of queries) warm.push(compare(query, true));
  const beforeAppend = indexedTokenizations;
  store.addUser("隔离测试追加：今天过得怎么样？");
  previousTerms = new WeakMap();
  const afterChatAppend = compare(queries[2]);
  assert.equal(indexedTokenizations, beforeAppend, "unrelated chat must retain tokenized memories");
  store.editMemory(store.state.memories[0].id, { content: "用户的猫冬青生日在五月十日。" });
  previousTerms = new WeakMap();
  const afterCorrection = compare("冬青生日");
  assert.equal(indexedTokenizations, beforeAppend + 1, "a correction must tokenize just its new text");
  assert.equal(index.postings.has("栗子"), false);
  const result = {
    syntheticData: true, messages: state.messages.length, memories: state.memories.length,
    selectionsMatchPreviousScan: true, selectionsMatchIndexedSort: true,
    baseline: "Indexed complete sort from 0.29.0; tokenizer scan retained as a separate historical comparison",
    cold, warm, afterChatAppend, afterCorrection,
    tokenizations: { previous: previousTokenizations, indexed: indexedTokenizations, indexedAfterUnrelatedAppend: 0, indexedAfterOneCorrection: 1 },
    indexedDocuments: index.documents.size, terms: index.postings.size,
    limitations: "One local synthetic run, timings are diagnostic. Warm samples alternate algorithm order; cold/change diagnostics run production first, so cold timings are not comparable. Eligibility still inspects all memories, ranking may inspect many candidates when budgets skip items, and state/sync graphs still load and compare in full. No semantic embeddings or external services."
  };
  await writeFile(join(folder, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, evidence: join(folder, "result.json") }, null, 2));
} finally { store.close(); }
