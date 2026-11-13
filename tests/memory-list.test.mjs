import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService, buildContext } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { davFixture } from "./fixtures/dav.mjs";

const status = (code) => (error) => error.status === code;
const ids = (page) => page.memories.map((memory) => memory.id);
function fixture(t, count = 247, filename) {
  const store = new CompanionStore(filename); t.after(() => store.close());
  const at = new Date().toISOString();
  store.mutate((state) => {
    state.memories = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(), content: `第 ${index} 件记忆`, kind: ["fact", "experience", "inference"][index % 3], sources: [],
      expiresAt: null, confirmed: index % 2 === 0, allowModel: null, allowSync: null, deleted: false, invalidated: false,
      revision: 1, createdAt: at, updatedAt: at
    }));
  });
  return store;
}

test("memory SQL pages traverse every record in both directions without duplicate or omitted rows", (t) => {
  const store = fixture(t), expected = store.state.memories.map((memory) => memory.id).reverse();
  const before = store.snapshot(), writes = store.db.prepare("SELECT total_changes() AS n").get().n;
  let page = store.memories.page(), actual = ids(page);
  assert.equal(page.memories.length, 60); assert.equal(page.totalMatches, 247); assert.equal(page.newerCursor, null);
  while (page.olderCursor) { page = store.memories.page({ cursor: page.olderCursor }); actual.push(...ids(page)); }
  assert.deepEqual(actual, expected);
  actual = ids(page);
  while (page.newerCursor) { page = store.memories.page({ cursor: page.newerCursor }); actual = [...ids(page), ...actual]; }
  assert.deepEqual(actual, expected);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, writes);
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM memory_records WHERE deleted=0 ORDER BY position DESC LIMIT 60").all();
  assert.ok(plan.some((row) => row.detail.includes("memories_browse")));
});

test("literal memory search combines kind and live state without SQL wildcard or quote interpretation", (t) => {
  const store = fixture(t);
  store.mutate((state) => {
    state.memories[0].content = `乌龙茶 Tea 100%_'" OR 1=1 --`;
    state.memories[1].content = "tea 喝茶";
  });
  for (const query of ["乌龙茶", "100%_", `'" OR 1=1 --`, "%", "_"]) {
    assert.deepEqual(ids(store.memories.page({ query })), [store.state.memories[0].id]);
  }
  assert.equal(store.memories.page({ query: "  tEa  " }).totalMatches, 2);
  assert.deepEqual(ids(store.memories.page({ query: "tea", status: "confirmed", kind: "fact" })), [store.state.memories[0].id]);
  assert.deepEqual(ids(store.memories.page({ query: "tea", status: "pending", kind: "experience" })), [store.state.memories[1].id]);
  assert.equal(store.memories.page({ query: "不存在的文字" }).totalMatches, 0);
  assert.equal(store.state.calls.length, 0);
});

test("inactive filters use actual provenance, conflict, expiry and corrections rather than confirmation alone", (t) => {
  const store = fixture(t, 1), source = store.addUser("有来源的旧资料");
  const derived = store.addMemory({ content: "有效的待确认资料", sources: [{ id: source.id, revision: 1 }] }, { automatic: true });
  assert.ok(ids(store.memories.page({ status: "pending" })).includes(derived));
  store.mutate((state) => { state.messages.find((message) => message.id === source.id).content = "同修订不同正文"; });
  assert.equal(store.state.memories.find((memory) => memory.id === derived).invalidated, false);
  assert.ok(ids(store.memories.page({ status: "inactive" })).includes(derived));
  for (const field of ["invalidated", "conflicted", "expired"]) {
    const id = store.addMemory({ content: `状态 ${field}` });
    store.mutate((state) => {
      const memory = state.memories.find((item) => item.id === id);
      if (field === "expired") memory.expiresAt = "2000-01-01T00:00:00Z"; else memory[field] = true;
    });
    assert.ok(ids(store.memories.page({ status: "inactive" })).includes(id));
  }
  const summary = store.memories.summary();
  assert.equal(summary.counts.inactive, 4);
  assert.equal(summary.total, 5);
  assert.equal(store.memories.page({ status: "confirmed" }).totalMatches, 1);
});

test("memory cursors bind all filters, identity, revisions and the memory endpoint", (t) => {
  const store = fixture(t), cursor = store.memories.page({ limit: 5 }).olderCursor;
  for (const options of [{ query: "记忆", cursor }, { kind: "fact", cursor }, { status: "pending", cursor },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { query: "长".repeat(201) }, { status: "unknown" }, { kind: "unknown" },
    { cursor: "not-json" }, { cursor, anchor: store.state.memories[0].id }, { anchor: "x".repeat(101) }]) {
    assert.throws(() => store.memories.page(options), status(400));
  }
  const unpack = JSON.parse(Buffer.from(cursor, "base64url"));
  for (const altered of [{ ...unpack, type: "chat" }, { ...unpack, position: -1 }, { ...unpack, position: 20001 }]) {
    assert.throws(() => store.memories.page({ cursor: Buffer.from(JSON.stringify(altered)).toString("base64url") }), status(400));
  }
  store.identity({ name: "同一位伴侣" }); store.settings({ autoMemory: false });
  assert.doesNotThrow(() => store.memories.page({ cursor }));
  store.addMemory({ content: "新资料" });
  assert.throws(() => store.memories.page({ cursor }), status(409));
  const next = store.memories.page().olderCursor;
  store.mutate((state) => { state.identity.id = randomUUID(); });
  assert.throws(() => store.memories.page({ cursor: next }), status(409));
});

test("memory anchors preserve the visible page after edits, but deleted or newly filtered anchors reject safely", (t) => {
  const store = fixture(t), target = store.state.memories[150];
  const page = store.memories.page({ anchor: target.id, limit: 10 });
  assert.deepEqual(ids(page), store.state.memories.slice(141, 151).map((memory) => memory.id).reverse());
  store.editMemory(target.id, { content: "纠正后的位置不变" });
  assert.equal(store.memories.page({ anchor: target.id }).memories[0].content, "纠正后的位置不变");
  assert.throws(() => store.memories.page({ anchor: target.id, status: "pending" }), status(404));
  const backup = store.exportData(), cursor = store.memories.page().olderCursor;
  store.deleteMemory(target.id);
  assert.throws(() => store.memories.page({ anchor: target.id }), status(404));
  assert.throws(() => store.memories.page({ cursor }), status(409));
  store.restore(backup);
  assert.equal(store.memories.page({ query: "纠正后的位置" }).totalMatches, 0);
});

test("deadline crossing and clock rollback reclassify memory filters without database writes or a stale cursor", (t) => {
  const store = fixture(t, 80), start = Date.now(), deadline = start + 1000;
  const target = store.addMemory({ content: "短期安排", expiresAt: new Date(deadline).toISOString() });
  const cursor = store.memories.page({ status: "confirmed" }).olderCursor;
  // Use a shorter page so both sides have a paging cursor.
  const before = store.memories.page({ status: "confirmed", limit: 2 });
  assert.ok(before.olderCursor);
  const writes = store.db.prepare("SELECT total_changes() AS n").get().n;
  t.mock.method(Date, "now", () => deadline);
  assert.equal(store.memories.page({ status: "inactive" }).memories[0].id, target);
  assert.throws(() => store.memories.page({ status: "confirmed", cursor: before.olderCursor }), status(409));
  t.mock.method(Date, "now", () => start);
  assert.doesNotThrow(() => store.memories.page({ status: "confirmed", cursor: before.olderCursor }));
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, writes);
  assert.equal(cursor, null);
});

test("compact memory summaries omit all memory records while full snapshots and exports remain complete", (t) => {
  const store = fixture(t);
  const compact = store.clientSnapshot({ assets: false, recentMessages: true, includeMemories: false });
  assert.equal(Object.hasOwn(compact, "memories"), false);
  assert.equal(compact.memoryWindow.total, 247);
  assert.equal(Object.hasOwn(compact, "avatar"), false);
  assert.equal(store.clientSnapshot().memories.length, 247);
  assert.equal(store.exportData().memories.length, 247);
  compact.memoryWindow.counts.confirmed = 0;
  assert.notEqual(store.memories.summary().counts.confirmed, 0);
});

test("memory paging state and cursor are restored after local listener and sync commit failures", (t) => {
  const store = fixture(t), sync = new SyncService(store);
  const before = store.memories.summary(), cursor = store.memories.page().olderCursor;
  const fail = () => { store.memories.page(); throw new Error("isolated memory rollback"); };
  store.listeners.add(fail);
  assert.throws(() => store.editMemory(store.state.memories[0].id, { content: "不应保存" }), /isolated memory rollback/);
  store.listeners.delete(fail);
  assert.deepEqual(store.memories.summary(), before);
  assert.doesNotThrow(() => store.memories.page({ cursor }));
  store.db.exec("CREATE TEMP TRIGGER fail_page_sync BEFORE UPDATE ON main.sync_meta BEGIN SELECT RAISE(ABORT,'memory sync rollback'); END");
  const next = store.snapshot(); next.memories[0].content = "不应同步";
  assert.throws(() => sync.commit(next, { ...sync.meta, lastSuccess: "2026-11-13T00:00:00.000Z" }), /memory sync rollback/);
  assert.deepEqual(store.memories.summary(), before);
  assert.doesNotThrow(() => store.memories.page({ cursor }));
});

test("actual referenced memories are read independently of the visible page and stale hashes, sources or replies are withheld", (t) => {
  const store = fixture(t), original = store.state.memories[0];
  store.mutate((state) => { state.memories[0].content = "猫栗子的生日是三月十四日"; });
  const context = { ...buildContext(store.state, { query: "栗子生日" }).refs, model: "isolated" };
  const reply = { id: randomUUID(), role: "assistant", content: "我记得", status: "completed", deleted: false,
    revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), context };
  store.mutate((state) => { state.messages.push(reply); });
  assert.equal(ids(store.memories.page()).includes(original.id), false);
  const request = { id: reply.id, revision: 1, expected: structuredClone(context) };
  assert.equal(store.memoryReferences(request).memories.find((memory) => memory.id === original.id).content, original.content);
  store.mutate((state) => { state.memories[0].content = "同整数修订的另一份资料"; });
  const unavailable = store.memoryReferences(request).memories.find((memory) => memory.id === original.id);
  assert.equal(unavailable.available, false); assert.equal(unavailable.content.includes("三月十四日"), false);
  store.mutate((state) => { state.messages.at(-1).context.model = "changed"; });
  assert.throws(() => store.memoryReferences(request), status(409));
  store.deleteMessage(reply.id);
  assert.throws(() => store.memoryReferences(request), status(404));
});

test("remote corrections, conflicts and deletion invalidate memory paging and refresh filtered results", async (t) => {
  const dav = await davFixture(); t.after(() => dav.close());
  const a = fixture(t, 90), b = new CompanionStore(); t.after(() => b.close());
  const x = new SyncService(a), y = new SyncService(b);
  for (const sync of [x, y]) sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const code = x.createPair().code; await x.sync(); await y.join(code);
  const cursor = b.memories.page().olderCursor, target = a.state.memories[0].id;
  a.editMemory(target, { content: "A 的修改" }); b.editMemory(target, { content: "B 的修改" });
  await x.sync(); await y.sync();
  assert.throws(() => b.memories.page({ cursor }), status(409));
  assert.ok(ids(b.memories.page({ status: "inactive" })).includes(target));
  const conflict = b.state.conflicts.find((item) => item.id === target);
  y.resolve(conflict.key, conflict.candidates.find((candidate) => candidate.value.content === "A 的修改").id);
  assert.equal(b.memories.page({ query: "A 的修改", status: "confirmed" }).totalMatches, 1);
  await y.sync(); await x.sync();
  a.deleteMemory(target); await x.sync(); await y.sync();
  assert.equal(b.memories.page({ query: "A 的修改" }).totalMatches, 0);
});

test("reopening SQLite preserves records, installs the browse index and rejects cursors from the earlier process", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "niria-memory-page-")), filename = join(folder, "companion.sqlite");
  let opened = new CompanionStore(filename);
  t.after(() => { opened?.close(); assert.ok(resolve(folder).startsWith(`${resolve(tmpdir())}${sep}`)); rmSync(folder, { recursive: true, force: true }); });
  for (let i = 0; i < 4; i++) opened.addMemory({ content: `重启资料 ${i}` });
  const cursor = opened.memories.page({ limit: 1 }).olderCursor;
  opened.close(); opened = null; opened = new CompanionStore(filename);
  assert.equal(opened.memories.page().total, 4);
  assert.throws(() => opened.memories.page({ cursor, limit: 1 }), status(409));
  assert.equal(opened.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='memories_browse'").get().n, 1);
});

test("memory paging, compact state and lazy references enforce token and origin without model calls", async (t) => {
  const store = fixture(t);
  let calls = 0;
  const companion = new CompanionService(store, { completion: async () => { calls++; return "unused"; } });
  const server = createPrototypeServer({ store, companion }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, { token } = await (await fetch(`${base}/api/session`)).json();
  const headers = { "X-Niria-Token": token };
  assert.equal((await fetch(`${base}/api/memories`)).status, 403);
  assert.equal((await fetch(`${base}/api/memories`, { headers: { ...headers, Origin: "https://other.example" } })).status, 403);
  const page = await (await fetch(`${base}/api/memories?limit=7&status=pending&kind=experience`, { headers })).json();
  assert.equal(page.memories.length, 7);
  assert.ok(page.memories.every((memory) => !memory.confirmed && memory.kind === "experience"));
  assert.equal((await fetch(`${base}/api/memories?limit=101`, { headers })).status, 400);
  const compact = await (await fetch(`${base}/api/state?messages=recent&memories=none&assets=0`, { headers })).json();
  assert.equal(Object.hasOwn(compact, "memories"), false); assert.equal(compact.memoryWindow.total, 247);
  assert.equal((await fetch(`${base}/api/state?memories=unknown`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/memories/references`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/api/memories/references`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).status, 400);
  assert.equal(calls, 0);
});
