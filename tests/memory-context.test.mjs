import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CompanionStore, validMemory } from "../core/store.mjs";
import { CompanionService, buildContext } from "../core/chat-service.mjs";
import { project } from "../core/sync-model.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { davFixture } from "./fixtures/dav.mjs";

const config = { baseUrl: "http://127.0.0.1:9/v1", model: "memory-context-fixture" };
const secret = "旧偏好编号：桂花乌龙茶";
async function fixture(t) {
  const store = new CompanionStore();
  t.after(() => store.close());
  store.settings({ autoMemory: false });
  const source = store.addUser(secret);
  const memoryId = store.addMemory({ content: secret, sources: [{ id: source.id, revision: source.revision }] });
  const unrelatedId = store.addMemory({ content: "保留的独立资料：喜欢散步" });
  const companion = new CompanionService(store, { completion: async () => `根据记忆，${secret}。` });
  companion.configure(config);
  await companion.send({ content: "你还记得我的偏好吗？" });
  const reply = structuredClone(store.state.messages.at(-1));
  const derivedId = store.addMemory({
    content: `从较晚回复整理：${secret}`, sources: [{ id: reply.id, revision: reply.revision }]
  });
  return { store, source, memoryId, unrelatedId, companion, reply, derivedId };
}
const sent = (context, id) => context.refs.messageRefs.some((ref) => ref.id === id);
const recalled = (context, id) => context.refs.memoryRefs.some((ref) => ref.id === id);

test("withdrawing model permission excludes later citing replies and their derived memories while retaining local dialogue", async (t) => {
  const { store, source, memoryId, unrelatedId, reply, derivedId } = await fixture(t);
  store.editMemory(memoryId, { allowModel: false, allowSync: true });
  const context = buildContext(store.state);
  assert.equal(sent(context, reply.id), false);
  assert.equal(sent(context, source.id), false);
  assert.equal(recalled(context, derivedId), false);
  assert.equal(JSON.stringify(context.messages).includes(secret), false);
  assert.equal(recalled(context, unrelatedId), true);
  assert.equal(store.findMessage(reply.id).content, reply.content);
  assert.equal(validMemory(store.state, store.state.memories.find((memory) => memory.id === derivedId)), true);
  assert.ok(project(store.state).get(`message:${reply.id}`).value);
  assert.ok(project(store.state).get(`memory:${derivedId}`).value);
});

test("withdrawing sync permission excludes citing replies and derivatives independently of model permission", async (t) => {
  const { store, memoryId, reply, derivedId } = await fixture(t);
  store.editMemory(memoryId, { allowSync: false, allowModel: true });
  const projection = project(store.state);
  assert.equal(projection.get(`message:${reply.id}`).value, null);
  assert.equal(projection.get(`memory:${derivedId}`).value, null);
  assert.equal(sent(buildContext(store.state), reply.id), true);
  assert.equal(recalled(buildContext(store.state), derivedId), true);
  store.editMemory(memoryId, { allowSync: true });
  assert.ok(project(store.state).get(`message:${reply.id}`).value);
  assert.ok(project(store.state).get(`memory:${derivedId}`).value);
});

test("correcting a memory excludes a later old-version citation and invalidates its derived memory", async (t) => {
  const { store, memoryId, reply, derivedId, unrelatedId } = await fixture(t);
  store.editMemory(memoryId, { content: "新偏好编号：茉莉绿茶" });
  const context = buildContext(store.state);
  assert.equal(sent(context, reply.id), false);
  assert.equal(recalled(context, derivedId), false);
  assert.equal(recalled(context, memoryId), true);
  assert.equal(recalled(context, unrelatedId), true);
  assert.equal(JSON.stringify(context.messages).includes(secret), false);
  assert.equal(store.state.memories.find((memory) => memory.id === derivedId).invalidated, true);
});

test("ordinary memory deletion suppresses quoted reuse while leaving its raw source and local reply available", async (t) => {
  const { store, source, memoryId, reply, derivedId } = await fixture(t);
  store.deleteMemory(memoryId);
  const context = buildContext(store.state);
  assert.equal(sent(context, reply.id), false);
  assert.equal(recalled(context, derivedId), false);
  assert.equal(sent(context, source.id), true);
  assert.equal(store.findMessage(reply.id).content, reply.content);
  assert.equal(store.findMessage(source.id).content, source.content);
});

test("forgetting suppresses later citations without silently expanding the confirmed physical deletion scope", async (t) => {
  const { store, memoryId, reply, derivedId } = await fixture(t);
  const preview = store.forgettingPreview({ id: memoryId });
  assert.equal(preview.items.some((item) => item.id === reply.id), false);
  store.deleteMemory(memoryId, true, preview.token);
  const context = buildContext(store.state);
  assert.equal(sent(context, reply.id), false);
  assert.equal(recalled(context, derivedId), false);
  assert.equal(JSON.stringify(context.messages).includes(secret), false);
  assert.equal(store.findMessage(reply.id).content, reply.content);
  assert.equal(store.state.tombstones.some((item) => item.id === reply.id), false);
});

test("metadata-only changes keep an otherwise valid historical citation usable", async (t) => {
  const { store, memoryId, reply, derivedId } = await fixture(t);
  const reference = reply.context.memoryRefs.find((ref) => ref.id === memoryId);
  assert.match(reference.contentHash || "", /^[a-f0-9]{64}$/);
  store.editMemory(memoryId, { confirmed: false, kind: "experience", expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(sent(buildContext(store.state), reply.id), true);
  assert.equal(validMemory(store.state, store.state.memories.find((memory) => memory.id === derivedId)), true);
});

for (const condition of ["expired", "missing", "conflicted", "sourceEdited"]) {
  test(`${condition} memory cannot return via its historical citation or derivative`, async (t) => {
    const { store, source, memoryId, reply, derivedId } = await fixture(t);
    store.mutate((state) => {
      const memory = state.memories.find((item) => item.id === memoryId);
      if (condition === "expired") memory.expiresAt = "2000-01-01T00:00:00Z";
      if (condition === "missing") state.memories = state.memories.filter((item) => item.id !== memoryId);
      if (condition === "conflicted") memory.conflicted = true;
      if (condition === "sourceEdited") state.messages.find((item) => item.id === source.id).content = "同修订不同来源正文";
    });
    const context = buildContext(store.state);
    assert.equal(sent(context, reply.id), false);
    assert.equal(recalled(context, derivedId), false);
  });
}

test("permission propagation follows alternating explicit memory citations and sources without following unrelated context", async (t) => {
  const { store, memoryId, reply, derivedId } = await fixture(t);
  const at = new Date().toISOString(), nextReply = {
    id: randomUUID(), role: "assistant", content: `第二层引用：${secret}`, revision: 1, deleted: false,
    status: "completed", createdAt: at, updatedAt: at,
    context: { personaRevision: 1, model: "fixture", messageRefs: [], memoryRefs: [{ id: derivedId, revision: 1 }] }
  };
  const independent = { ...nextReply, id: randomUUID(), content: "独立回复，不包含偏好",
    context: { ...nextReply.context, memoryRefs: [], messageRefs: [{ id: reply.id, revision: reply.revision }] } };
  store.mutate((state) => { state.messages.push(nextReply, independent); });
  const secondDerived = store.addMemory({ content: `第二层衍生：${secret}`, sources: [{ id: nextReply.id, revision: 1 }] });
  store.editMemory(memoryId, { allowModel: false });
  const context = buildContext(store.state);
  for (const id of [reply.id, nextReply.id]) assert.equal(sent(context, id), false);
  for (const id of [derivedId, secondDerived]) assert.equal(recalled(context, id), false);
  assert.equal(sent(context, independent.id), true);
});

test("a late response using an old citing reply is rejected even when the original memory was not recalled", async (t) => {
  const { store, source, memoryId, companion, reply, derivedId } = await fixture(t);
  store.deleteMemory(derivedId);
  store.mutate((state) => {
    const at = new Date().toISOString();
    state.messages.splice(1, 0, ...Array.from({ length: 26 }, (_, index) => ({
      id: randomUUID(), role: "user", content: `隔离本地占位 ${index}`, revision: 1, deleted: false,
      status: "completed", createdAt: at, updatedAt: at
    })));
  });
  for (let index = 0; index < 40; index++) store.addMemory({ content: `较新独立资料 ${index}` });
  store.mutate((state) => { state.memories.find((item) => item.id === memoryId).updatedAt = "2000-01-01T00:00:00Z"; });
  let finish, enter;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  companion.completion = async () => { enter(); return waiting; };
  const pending = companion.send({ content: "你好" });
  await entered;
  const context = store.state.messages.at(-1).context;
  assert.equal(context.memoryRefs.some((ref) => ref.id === memoryId), false);
  assert.equal(context.messageRefs.some((ref) => ref.id === source.id), false);
  assert.equal(context.messageRefs.some((ref) => ref.id === reply.id), true);
  store.editMemory(memoryId, { allowModel: false });
  finish("依赖已撤权旧引用的迟到回复");
  await assert.rejects(pending, (error) => error.status === 409);
  assert.equal(store.state.messages.some((message) => message.content === "依赖已撤权旧引用的迟到回复"), false);
});

test("legacy citation hashes use conservative version checks and malformed content hashes cannot enter restored data", async (t) => {
  const { store, memoryId, reply } = await fixture(t);
  store.mutate((state) => { delete state.messages.find((message) => message.id === reply.id).context.memoryRefs.find((ref) => ref.id === memoryId).contentHash; });
  assert.equal(sent(buildContext(store.state), reply.id), true);
  store.editMemory(memoryId, { content: "新偏好：茉莉绿茶" });
  assert.equal(sent(buildContext(store.state), reply.id), false);
  const data = store.exportData();
  data.messages.find((message) => message.id === reply.id).context.memoryRefs[0].contentHash = "not-a-digest";
  const before = store.snapshot();
  assert.throws(() => store.restore(data), (error) => error.status === 400);
  assert.deepEqual(store.snapshot(), before);
});

test("encrypted recovery preserves citation protections and separate permission choices", async (t) => {
  const { store, memoryId, reply, derivedId } = await fixture(t);
  store.editMemory(memoryId, { allowModel: false, allowSync: true });
  const encrypted = await encryptBackup(store.exportData(), "isolated-context-reference-backup");
  const fresh = new CompanionStore(); t.after(() => fresh.close());
  fresh.restore(await decryptBackup(encrypted, "isolated-context-reference-backup"));
  assert.equal(sent(buildContext(fresh.state), reply.id), false);
  assert.equal(recalled(buildContext(fresh.state), derivedId), false);
  assert.ok(project(fresh.state).get(`message:${reply.id}`).value);
});

test("history-only citations contribute expiry deadlines even when their memories are outside the selected thirty", async (t) => {
  const { store, memoryId, reply, derivedId } = await fixture(t);
  const deadline = Date.now() + 60_000;
  store.deleteMemory(derivedId);
  store.editMemory(memoryId, { expiresAt: new Date(deadline).toISOString() });
  store.mutate((state) => { state.memories.find((memory) => memory.id === memoryId).updatedAt = "2000-01-01T00:00:00Z"; });
  for (let index = 0; index < 40; index++) store.addMemory({ content: `不相关的近期资料 ${index}` });
  const context = buildContext(store.state, { query: "" });
  assert.equal(recalled(context, memoryId), false);
  assert.equal(sent(context, reply.id), true);
  assert.equal(context.validUntil, deadline);
  t.mock.method(Date, "now", () => deadline);
  assert.equal(sent(buildContext(store.state, { query: "" }), reply.id), false);
});

test("explicit citation cycles terminate and cannot reauthorize a denied memory through its own derivative", async (t) => {
  const { store, memoryId, reply, derivedId, unrelatedId } = await fixture(t);
  store.mutate((state) => {
    state.messages.find((message) => message.id === reply.id).context.memoryRefs.push({ id: derivedId, revision: 1 });
  });
  assert.equal(sent(buildContext(store.state), reply.id), true);
  store.editMemory(memoryId, { allowModel: false, allowSync: false });
  const context = buildContext(store.state);
  assert.equal(sent(context, reply.id), false);
  assert.equal(recalled(context, derivedId), false);
  assert.equal(recalled(context, unrelatedId), true);
  assert.equal(project(store.state).get(`memory:${derivedId}`).value, null);
});

test("actual HTTP WebDAV withdrawal removes later quotes and their derivatives from a fresh peer", async (t) => {
  const { store, memoryId, reply, derivedId } = await fixture(t);
  const dav = await davFixture(); t.after(() => dav.close());
  const sync = new SyncService(store);
  sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const code = sync.createPair().code;
  await sync.sync();
  store.editMemory(memoryId, { allowSync: false, allowModel: true });
  await sync.sync();
  const fresh = new CompanionStore(); t.after(() => fresh.close());
  const peer = new SyncService(fresh);
  peer.configure({ baseUrl: dav.baseUrl, auto: false });
  await peer.join(code);
  assert.equal(JSON.stringify(fresh.snapshot()).includes(secret), false);
  assert.equal(fresh.state.messages.some((message) => message.id === reply.id), false);
  assert.equal(fresh.state.memories.some((memory) => memory.id === derivedId), false);
  assert.equal(store.findMessage(reply.id).content, reply.content);
  assert.equal(sent(buildContext(store.state), reply.id), true);
});

for (const permission of ["allowModel", "allowSync"]) {
  test(`another fact directly extracted from the same user message retains its explicit ${permission} choice`, async (t) => {
    const { store, source, memoryId, reply, derivedId } = await fixture(t);
    const sibling = store.addMemory({
      content: "同一来源里单独允许的另一事实：喜欢晨间散步",
      sources: [{ id: source.id, revision: source.revision }]
    });
    store.editMemory(sibling, { [permission]: true });
    store.editMemory(memoryId, { [permission]: false });
    if (permission === "allowModel") {
      const context = buildContext(store.state);
      assert.equal(recalled(context, sibling), true);
      assert.equal(recalled(context, derivedId), false);
      assert.equal(sent(context, reply.id), false);
      assert.equal(sent(context, source.id), false);
    } else {
      const projection = project(store.state);
      assert.ok(projection.get(`memory:${sibling}`).value);
      assert.equal(projection.get(`memory:${derivedId}`).value, null);
      assert.equal(projection.get(`message:${reply.id}`).value, null);
      assert.equal(projection.get(`message:${source.id}`).value, null);
    }
  });
}
