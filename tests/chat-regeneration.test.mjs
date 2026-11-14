import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanionStore, messageHash, validMemory } from "../core/store.mjs";
import { CompanionService, buildContext } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { davFixture } from "./fixtures/dav.mjs";

const config = { baseUrl: "http://127.0.0.1:9/v1", model: "regeneration-fixture" };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t, options = {}) {
  const store = new CompanionStore(options.filename);
  t.after(() => store.close());
  store.settings({ autoMemory: false });
  const service = new CompanionService(store, { completion: async () => "隔离测试：原来可用的回复", ...options });
  service.configure(config);
  await service.send({ content: "隔离测试：今天一起聊了茶" });
  const user = structuredClone(store.state.messages[0]), original = structuredClone(store.state.messages[1]);
  const memoryId = store.addMemory({ content: "隔离测试：依赖原回复的资料",
    sources: [{ id: original.id, revision: original.revision, hash: messageHash(original) }] });
  const memory = structuredClone(store.state.memories.find((item) => item.id === memoryId));
  const otherId = store.addMemory({ content: "隔离测试：独立资料" });
  const other = structuredClone(store.state.memories.find((item) => item.id === otherId));
  const waiting = deferred(), entered = deferred(), calls = [];
  service.completion = async (_, messages, { signal }) => {
    calls.push(structuredClone(messages)); entered.resolve(signal);
    return waiting.promise;
  };
  return { store, service, user, original, memory, other, waiting, entered, calls };
}
function preserved({ store, original, memory, other }) {
  assert.deepEqual(store.state.messages.find((item) => item.id === original.id), original);
  assert.deepEqual(store.state.memories.find((item) => item.id === memory.id), memory);
  assert.deepEqual(store.state.memories.find((item) => item.id === other.id), other);
  assert.equal(store.state.tombstones.some((item) => item.id === original.id), false);
  assert.equal(validMemory(store.state, store.state.memories.find((item) => item.id === memory.id)), true);
}

test("regeneration keeps original data while the request excludes old replies and their dependent memories", async (t) => {
  const f = await fixture(t), { store, service, user, original, memory, calls, entered, waiting } = f;
  const before = store.exportData(), pending = service.send({ retryId: user.id });
  await entered.promise;
  preserved(f);
  assert.equal(JSON.stringify(calls).includes(original.content), false);
  assert.equal(JSON.stringify(calls).includes(memory.content), false);
  assert.equal(calls[0].at(-1).content, user.content);
  assert.equal(store.state.messages.filter((item) => item.role === "user" && !item.deleted).length, 1);
  const backup = await encryptBackup(store.exportData(), "isolated-regeneration-backup");
  const recovered = await decryptBackup(backup, "isolated-regeneration-backup");
  assert.deepEqual(recovered.messages.find((item) => item.id === original.id), original);
  waiting.reject(new Error("isolated provider failure"));
  await assert.rejects(pending, /isolated provider failure/);
  preserved(f);
  assert.equal(store.state.messages.at(-1).status, "failed");
  assert.match(store.state.messages.at(-1).error, /原回复已保留/);
  assert.deepEqual(store.state.tombstones, before.tombstones);
  assert.equal(calls.length, 1);
  assert.equal(service.active, null);
});

for (const reason of ["cancel", "timeout"]) test(`${reason} retains the original reply without automatic retries`, async (t) => {
  const f = await fixture(t), { store, service, user, entered, waiting, calls } = f;
  if (reason === "timeout") service.timeoutMs = 15;
  const pending = service.send({ retryId: user.id });
  const signal = await entered.promise;
  if (reason === "cancel") service.cancel();
  else if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  waiting.resolve("不应提交的迟到回复");
  await assert.rejects(pending, /已停止或超时/);
  preserved(f);
  assert.equal(store.state.messages.at(-1).status, "cancelled");
  assert.equal(store.state.messages.some((item) => item.content === "不应提交的迟到回复"), false);
  assert.equal(calls.length, 1);
  assert.equal(service.active, null);
});

test("successful replacement deletes original replies and invalidates dependent memories in one commit", async (t) => {
  const f = await fixture(t), { store, service, user, original, memory, other, entered, waiting } = f;
  const sync = new SyncService(store); sync.createPair();
  const before = store.exportData();
  const observations = [];
  store.listeners.add(() => observations.push([store.state.messages.find((item) => item.id === original.id).deleted,
    store.state.messages.at(-1).status]));
  const pending = service.send({ retryId: user.id });
  await entered.promise;
  preserved(f);
  waiting.resolve("隔离测试：已接受的新回复");
  await pending;
  assert.equal(observations.some(([deleted, status]) => deleted && status !== "completed"), false);
  assert.equal(store.state.messages.find((item) => item.id === original.id).deleted, true);
  assert.equal(store.state.messages.find((item) => item.id === original.id).content, "");
  assert.equal(store.state.memories.find((item) => item.id === memory.id).invalidated, true);
  assert.deepEqual(store.state.memories.find((item) => item.id === other.id), other);
  assert.equal(store.state.messages.at(-1).content, "隔离测试：已接受的新回复");
  assert.equal(JSON.stringify(buildContext(store.state)).includes(memory.content), false);
  assert.equal(sync.meta.manifest.records.some((item) => item.id === original.id && item.kind === "message"), false);
  assert.ok(sync.meta.manifest.tombstones.some((item) => item.id === original.id && item.type === "message"));
  assert.equal(JSON.stringify(sync.meta.manifest).includes(original.content), false);
  store.restore(before);
  assert.equal(store.state.messages.find((item) => item.id === original.id).deleted, true);
  assert.equal(JSON.stringify(buildContext(store.state)).includes(original.content), false);
});

test("replacement commit failure rolls back deletion, memory changes and sync revisions", async (t) => {
  const f = await fixture(t), { store, service, user, original, entered, waiting } = f;
  const sync = new SyncService(store); sync.createPair();
  const rejectCommit = () => { if (store.state.messages.find((item) => item.id === original.id).deleted) throw new Error("isolated commit failure"); };
  store.listeners.add(rejectCommit);
  const pending = service.send({ retryId: user.id });
  await entered.promise;
  waiting.resolve("不应提交的替换");
  await assert.rejects(pending, /isolated commit failure/);
  preserved(f);
  assert.equal(store.state.messages.at(-1).status, "failed");
  assert.equal(JSON.stringify(store.snapshot()).includes("不应提交的替换"), false);
  const record = sync.meta.manifest.records.find((item) => item.id === original.id && item.kind === "message");
  assert.ok(record.heads.every((head) => head.value?.content === original.content));
  assert.equal(store.db.prepare("SELECT json_extract(data, '$.content') AS content FROM message_records WHERE id=?").get(original.id).content, original.content);
});

for (const action of ["editUser", "deleteOriginal", "changeOriginal", "newUser"]) {
  test(`concurrent ${action} rejects a late replacement without overwriting user changes`, async (t) => {
    const f = await fixture(t), { store, service, user, original, entered, waiting } = f;
    const pending = service.send({ retryId: user.id });
    await entered.promise;
    if (action === "editUser") store.editMessage(user.id, "已修改的最新消息");
    if (action === "deleteOriginal") store.deleteMessage(original.id);
    if (action === "changeOriginal") store.mutate((state) => {
      state.messages.find((item) => item.id === original.id).content = "另一版本的原回复";
    });
    if (action === "newUser") store.addUser("之后新增的消息");
    const latest = structuredClone(store.state.messages.find((item) => item.id === original.id));
    waiting.resolve("不应覆盖的旧结果");
    await assert.rejects(pending, /已经改变|已经变化/);
    assert.deepEqual(store.state.messages.find((item) => item.id === original.id), latest);
    assert.equal(store.state.messages.some((item) => item.content === "不应覆盖的旧结果"), false);
  });
}

test("forgetting sources during regeneration removes both original and pending without late resurrection", async (t) => {
  const f = await fixture(t), { store, service, user, original, entered, waiting } = f;
  const memoryId = store.addMemory({ content: "要忘记的来源", sources: [{ id: user.id, revision: user.revision }] });
  const pending = service.send({ retryId: user.id });
  await entered.promise;
  store.deleteMemory(memoryId, true);
  waiting.resolve("遗忘之后的迟到回复");
  await assert.rejects(pending, /来源已经改变/);
  assert.equal(store.state.messages.filter((item) => !item.deleted).length, 0);
  assert.equal(JSON.stringify(store.snapshot()).includes(original.content), false);
  assert.equal(JSON.stringify(store.snapshot()).includes("遗忘之后的迟到回复"), false);
});

test("a later successful retry replaces failed attempts without adding user messages", async (t) => {
  const f = await fixture(t), { store, service, user, original, waiting, entered } = f;
  const first = service.send({ retryId: user.id });
  await entered.promise;
  waiting.reject(new Error("first attempt failed"));
  await assert.rejects(first);
  const failed = store.state.messages.at(-1).id;
  service.completion = async () => "后一次成功的回复";
  await service.send({ retryId: user.id });
  assert.equal(store.state.messages.find((item) => item.id === failed).deleted, true);
  assert.equal(store.state.messages.find((item) => item.id === original.id).deleted, true);
  assert.deepEqual(store.state.messages.filter((item) => !item.deleted).map((item) => item.content),
    [user.content, "后一次成功的回复"]);
});

test("empty regeneration output retains the usable original reply", async (t) => {
  const f = await fixture(t), { service, user, entered, waiting } = f;
  const pending = service.send({ retryId: user.id });
  await entered.promise;
  waiting.resolve(" \n ");
  await assert.rejects(pending, /没有聊天正文/);
  preserved(f);
});

test("HTTP WebDAV peers retain originals on failed regeneration and converge on successful replacement", async (t) => {
  const f = await fixture(t), { store, service, user, original, entered, waiting } = f;
  const dav = await davFixture(); t.after(() => dav.close());
  const peer = new CompanionStore(); t.after(() => peer.close());
  const localSync = new SyncService(store), peerSync = new SyncService(peer);
  for (const sync of [localSync, peerSync]) sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const { code } = localSync.createPair();
  await localSync.sync(); await peerSync.join(code);
  const pending = service.send({ retryId: user.id });
  await entered.promise;
  await localSync.sync(); await peerSync.sync();
  assert.equal(peer.state.messages.find((item) => item.id === original.id).content, original.content);
  waiting.reject(new Error("isolated failure")); await assert.rejects(pending);
  await localSync.sync(); await peerSync.sync();
  assert.equal(peer.state.messages.find((item) => item.id === original.id).content, original.content);
  service.completion = async () => "同步后采用的新回复";
  await service.send({ retryId: user.id });
  await localSync.sync(); await peerSync.sync(); await localSync.sync();
  assert.equal(peer.state.messages.find((item) => item.id === original.id).deleted, true);
  assert.equal(JSON.stringify(peer.state.conflicts).includes(original.content), false);
  assert.deepEqual(peer.state.messages.filter((item) => !item.deleted).map((item) => item.content),
    [user.content, "同步后采用的新回复"]);
  assert.equal(peer.state.conflicts.length, 0);
});

test("interrupted regeneration preserves original data through actual SQLite reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niria-regeneration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "companion.sqlite");
  const store = new CompanionStore(filename);
  store.settings({ autoMemory: false });
  const service = new CompanionService(store, { completion: async () => "重启前的原回复" }); service.configure(config);
  await service.send({ content: "重启前的消息" });
  const original = structuredClone(store.state.messages.at(-1));
  store.mutate((state) => state.messages.push({ id: randomUUID(), role: "assistant", content: "", revision: 1,
    status: "pending", deleted: false, replyTo: state.messages[0].id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  store.close();
  const reopened = new CompanionStore(filename);
  try {
    assert.deepEqual(reopened.state.messages.find((item) => item.id === original.id), original);
    assert.equal(reopened.state.messages.at(-1).status, "failed");
    assert.equal(reopened.state.tombstones.some((item) => item.id === original.id), false);
    assert.equal(reopened.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { reopened.close(); }
});

test("older or conflicted user messages cannot start regeneration or delete replies", async (t) => {
  const f = await fixture(t), { store, service, user, calls } = f;
  const latest = store.addUser("当前最近的消息");
  const before = store.snapshot();
  await assert.rejects(service.send({ retryId: user.id }), /只能重试/);
  assert.deepEqual(store.snapshot(), before);
  store.mutate((state) => { state.messages.find((item) => item.id === latest.id).conflicted = true; });
  const conflicted = store.snapshot();
  await assert.rejects(service.send({ retryId: latest.id }), /只能重试/);
  assert.deepEqual(store.snapshot(), conflicted);
  assert.equal(calls.length, 0);
});
