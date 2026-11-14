import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CompanionStore, defaults, memoryValidator, messageHash } from "../core/store.mjs";
import { recallMemories, recallTerms } from "../core/memory-recall.mjs";
import { MemoryRecallIndex, memoryRecallIndex } from "../core/memory-recall-index.mjs";
import { CompanionService, buildContext, previewContext } from "../core/chat-service.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { davFixture } from "./fixtures/dav.mjs";

function fixture(t) {
  const store = new CompanionStore();
  t.after(() => store.close());
  store.settings({ autoMemory: false });
  return store;
}
function eligible(state, at = Date.now()) {
  const valid = memoryValidator(state, at);
  return state.memories.filter((memory) => valid(memory) && (memory.allowModel ?? state.settings.allowModel));
}
function trackedIndex(store) {
  let tokenizations = 0;
  const index = memoryRecallIndex(store.state.memories, eligible(store.state), (text) => {
    tokenizations++;
    return recallTerms(text);
  });
  return { index, count: () => tokenizations };
}
function scanRecall(state, { query = "", at = Date.now(), limit = 30, budget = 12000 } = {}) {
  const queryTerms = recallTerms(query);
  const documents = eligible(state, at).map((memory) => ({ memory, terms: queryTerms.size ? recallTerms(memory.content) : new Set() }));
  const frequencies = new Map([...queryTerms].map((term) => [term, documents.filter((document) => document.terms.has(term)).length]));
  for (const document of documents) {
    let score = 0;
    for (const term of queryTerms) if (document.terms.has(term)) {
      score += Math.log(1 + (documents.length + 1) / (frequencies.get(term) + 1)) * (term.length > 1 ? 1 : .4);
    }
    document.score = score / Math.sqrt(1 + document.terms.size / 50);
  }
  documents.sort((a, b) => Number(b.score > 0) - Number(a.score > 0) || b.score - a.score ||
    Number(b.memory.confirmed) - Number(a.memory.confirmed) ||
    b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
  const selected = [];
  for (const { memory, score } of documents) {
    if (selected.length >= limit) break;
    if (memory.content.length > budget) continue;
    budget -= memory.content.length;
    selected.push({ memory, reason: score > 0 ? "related" : memory.confirmed ? "confirmed" : "recent" });
  }
  return selected;
}

test("postings reproduce scan ordering, reasons and character budgets across mixed local queries", () => {
  const state = defaults();
  const contents = ["栗子的生日在三月十四日。", "用户喜欢乌龙茶与红茶。", "Mika lives in Taipei.", "散步与公园。",
    "Ｍｉｋａ 喜欢桂花乌龙茶。", "生日礼物是一杯茶。", "x y z", "123 456", "🙂"];
  for (let i = 0; i < 180; i++) state.memories.push({
    id: `memory-${i}`, content: `${contents[i % contents.length]} ${i % 7}`,
    kind: "fact", sources: [], expiresAt: i % 17 === 0 ? "2000-01-01T00:00:00Z" : null,
    confirmed: i % 3 !== 0, allowModel: i % 11 === 0 ? false : null,
    deleted: i % 13 === 0, invalidated: i % 19 === 0, conflicted: i % 23 === 0,
    revision: 1, createdAt: "2020-01-01T00:00:00Z", updatedAt: `2020-01-${String(i % 28 + 1).padStart(2, "0")}T00:00:00Z`
  });
  for (const query of ["栗子生日", "乌龙茶", "ＭＩＫＡ Taipei", "公园 红茶", "x", "123", "🙂", "", "没有匹配的遥远星系"]) {
    for (const budget of [0, 30, 12000]) {
      const options = { query, budget, limit: 15 };
      assert.deepEqual(recallMemories(state, options), scanRecall(state, options), JSON.stringify(options));
    }
  }
});

test("large candidate sets preserve complete-sort selection at page limits and changing budgets", () => {
  const state = defaults(), at = "2020-01-01T00:00:00Z";
  for (let index = 0; index < 2048; index++) state.memories.push({
    id: `memory-${(Math.imul(index, 2654435761) >>> 0).toString(16).padStart(8, "0")}`,
    content: index % 31 === 0 ? "" : `${index % 3 ? "乌龙茶与周末散步。" : "读书。"}${"🙂".repeat(index % 8)}`,
    kind: "experience", sources: [], expiresAt: null, confirmed: index % 4 !== 0,
    allowModel: index % 17 === 0 ? false : null, allowSync: null,
    deleted: index % 19 === 0, invalidated: index % 23 === 0,
    revision: 1, createdAt: at, updatedAt: `2020-01-${String(index % 28 + 1).padStart(2, "0")}T00:00:00Z`
  });
  for (const query of ["", "乌龙茶", "从未出现的星球"]) for (const limit of [1, 2, 30, 2049]) {
    for (const budget of [0, 19, 40, 12000]) {
      const options = { query, limit, budget };
      assert.deepEqual(recallMemories(state, options), scanRecall(state, options), JSON.stringify(options));
    }
  }
});

test("equal collation keeps original order and empty restored text does not exhaust a partial budget", () => {
  const state = defaults(), at = "2020-01-01T00:00:00Z";
  const add = (id, content) => state.memories.push({
    id, content, kind: "fact", sources: [], expiresAt: null, confirmed: true,
    allowModel: null, allowSync: null, deleted: false, invalidated: false,
    revision: 1, createdAt: at, updatedAt: at
  });
  for (const id of ["é", "e\u0301", "b", "b\u00ad", "a", "a\u00ad", "c", "c\u00ad"]) add(id, "资料");
  for (const limit of [1, 3, 8]) assert.deepEqual(recallMemories(state, { limit }), scanRecall(state, { limit }));
  state.memories = [];
  for (const [id, content] of [["00-large", "x".repeat(2000)], ["01-empty", ""], ["02-three", "abc"],
    ["03-one", "d"], ["04-two", "ef"]]) add(id, content);
  assert.deepEqual(recallMemories(state, { budget: 4 }).map(({ memory }) => memory.id), ["01-empty", "02-three", "03-one"]);
  assert.deepEqual(recallMemories(state, { budget: 0 }).map(({ memory }) => memory.id), ["01-empty"]);
  assert.deepEqual(recallMemories(state, { budget: 1 }).map(({ memory }) => memory.id), ["01-empty", "03-one"]);
});

test("index retains unchanged tokens and removes replaced or withdrawn postings", () => {
  let calls = 0;
  const index = new MemoryRecallIndex((text) => { calls++; return recallTerms(text); });
  const first = { id: "first", content: "栗子生日" }, second = { id: "second", content: "冬青散步" };
  index.update([first, second]);
  index.update([structuredClone(first), { ...second, confirmed: true }]);
  assert.equal(calls, 2);
  index.update([{ ...first, content: "红茶" }, second]);
  assert.equal(calls, 3);
  assert.equal(index.postings.has("栗子"), false);
  assert.ok(index.scores(recallTerms("红茶")).has("first"));
  index.update([second]);
  assert.equal(index.postings.has("红茶"), false);
  assert.deepEqual([...index.documents.keys()], ["second"]);
  index.clear();
  assert.equal(index.documents.size, 0);
  assert.equal(index.postings.size, 0);
});

test("saving chat, call logs or metadata keeps the warm index and tokenizes only added or edited text", (t) => {
  const store = fixture(t);
  const id = store.addMemory({ content: "栗子喜欢阳光。" });
  const tracking = trackedIndex(store);
  const query = () => recallMemories(store.state, { query: "栗子" });
  query();
  store.addUser("今天过得怎么样？");
  store.mutate((state) => { state.usage.test = { memory: 1 }; });
  store.editMemory(id, { confirmed: false, kind: "experience" });
  query();
  assert.equal(tracking.count(), 1);
  const next = store.addMemory({ content: "冬青喜欢散步。" });
  assert.equal(tracking.count(), 1, "saving does not tokenize additions");
  query();
  assert.equal(tracking.count(), 2);
  store.editMemory(next, { content: "冬青喜欢红茶。" });
  assert.equal(tracking.index.postings.has("散步"), false, "old tokens disappear at save, before another query");
  query();
  assert.equal(tracking.count(), 3);
});

test("permissions, deletion, expiry and missing sources remove documents before reuse", (t) => {
  const store = fixture(t);
  const source = store.addUser("来源：栗子的生日");
  const sourced = store.addMemory({ content: "栗子生日", sources: [{ id: source.id, revision: 1 }] });
  const manual = store.addMemory({ content: "冬青散步" });
  const tracking = trackedIndex(store);
  store.editMemory(manual, { allowModel: false });
  assert.equal(tracking.index.documents.has(manual), false);
  assert.equal(tracking.index.postings.has("冬青"), false);
  store.editMemory(manual, { allowModel: true });
  recallMemories(store.state, { query: "冬青" });
  assert.equal(tracking.count(), 3);
  store.mutate((state) => { state.messages.find((message) => message.id === source.id).content = "同修订不同正文"; });
  assert.equal(tracking.index.documents.has(sourced), false);
  assert.equal(tracking.index.postings.has("栗子"), false);
  store.mutate((state) => { state.memories.find((memory) => memory.id === manual).expiresAt = "2030-01-01T00:00:00Z"; });
  assert.equal(recallMemories(store.state, { query: "冬青", at: Date.parse("2031-01-01") }).length, 0);
  assert.equal(tracking.index.documents.size, 0);
  assert.equal(tracking.index.postings.size, 0);
  // A clock correction must re-evaluate expiry rather than permanently hiding it.
  assert.equal(recallMemories(store.state, { query: "冬青", at: Date.parse("2029-01-01") })[0].memory.id, manual);
  store.deleteMemory(manual);
  assert.equal(tracking.index.documents.size, 0);
});

test("default model permission changes retain only explicit opt-ins and do not affect other companions", (t) => {
  const first = new CompanionStore(), second = fixture(t);
  let firstClosed = false;
  t.after(() => { if (!firstClosed) first.close(); });
  first.addMemory({ content: "栗子默认资料" });
  const override = first.addMemory({ content: "冬青独立允许" });
  first.editMemory(override, { allowModel: true });
  second.addMemory({ content: "另一位伴侣的资料" });
  const a = trackedIndex(first), b = trackedIndex(second);
  first.settings({ allowModel: false });
  assert.deepEqual([...a.index.documents.keys()], [override]);
  assert.equal(recallMemories(first.state, { query: "资料" }).length, 1);
  first.close();
  firstClosed = true;
  assert.equal(a.index.documents.size, 0);
  assert.equal(b.index.documents.size, 1);
  recallMemories(second.state, { query: "资料" });
  assert.equal(b.count(), 1);
});

test("a replacement that fails before save releases the previous array's index as well", (t) => {
  const store = fixture(t);
  const id = store.addMemory({ content: "原伴侣栗子" });
  const tracking = trackedIndex(store);
  assert.throws(() => store.mutate(() => {
    store.state = defaults();
    throw new Error("replacement setup failure");
  }), /replacement setup failure/);
  assert.equal(tracking.index.documents.size, 0);
  assert.equal(tracking.index.postings.size, 0);
  assert.equal(recallMemories(store.state, { query: "栗子" })[0].memory.id, id);
});

test("correction and explicit forgetting purge related entries without reviving old terms from a backup", async (t) => {
  const store = fixture(t);
  const source = store.addUser("我喜欢乌龙茶");
  const sources = [{ id: source.id, revision: 1, hash: messageHash(source) }];
  const corrected = store.addMemory({ content: "喜欢乌龙茶", sources });
  const sibling = store.addMemory({ content: "乌龙茶旧衍生", sources });
  const backup = await encryptBackup(store.exportData(), "isolated-recall-backup");
  const tracking = trackedIndex(store);
  store.editMemory(corrected, { content: "喜欢红茶" });
  assert.equal(tracking.index.documents.has(sibling), false);
  assert.equal(tracking.index.postings.has("乌龙"), false);
  assert.equal(recallMemories(store.state, { query: "红茶" })[0].memory.id, corrected);
  store.deleteMemory(corrected, true);
  assert.equal(tracking.index.documents.size, 0);
  store.restore(await decryptBackup(backup, "isolated-recall-backup"));
  assert.equal(recallMemories(store.state, { query: "乌龙茶 红茶" }).length, 0);
  assert.equal(JSON.stringify(buildContext(store.state)).includes("乌龙茶"), false);
});

test("failed storage writes and late listener failures discard staged postings and recover original recall", (t) => {
  const store = fixture(t);
  const id = store.addMemory({ content: "原资料：栗子" });
  let tracking = trackedIndex(store);
  store.db.exec("CREATE TEMP TRIGGER reject_recall_update BEFORE UPDATE ON main.memory_records BEGIN SELECT RAISE(ABORT,'isolated failure'); END");
  assert.throws(() => store.editMemory(id, { content: "不能保存的红茶" }), /isolated failure/);
  assert.equal(tracking.index.documents.size, 0);
  assert.equal(recallMemories(store.state, { query: "栗子" })[0].reason, "related");
  store.db.exec("DROP TRIGGER reject_recall_update");
  tracking = trackedIndex(store);
  const fail = () => {
    recallMemories(store.state, { query: "未提交的冬青" });
    throw new Error("late listener failure");
  };
  store.listeners.add(fail);
  assert.throws(() => store.editMemory(id, { content: "未提交的冬青" }), /late listener failure/);
  store.listeners.delete(fail);
  assert.equal(tracking.index.documents.size, 0);
  assert.equal(recallMemories(store.state, { query: "冬青" })[0].reason, "confirmed");
  assert.equal(recallMemories(store.state, { query: "栗子" })[0].reason, "related");
  assert.equal(JSON.parse(store.db.prepare("SELECT data FROM memory_records WHERE id=?").get(id).data).content, "原资料：栗子");
});

test("replacing a companion snapshot clears the old array's index and rebuilds only from the restored state", (t) => {
  const store = fixture(t);
  store.addMemory({ content: "当前伴侣的栗子" });
  const tracking = trackedIndex(store), previous = store.state.memories;
  const next = defaults();
  next.memories.push({ ...store.state.memories[0], content: "恢复伴侣的冬青" });
  store.restore(next);
  assert.notEqual(store.state.memories, previous);
  assert.equal(tracking.index.documents.size, 0);
  assert.equal(tracking.index.postings.size, 0);
  assert.equal(recallMemories(store.state, { query: "栗子" })[0].reason, "confirmed");
  assert.equal(recallMemories(store.state, { query: "冬青" })[0].reason, "related");
  assert.equal(Object.hasOwn(store.exportData(), "recallIndex"), false);
});

test("draft previews, real chat and a regenerated projection use the same live eligibility and ordering", async (t) => {
  const store = fixture(t);
  const old = store.addMemory({ content: "栗子生日在三月。" });
  store.addMemory({ content: "冬青喜欢散步。" });
  trackedIndex(store);
  const draft = "栗子的生日是哪天？";
  const preview = previewContext(store.state, draft);
  const calls = [];
  const service = new CompanionService(store, { completion: async (_, messages) => { calls.push(messages); return "三月呀。"; } });
  service.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "isolated-recall" });
  await service.send({ content: draft });
  assert.deepEqual(store.state.messages.at(-1).context.memoryRefs.map((ref) => ref.id), preview.refs.memoryRefs.map((ref) => ref.id));
  const reply = store.state.messages.at(-1);
  const derived = store.addMemory({ content: "栗子回复中的衍生资料", sources: [{ id: reply.id, revision: reply.revision }] });
  recallMemories(store.state, { query: "栗子" });
  await service.send({ retryId: store.state.messages.find((message) => message.role === "user").id });
  assert.ok(store.state.messages.at(-1).context.memoryRefs.some((ref) => ref.id === old));
  assert.equal(store.state.messages.at(-1).context.memoryRefs.some((ref) => ref.id === derived), false);
  assert.equal(calls.length, 2);
});

test("remote changes, conflicts, permission withdrawal and deletion reconcile warm indexes through HTTP WebDAV", async (t) => {
  const dav = await davFixture();
  t.after(() => dav.close());
  const a = fixture(t), b = fixture(t), sa = new SyncService(a), sb = new SyncService(b);
  t.after(() => { sa.lock(); sb.lock(); });
  sa.configure({ baseUrl: dav.baseUrl, auto: false });
  sb.configure({ baseUrl: dav.baseUrl, auto: false });
  const id = a.addMemory({ content: "栗子喜欢乌龙茶" });
  const { code } = sa.createPair();
  await sa.sync();
  await sb.join(code);
  const tracking = trackedIndex(b);
  a.editMemory(id, { content: "栗子喜欢红茶" });
  await sa.sync();
  await sb.sync();
  assert.equal(tracking.index.documents.size, 0, "replaced snapshot releases its previous postings");
  assert.equal(recallMemories(b.state, { query: "红茶" })[0].reason, "related");
  assert.equal(recallMemories(b.state, { query: "乌龙茶" })[0].reason, "confirmed");
  a.editMemory(id, { content: "栗子喜欢绿茶" });
  b.editMemory(id, { content: "栗子喜欢桂花茶" });
  await sa.sync();
  await sb.sync();
  assert.equal(recallMemories(b.state, { query: "栗子" }).length, 0);
  const conflict = b.state.conflicts.find((item) => item.id === id);
  const selected = conflict.candidates.find((candidate) => candidate.value?.content === "栗子喜欢桂花茶");
  sb.resolve(conflict.key, selected.id);
  await sb.sync();
  await sa.sync();
  assert.equal(recallMemories(a.state, { query: "桂花茶" })[0].reason, "related");
  a.editMemory(id, { allowModel: false });
  await sa.sync();
  await sb.sync();
  assert.equal(recallMemories(b.state, { query: "栗子" }).length, 0);
  a.deleteMemory(id);
  await sa.sync();
  await sb.sync();
  assert.equal(recallMemories(b.state, { query: "栗子" }).length, 0);
  assert.equal(JSON.stringify(sb.meta).includes('"postings"'), false);
});

test("outer sync transaction failure discards the staged array's postings", (t) => {
  const store = fixture(t), sync = new SyncService(store);
  store.addMemory({ content: "已保存的栗子" });
  const tracking = trackedIndex(store);
  const next = store.snapshot(), meta = structuredClone(sync.meta);
  next.memories[0].content = "未提交的冬青";
  meta.lastSuccess = new Date().toISOString();
  let staged;
  store.listeners.add(() => {
    recallMemories(store.state, { query: "冬青" });
    staged = memoryRecallIndex(store.state.memories, eligible(store.state), recallTerms);
  });
  store.db.exec("CREATE TEMP TRIGGER reject_recall_sync BEFORE UPDATE ON main.sync_meta BEGIN SELECT RAISE(ABORT,'isolated recall sync failure'); END");
  assert.throws(() => sync.commit(next, meta), /isolated recall sync failure/);
  assert.equal(staged.documents.size, 0);
  assert.equal(tracking.index.documents.size, 0);
  assert.equal(store.recallMemoryArray, store.state.memories);
  assert.equal(recallMemories(store.state, { query: "冬青" })[0].reason, "confirmed");
  assert.equal(recallMemories(store.state, { query: "栗子" })[0].reason, "related");
});

test("process-local terms stay out of SQLite, backup and restart state", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "niria-recall-index-"));
  t.after(() => {
    const target = resolve(folder), root = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(root));
    rmSync(target, { recursive: true, force: true });
  });
  const filename = join(folder, "companion.sqlite");
  let store = new CompanionStore(filename);
  try {
    const id = store.addMemory({ content: "栗子生日" });
    const tracking = trackedIndex(store);
    assert.equal(recallMemories(store.state, { query: "栗子" })[0].memory.id, id);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%recall%' OR name LIKE '%posting%'").all().length, 0);
    const exported = store.exportData();
    assert.deepEqual(Object.keys(exported), Object.keys(defaults()));
    const backup = await decryptBackup(await encryptBackup(exported, "isolated-recall-restart"), "isolated-recall-restart");
    assert.deepEqual(backup, exported);
    store.close();
    assert.equal(tracking.index.postings.size, 0);
    store = new CompanionStore(filename);
    assert.equal(recallMemories(store.state, { query: "栗子" })[0].memory.id, id);
  } finally { store.close(); }
});
