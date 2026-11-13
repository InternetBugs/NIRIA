import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { CompanionStore, validMemory, messageHash } from "../core/store.mjs";
import { CompanionService, buildContext, complete, chatEndpoint } from "../core/chat-service.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const config = { baseUrl: "http://localhost:8181/v1", model: "test-model", apiKey: "test-secret-key" };
function setup(t, options) {
  const store = new CompanionStore();
  t.after(() => store.close());
  const service = new CompanionService(store, options);
  service.configure(config);
  return { store, service };
}
function defer() {
  let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise };
}

test("SQLite preserves identity, chat and memory across process instances", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "niria-store-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "companion.sqlite");
  const first = new CompanionStore(path);
  const id = first.state.identity.id;
  first.identity({ name: "月见" });
  const message = first.addUser("我喜欢乌龙茶");
  first.addMemory({ content: "用户喜欢乌龙茶", sources: [{ id: message.id, revision: 1 }] });
  first.close();
  const second = new CompanionStore(path);
  try {
    assert.equal(second.state.identity.id, id);
    assert.equal(second.state.identity.name, "月见");
    assert.equal(second.state.messages[0].content, "我喜欢乌龙茶");
    assert.equal(second.state.memories.length, 1);
  } finally { second.close(); }
});

test("editing the last user message invalidates memories and removes the previous reply", async (t) => {
  const { store, service } = setup(t, { completion: async () => "记住了。" });
  store.settings({ autoMemory: false });
  await service.send({ content: "我喜欢乌龙茶" });
  const user = store.state.messages[0];
  store.addMemory({ content: "喜欢乌龙茶", sources: [{ id: user.id, revision: 1 }] });
  store.editMessage(user.id, "其实我喜欢红茶");
  assert.equal(store.state.memories[0].invalidated, true);
  assert.equal(store.state.messages[1].deleted, true);
  const context = buildContext(store.state);
  assert.equal(JSON.stringify(context).includes("乌龙茶"), false);
  assert.ok(JSON.stringify(context).includes("红茶"));
});

test("automatic memory uses only current user source and survives a model change", async (t) => {
  const calls = [];
  const { store, service } = setup(t, { completion: async (connection, messages) => {
    calls.push({ model: connection.model, messages });
    return messages[0].content.includes("记忆整理器")
      ? '{"memories":[{"content":"用户喜欢乌龙茶","kind":"fact","expiresAt":null}]}' : "下次想听你说说喜欢的茶。";
  } });
  await service.send({ content: "我喜欢乌龙茶" });
  const memory = store.state.memories[0];
  assert.equal(calls.length, 2);
  assert.equal(memory.confirmed, false);
  assert.deepEqual(memory.sources, [{ id: store.state.messages[0].id, revision: 1, hash: messageHash(store.state.messages[0]) }]);
  service.configure({ ...config, model: "second-model" });
  store.settings({ autoMemory: false });
  await service.send({ content: "你记得我的喜好吗？" });
  assert.equal(calls.at(-1).model, "second-model");
  assert.ok(calls.at(-1).messages[0].content.includes("用户喜欢乌龙茶"));
  assert.equal(JSON.stringify(store.exportData()).includes("test-secret-key"), false);
});

test("deleting a memory blocks automatic recreation from its old source", (t) => {
  const { store } = setup(t);
  const message = store.addUser("我喜欢乌龙茶");
  const input = { content: "喜欢乌龙茶", sources: [{ id: message.id, revision: 1 }] };
  const id = store.addMemory(input, { automatic: true });
  store.deleteMemory(id);
  assert.equal(store.addMemory({ ...input, content: "用户爱喝茶" }, { automatic: true }), null);
  assert.equal(store.state.memories.filter((m) => !m.deleted).length, 0);
});

test("forget removes sources, replies and related derived memories; old backup cannot resurrect them", async (t) => {
  const { store, service } = setup(t, { completion: async () => "我记住了。" });
  store.settings({ autoMemory: false });
  await service.send({ content: "我住在台北，喜欢乌龙茶" });
  const sources = [{ id: store.state.messages[0].id, revision: 1 }];
  const id = store.addMemory({ content: "住在台北", sources });
  store.addMemory({ content: "喜欢乌龙茶", sources });
  const old = store.exportData();
  store.deleteMemory(id, true);
  assert.equal(store.state.messages.some((m) => !m.deleted), false);
  assert.equal(store.state.memories.some((m) => !m.deleted), false);
  assert.equal(JSON.stringify(store.snapshot()).includes("乌龙茶"), false);
  store.restore(old);
  assert.equal(store.state.messages.some((m) => !m.deleted), false);
  assert.equal(store.state.memories.some((m) => !m.deleted), false);
  assert.equal(buildContext(store.state).refs.memoryRefs.length, 0);
});

test("model permission excludes memory and source dialogue; sync permission remains independent", async (t) => {
  const { store, service } = setup(t, { completion: async () => "乌龙茶很香。" });
  store.settings({ autoMemory: false });
  await service.send({ content: "秘密资料：乌龙茶" });
  const id = store.addMemory({ content: "喜欢乌龙茶", sources: [{ id: store.state.messages[0].id, revision: 1 }] });
  store.editMemory(id, { allowModel: false, allowSync: true });
  const context = buildContext(store.state);
  assert.equal(JSON.stringify(context).includes("乌龙茶"), false);
  assert.equal(store.state.memories[0].allowSync, true);
});

test("late response is rejected after source is edited", async (t) => {
  const waiting = defer(), entered = defer();
  const { store, service } = setup(t, { completion: async () => { entered.resolve(); return waiting.promise; } });
  const pending = service.send({ content: "旧消息" });
  await entered.promise;
  store.editMessage(store.state.messages[0].id, "新消息");
  waiting.resolve("针对旧消息的回复");
  await assert.rejects(pending, /来源已经改变/);
  assert.equal(store.state.messages.some((m) => m.content === "针对旧消息的回复"), false);
});

test("late memory extraction cannot revive an edited source", async (t) => {
  const waiting = defer(), entered = defer(); let count = 0;
  const { store, service } = setup(t, { completion: async () => {
    if (++count === 1) return "好呀";
    entered.resolve(); return waiting.promise;
  } });
  const pending = service.send({ content: "我喜欢乌龙茶" });
  await entered.promise;
  store.editMessage(store.state.messages[0].id, "我喜欢红茶");
  waiting.resolve('{"memories":[{"content":"喜欢乌龙茶","kind":"fact"}]}');
  await pending;
  assert.equal(store.state.memories.length, 0);
});

test("daily memory limit counts attempts and does not retry malformed extraction", async (t) => {
  let calls = 0;
  const { store, service } = setup(t, { completion: async () => { calls++; return "普通回复"; } });
  store.settings({ memoryDailyLimit: 1 });
  await service.send({ content: "第一条" });
  // Keeping only a short visible log must not reset the durable daily budget.
  store.mutate((state) => { state.calls = []; });
  await service.send({ content: "第二条" });
  assert.equal(calls, 3);
  assert.equal(Object.values(store.state.usage).reduce((n, day) => n + (day.memory || 0), 0), 1);
});

test("duplicate sends are rejected while one provider call is pending", async (t) => {
  const waiting = defer(), entered = defer();
  const { store, service } = setup(t, { completion: async () => { entered.resolve(); return waiting.promise; } });
  store.settings({ autoMemory: false });
  const first = service.send({ content: "你好" });
  await entered.promise;
  await assert.rejects(service.send({ content: "重复" }), /正在回复/);
  waiting.resolve("你好。");
  await first;
  assert.equal(store.state.messages.filter((m) => m.role === "user").length, 1);
});

test("care defaults off and honors quiet hours, inactivity and daily call cap", async (t) => {
  let calls = 0;
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const { store, service } = setup(t, { clock: () => noon.getTime(),
    completion: async () => { calls++; return "记得休息一下。"; } });
  service.lastInteraction = noon.getTime() - 5 * 60 * 60_000;
  assert.equal(await service.tick(noon), false);
  store.settings({ care: { enabled: true, dailyLimit: 1 } });
  const night = new Date(noon); night.setHours(23);
  assert.equal(await service.tick(night), false);
  assert.equal(await service.tick(noon), true);
  assert.equal(await service.tick(noon), false);
  assert.equal(calls, 1);
  assert.equal(store.state.messages[0].proactive, true);
});

test("expired and unconfirmed inference are represented accurately in context", (t) => {
  const { store } = setup(t);
  const id = store.addMemory({ content: "可能偏爱安静", kind: "inference" });
  store.editMemory(id, { confirmed: false });
  const context = buildContext(store.state);
  assert.match(context.messages[0].content, /"confirmed":false/);
  store.state.memories[0].expiresAt = "2000-01-01T00:00:00Z";
  assert.equal(validMemory(store.state, store.state.memories[0]), false);
  assert.equal(buildContext(store.state).refs.memoryRefs.length, 0);
});

test("encrypted backup authenticates all contents and restores onto a fresh identity", async (t) => {
  const { store } = setup(t);
  store.identity({ name: "月见" });
  store.addMemory({ content: "用户喜欢乌龙茶" });
  const backup = await encryptBackup(store.exportData(), "a-test-backup-password");
  assert.equal(JSON.stringify(backup).includes("乌龙茶"), false);
  const data = await decryptBackup(backup, "a-test-backup-password");
  const fresh = new CompanionStore();
  try {
    fresh.restore(data);
    assert.equal(fresh.state.identity.id, store.state.identity.id);
    assert.equal(fresh.state.memories[0].content, "用户喜欢乌龙茶");
  } finally { fresh.close(); }
  await assert.rejects(decryptBackup(backup, "wrong-test-password"), /口令不正确/);
  const tampered = { ...backup, data: (backup.data[0] === "A" ? "B" : "A") + backup.data.slice(1) };
  await assert.rejects(decryptBackup(tampered, "a-test-backup-password"), /损坏/);
});

test("Chat Completions adapter sends only supported basic fields and sanitizes provider failures", async () => {
  let received;
  const result = await complete(config, [{ role: "user", content: "你好" }], { fetchImpl: async (url, options) => {
    received = { url, ...options };
    return Response.json({ choices: [{ message: { content: "你好呀" } }] });
  } });
  assert.equal(result, "你好呀");
  assert.equal(received.url, "http://localhost:8181/v1/chat/completions");
  assert.deepEqual(Object.keys(JSON.parse(received.body)).sort(), ["messages", "model", "stream"]);
  await assert.rejects(complete(config, [], { fetchImpl: async () => Response.json({ error: "test-secret-key" }, { status: 401 }) }), (error) => !error.message.includes("test-secret-key"));
  assert.throws(() => chatEndpoint("http://remote.example/v1"), /HTTPS/);
});

test("malformed backup state cannot replace a working companion", (t) => {
  const { store } = setup(t);
  const originalId = store.state.identity.id;
  const malformed = store.exportData();
  malformed.settings.care = null;
  assert.throws(() => store.restore(malformed), /无效/);
  assert.equal(store.state.identity.id, originalId);
  assert.ok(store.state.settings.care);
});
test("avatar refresh key changes when actions change even if the source image stays the same", (t) => {
  const { store } = setup(t);
  const source = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  store.mutate((state) => { state.avatar = { format: "niria-avatar-prototype", version: 1, source, actions: {} }; });
  const first = store.avatarKey;
  store.mutate((state) => { state.avatar = { ...state.avatar, actions: { blink: source } }; });
  assert.notEqual(store.avatarKey, first);
  assert.equal(store.avatarKey, store.avatarKey);
});

test("companion API protects local state and supports the complete chat, memory and backup flow", async (t) => {
  const { store, service } = setup(t, { completion: async () => "很高兴认识你。" });
  const server = createPrototypeServer({ store, companion: service });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/state`)).status, 403);
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  assert.match(await (await fetch(base)).text(), /在这里，慢慢相处/);
  assert.match(await (await fetch(`${base}/avatar`)).text(), /NIRIA 形象实验台/);
  const connected = await post("/api/connection", config);
  assert.equal(JSON.stringify(connected).includes(config.apiKey), false);
  await post("/api/connection", { ...config, apiKey: "", reuseSecret: true });
  assert.equal(service.connection.apiKey, config.apiKey);
  const publicConfig = await (await fetch(`${base}/api/connections`, { headers: { "X-Niria-Token": token } })).json();
  assert.equal(publicConfig.chat.hasSecret, true);
  assert.equal(JSON.stringify(publicConfig).includes(config.apiKey), false);
  await post("/api/settings", { autoMemory: false });
  assert.deepEqual(await post("/api/chat", { content: "你好" }), { ok: true });
  assert.equal(store.state.messages.length, 2);
  await post("/api/memories/add", { content: "用户喜欢喝茶" });
  const backup = await post("/api/backup/export", { password: "test-backup-password" });
  assert.equal(JSON.stringify(backup).includes("test-secret-key"), false);
  await post("/api/backup/restore", { backup, password: "test-backup-password" });
  assert.equal(store.state.memories[0].content, "用户喜欢喝茶");
});
