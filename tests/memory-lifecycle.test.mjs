import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CompanionStore, messageHash, validMemory } from "../core/store.mjs";
import { CompanionService, buildContext } from "../core/chat-service.mjs";
import { SyncService, parsePairing } from "../core/sync-service.mjs";
import { cascadeDeletions } from "../core/deletion-cascade.mjs";
import { unseal } from "../core/sync-model.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { davFixture } from "./fixtures/dav.mjs";

const future = () => new Date(Date.now() + 86_400_000).toISOString();
const status = (code) => (error) => error.status === code;
function reply(parent, content) {
  return { id: randomUUID(), role: "assistant", content, replyTo: parent.id, revision: 1, deleted: false,
    status: "completed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function fixture(t, filename) {
  const store = new CompanionStore(filename);
  t.after(() => store.close());
  const root = store.addUser("需忘记的编号：秘密甲"), other = store.addUser("保留的另一条消息");
  const first = reply(root, "需忘记的回复甲"), second = reply(first, "需忘记的回复乙");
  // Reversed dependency order must not change deletion propagation.
  store.mutate((state) => { state.messages = [second, other, first, root]; });
  const memory = (content, messages) => store.addMemory({ content, sources: messages.map((item) => ({ id: item.id, revision: item.revision })) });
  const target = memory("需忘记的目标记忆", [root]);
  const related = [memory("需忘记的回复记忆甲", [first]), memory("需忘记的回复记忆乙", [second]),
    memory("需忘记的混合来源记忆", [root, other])];
  const retained = memory("保留的手动资料", []);
  return { store, root, other, first, second, target, related, retained };
}

test("forget preview reports the actual graph, paginates without writing, and leaves independent sources alone", (t) => {
  const { store, root, first, second, target, related, other, retained } = fixture(t);
  const before = store.snapshot(), writes = store.db.prepare("SELECT total_changes() AS n").get().n;
  let page = store.forgettingPreview({ id: target, limit: 2 }), items = [...page.items];
  assert.deepEqual(page.counts, { memories: 4, sourceMessages: 1, replies: 2, unavailableSources: 0 });
  const token = page.token;
  while (page.nextOffset !== null) {
    page = store.forgettingPreview({ id: target, token, offset: page.nextOffset, limit: 2 });
    items.push(...page.items);
  }
  assert.equal(new Set(items.map((item) => item.id)).size, 7);
  assert.deepEqual(items.map((item) => item.id).sort(), [root.id, first.id, second.id, target, ...related].sort());
  assert.equal(items.some((item) => [other.id, retained].includes(item.id)), false);
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, writes);
  assert.deepEqual(store.snapshot(), before);
  store.settings({ autoMemory: false });
  store.addMemory({ content: "另一件无关的事" });
  assert.equal(store.forgettingPreview({ id: target }).token, token);
  store.deleteMemory(target, true, token);
  assert.equal(store.state.messages.find((item) => item.id === other.id).deleted, false);
  assert.equal(store.state.memories.find((item) => item.id === retained).deleted, false);
  assert.equal(JSON.stringify(store.snapshot()).includes("需忘记"), false);
  assert.equal(store.state.messages.filter((item) => item.deleted).length, 3);
  assert.equal(store.state.memories.filter((item) => item.deleted).length, 4);
});

test("stale forget confirmation rejects new derivatives or changed source text without partial deletion", (t) => {
  const { store, root, target } = fixture(t);
  const initial = store.forgettingPreview({ id: target });
  store.addMemory({ content: "刚产生的衍生记忆", sources: [{ id: root.id, revision: 1 }] });
  const before = store.snapshot();
  assert.throws(() => store.deleteMemory(target, true, initial.token), status(409));
  assert.deepEqual(store.snapshot(), before);
  assert.throws(() => store.forgettingPreview({ id: target, token: initial.token, offset: 1 }), status(409));
  const next = store.forgettingPreview({ id: target });
  store.mutate((state) => { state.messages.find((item) => item.id === root.id).content = "同修订的新正文"; });
  assert.throws(() => store.deleteMemory(target, true, next.token), status(409));
});

test("forget handles unavailable sources and all known conflict variants, and ordinary deletion retains raw chat", (t) => {
  const { store, target, root, other } = fixture(t);
  const original = structuredClone(store.state.memories.find((item) => item.id === target));
  store.mutate((state) => {
    const current = state.memories.find((item) => item.id === target);
    current.conflicted = true;
    state.conflicts = [{ key: `memory:${target}`, kind: "memory", id: target, candidates: [
      { id: randomUUID(), device: randomUUID(), at: original.createdAt, value: original },
      { id: randomUUID(), device: randomUUID(), at: original.createdAt, value: { ...original, content: "另一分支", sources: [{ id: other.id, revision: 1 }] } }
    ] }];
  });
  const plan = store.forgettingPreview({ id: target });
  assert.equal(plan.counts.sourceMessages, 2);
  store.deleteMemory(target, true, plan.token);
  assert.equal(store.state.conflicts.length, 0);
  assert.equal(store.state.messages.find((item) => item.id === other.id).deleted, true);
  const isolated = store.addUser("只删除记忆时保留的原文");
  const memory = store.addMemory({ content: "单独删除的记忆", sources: [{ id: isolated.id, revision: 1 }] });
  store.deleteMemory(memory);
  assert.equal(store.findMessage(isolated.id).content, isolated.content);
  const unavailable = store.addMemory({ content: "之后来源丢失", sources: [{ id: isolated.id, revision: 1 }] });
  store.mutate((state) => { state.messages = state.messages.filter((item) => item.id !== isolated.id); });
  const preview = store.forgettingPreview({ id: unavailable });
  assert.equal(preview.counts.unavailableSources, 1);
  store.deleteMemory(unavailable, true, preview.token);
  assert.equal(store.state.tombstones.some((item) => item.id === isolated.id && item.forget), true);
  assert.equal(store.state.tombstones.some((item) => item.id === root.id && item.forget), true);
});

test("cascade is independent of record order, upgrades weak markers, terminates cycles and unions source blockers", () => {
  const at = new Date().toISOString();
  const records = [
    { kind: "message", id: "child", values: [{ replyTo: "parent" }] },
    { kind: "message", id: "parent", values: [{ replyTo: "root" }] },
    { kind: "message", id: "cycle", values: [{ replyTo: "child" }, { replyTo: "cycle" }] },
    { kind: "memory", id: "derived", values: [{ sources: [{ id: "cycle" }, { id: "other" }] }] },
    { kind: "memory", id: "deleted", values: [{ sources: [{ id: "new-source" }] }] }
  ];
  const roots = [{ type: "message", id: "root", at, forget: true }, { type: "message", id: "parent", at },
    { type: "memory", id: "deleted", sources: ["old-source"], at }];
  const forward = cascadeDeletions(records, roots, at), backward = cascadeDeletions([...records].reverse(), roots, at);
  for (const result of [forward, backward]) {
    for (const id of ["root", "parent", "child", "cycle"]) assert.equal(result.markers.get(`message:${id}`).forget, true);
    assert.deepEqual(result.markers.get("memory:derived").sources, ["cycle", "other"]);
    assert.deepEqual(result.markers.get("memory:deleted").sources, ["new-source", "old-source"]);
    assert.equal(cascadeDeletions(records, [...result.markers.values()], at).changes.length, 0);
  }
});

test("restoring an older encrypted backup also erases previously unseen replies and their derived memories", async (t) => {
  const { store, target, second } = fixture(t);
  const older = store.exportData(), unseen = reply(second, "需忘记的备份独有回复");
  older.messages.push(unseen);
  const template = older.memories.find((item) => item.id === target);
  older.memories.push({ ...template, id: randomUUID(), content: "需忘记的备份独有记忆",
    sources: [{ id: unseen.id, revision: 1, hash: messageHash(unseen) }] });
  const encrypted = await encryptBackup(older, "isolated-forget-backup");
  store.deleteMemory(target, true);
  store.restore(await decryptBackup(encrypted, "isolated-forget-backup"));
  assert.equal(JSON.stringify(store.snapshot()).includes("需忘记"), false);
  assert.equal(store.state.messages.find((item) => item.id === unseen.id).deleted, true);
  assert.equal(store.state.tombstones.find((item) => item.id === unseen.id).forget, true);
});

test("older incomplete forget state is repaired on reopen together with the local sync journal", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "niria-forget-"));
  t.after(() => {
    assert.ok(resolve(folder).startsWith(`${resolve(tmpdir())}${sep}`));
    rmSync(folder, { force: true, recursive: true });
  });
  const path = join(folder, "companion.sqlite"), first = new CompanionStore(path), sync = new SyncService(first);
  sync.createPair();
  const root = first.addUser("需忘记的旧版正文"), child = reply(root, "需忘记的旧版回复");
  first.mutate((state) => { state.messages.push(child); });
  first.addMemory({ content: "需忘记的旧版衍生记忆", sources: [{ id: child.id, revision: 1 }] });
  const staleMetadata = structuredClone(sync.meta);
  first.mutate((state) => { state.tombstones.push({ type: "message", id: root.id, at: new Date().toISOString(), forget: true }); });
  sync.meta = staleMetadata; sync.persist(); first.close();
  const reopened = new CompanionStore(path);
  try {
    const restoredSync = new SyncService(reopened);
    assert.equal(JSON.stringify(reopened.snapshot()).includes("需忘记"), false);
    assert.equal(JSON.stringify(restoredSync.meta).includes("需忘记"), false);
    assert.equal(reopened.history.page().total, 0);
  } finally { reopened.close(); }
});

test("sync purges unseen nested derivatives even through a peer's previously deleted reply", async (t) => {
  const dav = await davFixture(); t.after(() => dav.close());
  const a = new CompanionStore(), b = new CompanionStore();
  t.after(() => { a.close(); b.close(); });
  const x = new SyncService(a), y = new SyncService(b);
  for (const sync of [x, y]) sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const root = a.addUser("需忘记的跨端正文");
  const target = a.addMemory({ content: "需忘记的跨端记忆", sources: [{ id: root.id, revision: 1 }] });
  const code = x.createPair().code;
  await x.sync(); await y.join(code);
  const first = reply(root, "需忘记的离线回复甲"), second = reply(first, "需忘记的离线回复乙");
  b.mutate((state) => { state.messages.push(second, first); });
  const derived = b.addMemory({ content: "需忘记的离线衍生记忆", sources: [{ id: second.id, revision: 1 }] });
  b.deleteMessage(first.id);
  assert.equal(b.state.memories.find((item) => item.id === derived).deleted, false);
  a.deleteMemory(target, true);
  await x.sync(); await y.sync(); await x.sync();
  for (const store of [a, b]) assert.equal(JSON.stringify(store.snapshot()).includes("需忘记"), false);
  for (const sync of [x, y]) assert.equal(JSON.stringify(sync.meta).includes("需忘记"), false);
  const pair = parsePairing(code);
  const manifest = unseal([...dav.objects.values()][0].data.toString(), pair.key, pair.vaultId, pair.identityId);
  assert.equal(JSON.stringify(manifest).includes("需忘记"), false);
});

test("failed forgetting rolls back state, SQL, history revision and sync metadata", (t) => {
  const { store, target } = fixture(t), sync = new SyncService(store);
  sync.createPair();
  const state = store.snapshot(), meta = structuredClone(sync.meta), revision = store.messageVersion;
  store.db.exec("CREATE TEMP TRIGGER fail_forgetting BEFORE UPDATE ON main.sync_meta BEGIN SELECT RAISE(ABORT,'isolated rollback'); END");
  assert.throws(() => store.deleteMemory(target, true, store.forgettingPreview({ id: target }).token), /isolated rollback/);
  assert.deepEqual(store.snapshot(), state);
  assert.deepEqual(sync.meta, meta);
  assert.equal(store.messageVersion, revision);
  assert.equal(store.history.page({ query: "需忘记" }).totalMatches, 3);
});

test("editing memory type or expiry preserves source provenance; changing text explicitly replaces it", (t) => {
  const { store, target } = fixture(t);
  const original = structuredClone(store.state.memories.find((item) => item.id === target));
  store.editMemory(target, { kind: "experience", expiresAt: future() });
  let memory = store.state.memories.find((item) => item.id === target);
  assert.deepEqual(memory.sources, original.sources);
  assert.equal(memory.confirmed, original.confirmed);
  assert.equal(memory.kind, "experience");
  assert.ok(Date.parse(memory.expiresAt) > Date.now());
  store.editMemory(target, { expiresAt: null });
  store.editMemory(target, { content: "手动纠正的资料", kind: "inference" });
  memory = store.state.memories.find((item) => item.id === target);
  assert.deepEqual(memory.sources, []);
  assert.equal(memory.confirmed, true);
  assert.equal(memory.expiresAt, null);
});

test("invalid lifetime changes are atomic and extending a deadline cannot revive withdrawn sources", (t) => {
  const { store, target, root } = fixture(t), original = store.snapshot();
  for (const expiresAt of ["invalid", "", false, {}, "2020-01-01T00:00:00Z"]) {
    assert.throws(() => store.editMemory(target, { content: "不应保存", expiresAt }), status(400));
    assert.deepEqual(store.snapshot(), original);
  }
  assert.throws(() => store.editMemory(target, { kind: "other" }), status(400));
  store.deleteMessage(root.id);
  store.editMemory(target, { expiresAt: future() });
  const memory = store.state.memories.find((item) => item.id === target);
  assert.equal(memory.invalidated, true);
  assert.equal(validMemory(store.state, memory), false);
  assert.equal(buildContext(store.state).refs.memoryRefs.some((ref) => ref.id === target), false);
  store.mutate((state) => { state.memories.find((item) => item.id === target).conflicted = true; });
  assert.throws(() => store.editMemory(target, { expiresAt: null }), status(409));
});

test("editing from an obsolete memory form cannot overwrite same-revision changed text", (t) => {
  const { store, target } = fixture(t);
  const expected = structuredClone(store.state.memories.find((item) => item.id === target));
  store.mutate((state) => { state.memories.find((item) => item.id === target).content = "已收到的另一个版本"; });
  assert.throws(() => store.editMemory(target, { expected, content: "过期编辑内容", expiresAt: future() }), status(409));
  assert.equal(store.state.memories.find((item) => item.id === target).content, "已收到的另一个版本");
});

test("a response already in flight is discarded if a cited temporary memory expires", async (t) => {
  const store = new CompanionStore(); t.after(() => store.close());
  const deadline = Date.now() + 1000;
  const memory = store.addMemory({ content: "只在短期有效的安排", expiresAt: new Date(deadline).toISOString() });
  let finish, entered;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const companion = new CompanionService(store, { completion: async () => { entered(); return waiting; } });
  companion.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "isolated" });
  store.settings({ autoMemory: false });
  const pending = companion.send({ content: "我们有什么安排？" });
  await started;
  assert.equal(store.state.messages.at(-1).context.memoryRefs.some((item) => item.id === memory), true);
  t.mock.method(Date, "now", () => deadline + 1);
  finish("根据已过期的安排回复");
  await assert.rejects(pending, status(409));
  assert.equal(store.state.messages.some((item) => item.content === "根据已过期的安排回复"), false);
});

test("expiry metadata survives encrypted recovery and sync and is excluded at its actual deadline", async (t) => {
  const dav = await davFixture(); t.after(() => dav.close());
  const a = new CompanionStore(), b = new CompanionStore();
  t.after(() => { a.close(); b.close(); });
  const memory = a.addMemory({ content: "临时共同安排", kind: "experience", expiresAt: future() });
  const x = new SyncService(a), y = new SyncService(b);
  for (const sync of [x, y]) sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const code = x.createPair().code;
  await x.sync(); await y.join(code);
  const item = b.state.memories.find((entry) => entry.id === memory);
  assert.equal(item.expiresAt, a.state.memories[0].expiresAt);
  assert.equal(validMemory(b.state, item, Date.parse(item.expiresAt) - 1), true);
  assert.equal(validMemory(b.state, item, Date.parse(item.expiresAt)), false);
  const backup = await encryptBackup(a.exportData(), "isolated-expiry-backup");
  b.restore(await decryptBackup(backup, "isolated-expiry-backup"));
  assert.equal(b.state.memories[0].kind, "experience");
  assert.equal(b.state.memories[0].expiresAt, a.state.memories[0].expiresAt);
});

test("HTTP preview and final forgetting require token/origin and a matching review, without model calls", async (t) => {
  const { store, target } = fixture(t);
  let calls = 0;
  const companion = new CompanionService(store, { completion: async () => { calls++; return "unused"; } });
  const server = createPrototypeServer({ store, companion });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const post = (path, body, extra = {}) => fetch(`${base}${path}`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Niria-Token": token, ...extra }, body: JSON.stringify(body) });
  const path = "/api/memories/forget-preview";
  assert.equal((await post(path, { id: target }, { "X-Niria-Token": "" })).status, 403);
  assert.equal((await post(path, { id: target }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await post(path, { id: target, limit: 101 })).status, 400);
  assert.equal((await post("/api/memories/delete", { id: target, forgetSources: true })).status, 400);
  const preview = await (await post(path, { id: target })).json();
  assert.equal((await post("/api/memories/delete", { id: target, forgetSources: true, previewToken: "f".repeat(64) })).status, 409);
  assert.equal((await post("/api/memories/delete", { id: target, forgetSources: true, previewToken: preview.token })).status, 200);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(store.snapshot()).includes("需忘记"), false);
});
