import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { davFixture } from "./fixtures/dav.mjs";

function fixture(t, count = 247) {
  const store = new CompanionStore();
  t.after(() => store.close());
  store.mutate((state) => {
    state.messages = Array.from({ length: count }, (_, index) => {
      const at = new Date(Date.now() - (count - index) * 1000).toISOString();
      return {
        id: `history-${index}`, role: index % 2 ? "assistant" : "user", content: `第 ${index} 条聊天`,
        revision: 1, deleted: false, status: "completed", createdAt: at, updatedAt: at
      };
    });
  });
  return store;
}
const ids = (page) => page.messages.map((message) => message.id);
const status = (code) => (error) => error.status === code;

test("history pages visit every current message in both directions without gaps or duplicates", (t) => {
  const store = fixture(t), expected = store.state.messages.map((message) => message.id);
  let page = store.history.page(), actual = ids(page);
  assert.equal(actual.length, 60);
  assert.equal(page.totalMatches, 247);
  assert.equal(page.newerCursor, null);
  while (page.olderCursor) {
    page = store.history.page({ cursor: page.olderCursor });
    actual = [...ids(page), ...actual];
  }
  assert.deepEqual(actual, expected);
  actual = ids(page);
  while (page.newerCursor) {
    page = store.history.page({ cursor: page.newerCursor });
    actual.push(...ids(page));
  }
  assert.deepEqual(actual, expected);
  store.deleteMessage("history-2");
  assert.equal(store.history.page({ query: "第 2 条" }).totalMatches, 0);
});

test("search is local literal text, supports Chinese and ASCII case, and binds cursors to its filter", (t) => {
  const store = fixture(t);
  store.mutate((state) => {
    state.messages[0].content = `乌龙茶 Tea 100%_'" OR 1=1 --`;
    state.messages[2].content = "tea 喝茶";
  });
  for (const query of ["乌龙茶", "100%_", `'" OR 1=1 --`, "%", "_"]) {
    assert.deepEqual(ids(store.history.page({ query })), ["history-0"]);
  }
  assert.deepEqual(ids(store.history.page({ query: "  tEa  " })), ["history-0", "history-2"]);
  assert.equal(store.history.page({ query: "没有这句话" }).totalMatches, 0);
  const page = store.history.page({ query: "聊天", limit: 5 });
  assert.throws(() => store.history.page({ query: "茶", cursor: page.olderCursor }), status(400));
  assert.equal(store.state.calls.length, 0);
});

test("anchored context finds old sources and keeps chronology and page directions", (t) => {
  const store = fixture(t);
  const page = store.history.page({ anchor: "history-50", limit: 10 });
  assert.deepEqual(ids(page), Array.from({ length: 10 }, (_, i) => `history-${45 + i}`));
  assert.equal(store.history.page({ cursor: page.newerCursor, limit: 10 }).messages[0].id, "history-55");
  assert.equal(store.history.page({ cursor: page.olderCursor, limit: 10 }).messages.at(-1).id, "history-44");
  store.deleteMessage("history-50");
  assert.throws(() => store.history.page({ anchor: "history-50" }), status(404));
  assert.throws(() => store.history.page({ cursor: page.olderCursor }), status(409));
});

test("invalid cursors and oversized queries are rejected, and edits/restore invalidate previous pages", (t) => {
  const store = fixture(t);
  const cursor = store.history.page().olderCursor;
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { query: "长".repeat(201) },
    { cursor: "not-json" }, { cursor, anchor: "history-0" }, { anchor: "x".repeat(101) }]) {
    assert.throws(() => store.history.page(options), status(400));
  }
  const unpack = JSON.parse(Buffer.from(cursor, "base64url"));
  for (const altered of [{ ...unpack, position: -1 }, { ...unpack, position: 100001 }, { ...unpack, version: 2 }]) {
    assert.throws(() => store.history.page({ cursor: Buffer.from(JSON.stringify(altered)).toString("base64url") }), status(400));
  }
  const backup = store.exportData();
  store.editMessage("history-246", "纠正后的句子");
  assert.equal(store.history.page({ query: "第 246 条" }).totalMatches, 0);
  assert.deepEqual(ids(store.history.page({ query: "纠正后" })), ["history-246"]);
  assert.throws(() => store.history.page({ cursor }), status(409));
  const updated = store.history.page().olderCursor;
  store.restore(backup);
  assert.throws(() => store.history.page({ cursor: updated }), status(409));
});

test("compact snapshots contain 120 visible messages and global latest user; full snapshots remain complete", (t) => {
  const store = fixture(t);
  store.mutate((state) => { for (const message of state.messages.slice(121)) message.role = "assistant"; });
  store.deleteMessage("history-246");
  const compact = store.clientSnapshot({ assets: false, recentMessages: true });
  assert.equal(compact.messages.length, 120);
  assert.equal(compact.messages.some((message) => message.deleted), false);
  assert.equal(compact.messageWindow.total, 246);
  assert.equal(compact.messageWindow.lastUserId, "history-120");
  assert.equal(Object.hasOwn(compact, "avatar"), false);
  assert.equal(store.clientSnapshot().messages.length, 247);
  compact.messages[0].content = "修改副本";
  assert.notEqual(store.state.messages[126].content, "修改副本");
});

test("history revision is stable for other entities and restored on both local and sync transaction failure", (t) => {
  const store = fixture(t), sync = new SyncService(store);
  const before = store.messageVersion, cursor = store.history.page().olderCursor;
  store.identity({ name: "回顾测试" });
  store.settings({ autoMemory: false });
  store.addMemory({ content: "一条手动记忆" });
  assert.equal(store.messageVersion, before);
  assert.doesNotThrow(() => store.history.page({ cursor }));
  const fail = () => { throw new Error("test rollback"); };
  store.listeners.add(fail);
  assert.throws(() => store.addUser("未提交内容"), /test rollback/);
  store.listeners.delete(fail);
  assert.equal(store.messageVersion, before);
  assert.equal(store.history.page({ query: "未提交内容" }).totalMatches, 0);
  store.db.exec("CREATE TEMP TRIGGER fail_sync BEFORE UPDATE ON main.sync_meta BEGIN SELECT RAISE(ABORT,'test sync rollback'); END");
  const next = store.snapshot();
  next.messages[0].content = "失败的同步正文";
  assert.throws(() => sync.commit(next, { ...sync.meta, lastSuccess: "2026-11-13T00:00:00.000Z" }), /test sync rollback/);
  assert.equal(store.messageVersion, before);
  assert.equal(store.history.page({ query: "失败的同步正文" }).totalMatches, 0);
  store.db.exec("DROP TRIGGER fail_sync");
  next.messages.reverse();
  sync.commit(next, sync.meta);
  assert.notEqual(store.messageVersion, before);
  assert.throws(() => store.history.page({ cursor }), status(409));
});

test("lazy memory sources include messages older than the compact window and reject changed provenance", (t) => {
  const store = fixture(t);
  const id = store.addMemory({ content: "早期聊天的记忆", sources: [{ id: "history-0", revision: 1 }] });
  let memory = store.state.memories.find((item) => item.id === id);
  assert.equal(store.clientSnapshot({ recentMessages: true }).messages.some((message) => message.id === "history-0"), false);
  assert.deepEqual(store.memorySourcePreview(id, 1).sources, [{ id: "history-0", available: true, content: "第 0 条聊天" }]);
  store.mutate((state) => { state.messages[0].content = "同修订的不同正文"; });
  assert.equal(store.memorySourcePreview(id, 1).sources[0].available, false);
  store.deleteMessage("history-0");
  assert.throws(() => store.memorySourcePreview(id, 1), status(409));
  memory = store.state.memories.find((item) => item.id === id);
  assert.equal(store.memorySourcePreview(id, memory.revision).sources[0].available, false);
  store.deleteMemory(id);
  assert.throws(() => store.memorySourcePreview(id, memory.revision), status(404));
});

test("synchronized edits, conflict selection and remote deletion update local search", async (t) => {
  const dav = await davFixture(); t.after(() => dav.close());
  const a = fixture(t, 3), b = new CompanionStore(); t.after(() => b.close());
  a.mutate((state) => { for (const message of state.messages) message.id = randomUUID(); });
  const id = a.state.messages[2].id;
  const x = new SyncService(a), y = new SyncService(b);
  for (const sync of [x, y]) sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const code = x.createPair().code;
  await x.sync(); await y.join(code);
  const page = a.history.page({ limit: 1 });
  a.editMessage(id, "本机改动");
  b.editMessage(id, "另一端改动");
  await y.sync(); await x.sync();
  assert.throws(() => a.history.page({ cursor: page.olderCursor, limit: 1 }), status(409));
  const conflict = a.state.conflicts.find((item) => item.id === id);
  const chosen = conflict.candidates.find((candidate) => candidate.value.content === "另一端改动");
  x.resolve(conflict.key, chosen.id);
  assert.equal(a.history.page({ query: "另一端改动" }).totalMatches, 1);
  await x.sync(); await y.sync();
  b.deleteMessage(id);
  await y.sync(); await x.sync();
  assert.equal(a.history.page({ query: "另一端改动" }).totalMatches, 0);
});

test("history and memory-source APIs require the local token and origin and never call models", async (t) => {
  const store = fixture(t);
  const memory = store.addMemory({ content: "来源测试", sources: [{ id: "history-0", revision: 1 }] });
  let calls = 0;
  const companion = new CompanionService(store, { completion: async () => { calls++; return "unused"; } });
  const server = createPrototypeServer({ store, companion });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const headers = { "X-Niria-Token": token };
  assert.equal((await fetch(`${base}/api/messages`)).status, 403);
  assert.equal((await fetch(`${base}/api/messages`, { headers: { ...headers, Origin: "https://other.example" } })).status, 403);
  const page = await (await fetch(`${base}/api/messages?q=${encodeURIComponent("第 0 条")}`, { headers })).json();
  assert.deepEqual(ids(page), ["history-0"]);
  const compact = await (await fetch(`${base}/api/state?messages=recent&assets=0`, { headers })).json();
  assert.equal(compact.messages.length, 120);
  assert.equal(Object.hasOwn(compact, "avatar"), false);
  assert.equal((await fetch(`${base}/api/state?messages=invalid`, { headers })).status, 400);
  const sources = (auth, body) => fetch(`${base}/api/memories/sources`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? headers : {}) }, body: JSON.stringify(body) });
  assert.equal((await sources(false, { id: memory, revision: 1 })).status, 403);
  assert.equal((await sources(true, { id: memory })).status, 400);
  assert.equal((await (await sources(true, { id: memory, revision: 1 })).json()).sources[0].content, "第 0 条聊天");
  assert.equal(calls, 0);
});
