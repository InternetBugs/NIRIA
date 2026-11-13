import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService, buildContext, previewContext } from "../core/chat-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { contextReviewBasis } from "../prototype/public/context-review.js";

function fixture(t, { large = false } = {}) {
  const store = new CompanionStore();
  t.after(() => store.close());
  store.settings({ autoMemory: false });
  const at = new Date().toISOString();
  store.mutate((state) => {
    state.messages = Array.from({ length: 28 }, (_, index) => ({
      id: randomUUID(), role: index % 2 ? "assistant" : "user", content: large ? `${index}号记录`.repeat(1700) : `隔离范围记录 ${index}`,
      revision: 1, status: "completed", deleted: false, createdAt: at, updatedAt: at
    }));
  });
  store.addMemory({ content: "范围验证：栗子的生日在三月十四日" });
  return store;
}

for (const large of [false, true]) test(`draft preview matches actual next request across ${large ? "text budget" : "24-message"} limits without writing`, async (t) => {
  const store = fixture(t, { large }), draft = large ? "栗子".repeat(6000) : "  栗子的生日呢？  ";
  const before = store.snapshot(), writes = store.db.prepare("SELECT total_changes() AS n").get().n;
  const preview = previewContext(store.state, draft);
  assert.equal(preview.draftIncluded, true);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, writes);
  assert.ok(preview.refs.messageRefs.length <= 23);
  if (!large) assert.equal(preview.refs.messageRefs.length, 23);
  let sent, calls = 0;
  const service = new CompanionService(store, { completion: async (_, messages) => { calls++; sent = messages; return "隔离回复"; } });
  service.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "range-test" });
  await service.send({ content: draft });
  assert.equal(calls, 1);
  assert.deepEqual(preview.messages.slice(1), sent.slice(1));
  const actual = store.state.messages.at(-1).context;
  const user = store.state.messages.at(-2);
  assert.deepEqual(actual.messageRefs.filter((ref) => ref.id !== user.id), preview.refs.messageRefs);
  assert.deepEqual(actual.memoryRefs, preview.refs.memoryRefs);
});

test("empty draft preserves current selection and malformed drafts fail without writes", (t) => {
  const store = fixture(t), before = store.snapshot(), writes = store.db.prepare("SELECT total_changes() AS n").get().n;
  const empty = previewContext(store.state, " \n ");
  assert.equal(empty.draftIncluded, false);
  assert.deepEqual(empty.messages.slice(1), buildContext(store.state, { query: "" }).messages.slice(1));
  assert.equal(empty.refs.messageRefs.length, 24);
  for (const value of [undefined, null, 4, {}, [], "字".repeat(16001)]) {
    assert.throws(() => previewContext(store.state, value), (error) => error.status === 400);
  }
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, writes);
});

test("draft preview cannot resurrect denied, corrected, expired or forgotten memory sources", (t) => {
  const store = fixture(t), source = store.addUser("范围秘密：旧称呼");
  const memory = store.addMemory({ content: "范围秘密：旧称呼", sources: [{ id: source.id, revision: 1 }] });
  assert.ok(previewContext(store.state, "旧称呼").memoryPreview.some((item) => item.id === memory));
  store.editMemory(memory, { content: "范围资料：新称呼" });
  assert.equal(JSON.stringify(previewContext(store.state, "称呼")).includes("范围秘密：旧称呼"), false);
  store.editMemory(memory, { allowModel: false });
  assert.equal(JSON.stringify(previewContext(store.state, "称呼")).includes("范围资料：新称呼"), false);
  store.settings({ allowModel: false });
  assert.equal(previewContext(store.state, "栗子").memoryPreview.length, 0);
  store.settings({ allowModel: true });
  store.deleteMemory(memory, true, store.forgettingPreview({ id: memory }).token);
  assert.equal(JSON.stringify(previewContext(store.state, "称呼")).includes("范围资料：新称呼"), false);
  store.mutate((state) => { state.memories[0].expiresAt = "2000-01-01T00:00:00.000Z"; });
  assert.equal(previewContext(store.state, "栗子").memoryPreview.length, 0);
});

test("preview basis follows persona, model connection, permissions and draft independently of memory revision", () => {
  const state = { identity: { name: "范围伴侣", revision: 1 }, memoryWindow: { revision: "same" },
    messageWindow: { revision: "same" }, settings: { allowModel: true },
    service: { connected: true, baseUrl: "http://127.0.0.1:9/v1", model: "first" },
    connections: { chat: { connectionId: "first" } }, avatarKey: null };
  const before = contextReviewBasis(state, "草稿");
  for (const mutate of [
    (next) => { next.identity.name = "新名字"; },
    (next) => { next.settings.allowModel = false; },
    (next) => { next.service.model = "second"; },
    (next) => { next.connections.chat.connectionId = "second"; },
    (next) => { next.memoryWindow.revision = "new"; },
    (next) => { next.messageWindow.revision = "new"; },
    (next) => { next.avatarKey = "new"; }
  ]) {
    const next = structuredClone(state); mutate(next);
    assert.notEqual(contextReviewBasis(next, "草稿"), before);
  }
  assert.notEqual(contextReviewBasis(state, "新的草稿"), before);
  assert.equal(contextReviewBasis({ ...state, calls: [{ status: "completed" }] }, "草稿"), before);
});

test("preview and actual citation reads expose the earliest available deadline for in-flight expiry checks", (t) => {
  const store = fixture(t), deadline = Date.now() + 60000;
  store.mutate((state) => { state.memories[0].expiresAt = new Date(deadline).toISOString(); });
  const preview = previewContext(store.state, "栗子的生日");
  assert.equal(preview.validUntil, deadline);
  const context = { ...buildContext(store.state).refs, model: "isolated-deadline" }, at = new Date().toISOString();
  const reply = { id: randomUUID(), role: "assistant", content: "隔离期限回复", status: "completed", deleted: false,
    revision: 1, createdAt: at, updatedAt: at, context };
  store.mutate((state) => { state.messages.push(reply); });
  assert.equal(store.memoryReferences({ id: reply.id, revision: 1, expected: context }).validUntil, deadline);
  store.mutate((state) => { state.memories[0].expiresAt = "2000-01-01T00:00:00.000Z"; });
  assert.equal(previewContext(store.state, "栗子").validUntil, null);
  const unavailable = store.memoryReferences({ id: reply.id, revision: 1, expected: context });
  assert.equal(unavailable.validUntil, null);
  assert.equal(unavailable.memories[0].available, false);
});

test("preview HTTP route is authenticated, validates input and stamps the current window without provider calls", async (t) => {
  const store = fixture(t);
  let calls = 0;
  const companion = new CompanionService(store, { completion: async () => { calls++; return "不应调用"; } });
  const app = createPrototypeServer({ store, companion });
  app.listen(0, "127.0.0.1"); await once(app, "listening");
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`, { token } = await (await fetch(`${base}/api/session`)).json();
  const post = (body, extra = {}) => fetch(`${base}/api/context/preview`, { method: "POST",
    headers: { "X-Niria-Token": token, "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
  assert.equal((await post({ draft: "栗子" }, { "X-Niria-Token": "wrong" })).status, 403);
  assert.equal((await post({ draft: "栗子" }, { Origin: "https://other.example" })).status, 403);
  for (const draft of [false, {}, "字".repeat(16001)]) assert.equal((await post({ draft })).status, 400);
  const before = store.snapshot(), writes = store.db.prepare("SELECT total_changes() AS n").get().n;
  const response = await post({ draft: "栗子" }), preview = await response.json();
  assert.equal(response.status, 200);
  const state = await (await fetch(`${base}/api/state?messages=recent&memories=none`, { headers: { "X-Niria-Token": token } })).json();
  assert.equal(preview.previewBasis, contextReviewBasis(state, "栗子"));
  assert.equal(preview.refs.messageRefs.length, 23);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, writes);
  assert.equal(calls, 0);
  assert.equal((await fetch(`${base}/context-review.js`)).status, 200);
});
