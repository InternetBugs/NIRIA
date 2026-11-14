import test from "node:test";
import assert from "node:assert/strict";
import { CompanionStore } from "../core/store.mjs";
import { recallMemories, recallTerms } from "../core/memory-recall.mjs";
import { CompanionService, buildContext } from "../core/chat-service.mjs";

function storeFor(t) { const store = new CompanionStore(); t.after(() => store.close()); return store; }
test("older relevant memories are recalled beyond thirty newer unrelated records", (t) => {
  const store = storeFor(t);
  const wanted = store.addMemory({ content: "用户的猫叫栗子，生日是 3 月 14 日。" });
  store.state.memories[0].createdAt = store.state.memories[0].updatedAt = "2020-01-01T00:00:00.000Z";
  for (let i = 0; i < 60; i++) store.addMemory({ content: `用户去过第 ${i} 号公园散步。` });
  const recalled = recallMemories(store.state, { query: "你还记得栗子的生日吗？" });
  assert.equal(recalled[0].memory.id, wanted);
  assert.equal(recalled[0].reason, "related");
  assert.equal(recalled.length, 30);
  const context = buildContext(store.state, { query: "栗子的生日" });
  assert.match(context.messages[0].content, /3 月 14 日/);
  assert.equal(context.refs.memoryRefs[0].reason, "related");
});
test("retrieval handles Chinese compound words and normalized English names locally", () => {
  assert.ok(recallTerms("乌龙茶").has("乌龙"));
  assert.ok(recallTerms("Ｍｉｋａ").has("mika"));
  assert.equal(recallTerms("我还记得你吗").has("记得"), false);
});
test("denied, expired, deleted, conflicted and invalidated records never participate in retrieval", (t) => {
  const store = storeFor(t);
  const fields = [{ allowModel: false }, { expiresAt: "2000-01-01T00:00:00Z" }, { deleted: true }, { conflicted: true }, { invalidated: true }];
  for (let i = 0; i < fields.length; i++) {
    const id = store.addMemory({ content: `栗子秘密 ${i}` });
    Object.assign(store.state.memories.find((m) => m.id === id), fields[i]);
  }
  assert.equal(recallMemories(store.state, { query: "栗子秘密" }).length, 0);
  assert.equal(JSON.stringify(buildContext(store.state, { query: "栗子" })).includes("栗子秘密"), false);
});
test("memory selection respects total text budget and skips oversized items without starving later candidates", (t) => {
  const store = storeFor(t);
  store.addMemory({ content: "栗子".repeat(500) });
  const shorter = store.addMemory({ content: "栗子喜欢阳光。" });
  const recalled = recallMemories(store.state, { query: "栗子", budget: 20 });
  assert.deepEqual(recalled.map((r) => r.memory.id), [shorter]);
});
test("draft preview and real send select the same relevant old memory without additional calls", async (t) => {
  const store = storeFor(t);
  const id = store.addMemory({ content: "用户的猫叫栗子。" });
  for (let i = 0; i < 35; i++) store.addMemory({ content: `散步公园 ${i}` });
  store.settings({ autoMemory: false });
  const query = "栗子还记得吗？";
  const preview = buildContext(store.state, { query });
  let calls = 0;
  const service = new CompanionService(store, { completion: async (_, messages) => { calls++; assert.match(messages[0].content, /猫叫栗子/); return "记得呀，栗子是你的猫。"; } });
  service.configure({ baseUrl: "http://localhost:8181/v1", model: "test" });
  await service.send({ content: query });
  const refs = store.state.messages.at(-1).context.memoryRefs;
  assert.ok(refs.some((r) => r.id === id));
  assert.deepEqual(refs.map((r) => r.id), preview.refs.memoryRefs.map((r) => r.id));
  assert.equal(calls, 1);
});
test("warm recall index honors content corrections, permission withdrawal, expiry and changed message provenance", (t) => {
  const store = storeFor(t);
  const user = store.addUser("栗子生日在三月");
  const id = store.addMemory({ content: "栗子生日在三月", sources: [{ id: user.id, revision: 1 }] });
  assert.equal(recallMemories(store.state, { query: "栗子" })[0].reason, "related");
  store.editMemory(id, { content: "冬青喜欢散步" });
  const corrected = recallMemories(store.state, { query: "栗子" });
  assert.equal(corrected[0].reason, "confirmed");
  assert.equal(recallMemories(store.state, { query: "冬青" })[0].reason, "related");
  store.editMemory(id, { allowModel: false });
  assert.equal(recallMemories(store.state, { query: "冬青" }).length, 0);
  store.editMemory(id, { allowModel: true });
  store.mutate((state) => { state.memories[0].expiresAt = "2030-01-01T00:00:00Z"; });
  assert.equal(recallMemories(store.state, { query: "冬青", at: Date.parse("2031-01-01") }).length, 0);
  // Superseded versions stay excluded; use a genuinely new source to exercise
  // cache invalidation for equal-revision content changes independently.
  const freshSource = store.addUser("栗子的新资料");
  const derived = store.addMemory({ content: "栗子来源记忆", sources: [{ id: freshSource.id, revision: 1 }] });
  assert.ok(recallMemories(store.state, { query: "栗子" }).some((r) => r.memory.id === derived));
  store.mutate((state) => { state.messages.find((item) => item.id === freshSource.id).content = "同修订不同正文"; });
  assert.ok(!recallMemories(store.state, { query: "栗子" }).some((r) => r.memory.id === derived));
});
