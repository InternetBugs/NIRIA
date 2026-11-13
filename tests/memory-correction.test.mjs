import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CompanionStore, messageHash, validMemory, validateSnapshot } from "../core/store.mjs";
import { CompanionService, buildContext } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { project } from "../core/sync-model.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { davFixture } from "./fixtures/dav.mjs";

const status = (code) => (error) => error.status === code;
function fixture(t, filename) {
  const store = new CompanionStore(filename); t.after(() => store.close());
  const user = store.addUser("旧资料：我喜欢乌龙茶");
  const first = { ...user, id: randomUUID(), role: "assistant", replyTo: user.id, content: "旧回复：乌龙茶" };
  const second = { ...first, id: randomUUID(), replyTo: first.id, content: "旧后续回复：乌龙茶" };
  store.mutate((state) => { state.messages.push(second, first); });
  const input = { content: "旧记忆：喜欢乌龙茶", sources: [{ id: user.id, revision: 1, hash: messageHash(user) }] };
  const id = store.addMemory(input, { automatic: true });
  return { store, user, first, second, input, id };
}
const correct = (store, id) => store.editMemory(id, { content: "纠正资料：喜欢红茶" });
function deferred() { let finish; return { promise: new Promise((resolve) => { finish = resolve; }), finish: (value) => finish(value) }; }
function service(store, completion) {
  const companion = new CompanionService(store, { completion });
  companion.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "isolated" });
  return companion;
}

test("manual correction retains versioned associations, blocks old extraction and omits old reply chains from model context", (t) => {
  const { store, user, first, second, input, id } = fixture(t);
  const sibling = store.addMemory({ ...input, content: "同来源的另一条旧资料" }, { automatic: true });
  correct(store, id);
  const memory = store.state.memories.find((item) => item.id === id);
  assert.deepEqual(memory.sources, []);
  assert.deepEqual(memory.supersededSources, input.sources);
  assert.equal(memory.confirmed, true);
  assert.equal(validMemory(store.state, memory), true);
  assert.equal(validMemory(store.state, store.state.memories.find((item) => item.id === sibling)), false);
  assert.equal(store.state.memories.find((item) => item.id === sibling).invalidated, true);
  assert.equal(store.addMemory({ ...input, content: "再次整理的旧资料" }, { automatic: true }), null);
  assert.equal(store.addMemory({ content: "从旧回复整理", sources: [{ id: second.id, revision: 1 }] }, { automatic: true }), null);
  const context = buildContext(store.state);
  assert.match(context.messages[0].content, /纠正资料：喜欢红茶/);
  assert.equal(JSON.stringify(context).includes("乌龙茶"), false);
  assert.equal(context.refs.messageRefs.some((item) => [user.id, first.id, second.id].includes(item.id)), false);
  assert.equal(store.findMessage(user.id).content, user.content);
  const preview = store.memorySourcePreview(id, memory.revision);
  assert.equal(preview.supersededSources[0].id, user.id);
  assert.equal(preview.supersededSources[0].available, true);
  store.editMemory(id, { content: "再次纠正：喜欢红茶加牛奶", kind: "experience" });
  assert.deepEqual(store.state.memories.find((item) => item.id === id).supersededSources, input.sources);
});

test("unchanged text is metadata-only and a new version or genuinely new message remains usable", (t) => {
  const { store, user, input, id } = fixture(t);
  store.editMemory(id, { content: input.content, kind: "experience" });
  let memory = store.state.memories.find((item) => item.id === id);
  assert.deepEqual(memory.sources, input.sources);
  assert.equal(memory.confirmed, false);
  assert.equal(memory.supersededSources, undefined);
  correct(store, id);
  // Even an equal numeric revision with different text is a different source.
  store.mutate((state) => { state.messages.find((item) => item.id === user.id).content = "新资料：喜欢散步"; });
  assert.ok(buildContext(store.state).refs.messageRefs.some((item) => item.id === user.id));
  assert.ok(store.addMemory({ content: "喜欢散步", sources: [{ id: user.id, revision: 1 }] }, { automatic: true }));
  assert.equal(validMemory(store.state, store.state.memories.find((item) => item.id === id)), true);
  const newUser = store.addUser("另一件新资料");
  assert.ok(store.addMemory({ content: "新的独立资料", sources: [{ id: newUser.id, revision: 1 }] }, { automatic: true }));
  store.deleteMessage(user.id);
  assert.equal(validMemory(store.state, store.state.memories.find((item) => item.id === id)), true);
});

test("corrected-source extraction makes no provider call and an in-flight extraction cannot restore an old fact", async (t) => {
  const { store, user, id } = fixture(t);
  let calls = 0;
  const waiting = deferred(), started = deferred();
  const companion = service(store, async () => { calls++; started.finish(); return waiting.promise; });
  const pending = companion.extract(user, new AbortController().signal);
  await started.promise;
  correct(store, id);
  waiting.finish('{"memories":[{"content":"旧模型晚到的乌龙茶资料","kind":"fact","expiresAt":null}]}');
  await pending;
  await companion.extract(user, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(store.state.memories.some((item) => item.content.includes("旧模型晚到")), false);
  const changed = { ...user, content: "同修订但已变化" };
  await companion.extract(changed, new AbortController().signal);
  assert.equal(calls, 1);
});

test("late chat is discarded when a raw source becomes superseded even if the corrected memory was not recalled", async (t) => {
  const { store, user, id } = fixture(t);
  for (let i = 0; i < 35; i++) store.addMemory({ content: `更近期的独立资料 ${i}` });
  store.settings({ autoMemory: false });
  const waiting = deferred(), started = deferred();
  const companion = service(store, async () => { started.finish(); return waiting.promise; });
  const pending = companion.send({ content: "你好" });
  await started.promise;
  const context = store.state.messages.at(-1).context;
  assert.equal(context.memoryRefs.some((item) => item.id === id), false);
  assert.equal(context.messageRefs.some((item) => item.id === user.id), true);
  correct(store, id);
  waiting.finish("基于旧资料的过时回复");
  await assert.rejects(pending, status(409));
  assert.equal(store.state.messages.some((item) => item.content === "基于旧资料的过时回复"), false);
});

test("correction keeps separate privacy associations and forgetting includes corrected and active derivatives", (t) => {
  const { store, user, first, second, id } = fixture(t);
  const fromReply = store.addMemory({ content: "旧回复衍生资料", sources: [{ id: second.id, revision: 1 }] });
  correct(store, id);
  store.editMemory(id, { allowSync: false, allowModel: true });
  const projection = project(store.state);
  for (const item of [user, first, second]) assert.equal(projection.get(`message:${item.id}`).value, null);
  assert.match(buildContext(store.state).messages[0].content, /纠正资料：喜欢红茶/);
  store.editMemory(id, { allowSync: true, allowModel: false });
  assert.equal(project(store.state).get(`memory:${id}`).value.allowModel, false);
  assert.equal(JSON.stringify(buildContext(store.state)).includes("红茶"), false);
  const preview = store.forgettingPreview({ id });
  assert.deepEqual(preview.counts, { memories: 2, sourceMessages: 1, replies: 2, unavailableSources: 0 });
  store.deleteMemory(id, true, preview.token);
  assert.equal(store.state.memories.find((item) => item.id === fromReply).deleted, true);
  assert.equal(JSON.stringify(store.snapshot()).includes("乌龙茶"), false);
  assert.equal(JSON.stringify(store.snapshot()).includes("红茶"), false);
});

test("forgetting a shared source through another memory also removes its manually corrected derivative", (t) => {
  const { store, input, id } = fixture(t);
  const other = store.addMemory({ ...input, content: "需要一起遗忘的同来源资料" });
  correct(store, id);
  const preview = store.forgettingPreview({ id: other });
  assert.equal(preview.items.some((item) => item.id === id && item.relationship === "derived"), true);
  store.deleteMemory(other, true, preview.token);
  assert.equal(store.state.memories.find((item) => item.id === id).deleted, true);
});

test("correction associations survive encrypted recovery and same-identity older backups cannot undo a correction", async (t) => {
  const { store, user, input, id } = fixture(t);
  const older = store.exportData();
  correct(store, id);
  const encrypted = await encryptBackup(store.exportData(), "isolated-correction-backup");
  const fresh = new CompanionStore(); t.after(() => fresh.close());
  fresh.restore(await decryptBackup(encrypted, "isolated-correction-backup"));
  assert.deepEqual(fresh.state.memories.find((item) => item.id === id).supersededSources, input.sources);
  assert.equal(fresh.addMemory({ ...input, content: "恢复后旧资料" }, { automatic: true }), null);
  store.restore(older);
  assert.equal(store.state.memories.find((item) => item.id === id).content, "纠正资料：喜欢红茶");
  assert.equal(buildContext(store.state).refs.messageRefs.some((item) => item.id === user.id), false);
  store.deleteMemory(id);
  fresh.restore(store.exportData());
  assert.equal(buildContext(fresh.state).refs.messageRefs.some((item) => item.id === user.id), false);
});

test("corrections suppress offline derived memories after sync; deletion retains source blockers on a fresh peer", async (t) => {
  const dav = await davFixture(); t.after(() => dav.close());
  const { store: a, user, input, id } = fixture(t);
  const b = new CompanionStore(); t.after(() => b.close());
  const x = new SyncService(a), y = new SyncService(b);
  for (const sync of [x, y]) sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const code = x.createPair().code;
  await x.sync(); await y.join(code);
  const offline = b.addMemory({ ...input, content: "离线端整理的过时资料" }, { automatic: true });
  correct(a, id);
  await x.sync(); await y.sync(); await x.sync();
  for (const store of [a, b]) {
    assert.equal(validMemory(store.state, store.state.memories.find((item) => item.id === offline)), false);
    assert.equal(store.state.memories.find((item) => item.id === offline).invalidated, true);
    assert.equal(buildContext(store.state).refs.messageRefs.some((item) => item.id === user.id), false);
  }
  a.deleteMemory(id); await x.sync();
  const c = new CompanionStore(); t.after(() => c.close());
  const z = new SyncService(c); z.configure({ baseUrl: dav.baseUrl, auto: false }); await z.join(code);
  assert.equal(c.state.memories.some((item) => item.id === id), false);
  assert.equal(buildContext(c.state).refs.messageRefs.some((item) => item.id === user.id), false);
  assert.equal(c.addMemory({ ...input, content: "新端重复整理" }, { automatic: true }), null);
});

test("correction rollback is atomic and persisted associations survive an actual SQLite reopen", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "niria-correction-"));
  let opened;
  t.after(() => { opened?.close(); assert.ok(resolve(folder).startsWith(`${resolve(tmpdir())}${sep}`)); rmSync(folder, { recursive: true, force: true }); });
  const filename = join(folder, "companion.sqlite");
  const first = new CompanionStore(filename), user = first.addUser("最初资料");
  opened = first;
  const id = first.addMemory({ content: "最初记忆", sources: [{ id: user.id, revision: 1 }] });
  const sync = new SyncService(first); sync.createPair();
  const state = first.snapshot(), meta = structuredClone(sync.meta);
  first.db.exec("CREATE TEMP TRIGGER fail_correction BEFORE UPDATE ON main.sync_records BEGIN SELECT RAISE(ABORT,'correction rollback'); END");
  assert.throws(() => correct(first, id), /correction rollback/);
  assert.deepEqual(first.snapshot(), state); assert.deepEqual(sync.meta, meta);
  assert.deepEqual(sync.persistence.load(), meta);
  first.db.exec("DROP TRIGGER fail_correction"); correct(first, id); first.close(); opened = null;
  const reopened = new CompanionStore(filename); opened = reopened;
  const memory = reopened.state.memories.find((item) => item.id === id);
  assert.equal(memory.supersededSources[0].hash, messageHash(user));
  assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM memory_sources WHERE memory_id=?").get(id).n, 0);
  assert.equal(buildContext(reopened.state).refs.messageRefs.some((item) => item.id === user.id), false);
});

test("invalid or oversized correction associations are rejected before restore or sync can use them", (t) => {
  const { store, input, id } = fixture(t); correct(store, id);
  for (const invalid of [false, {}, [null], [{ id: input.sources[0].id, revision: 0 }],
    [{ ...input.sources[0], hash: "invalid" }], Array.from({ length: 51 }, () => input.sources[0])]) {
    const data = store.exportData();
    data.memories.find((item) => item.id === id).supersededSources = invalid;
    assert.throws(() => validateSnapshot(data), status(400));
  }
  const before = store.snapshot(), data = store.exportData();
  data.memories[0].supersededSources = [null];
  assert.throws(() => store.restore(data), status(400));
  assert.deepEqual(store.snapshot(), before);
});

test("restoring a paired pre-correction backup preserves the correction's sync ancestry without a self-conflict", async (t) => {
  const dav = await davFixture(); t.after(() => dav.close());
  const { store: a, id } = fixture(t), b = new CompanionStore(); t.after(() => b.close());
  const x = new SyncService(a), y = new SyncService(b);
  for (const sync of [x, y]) sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const code = x.createPair().code;
  await x.sync(); await y.join(code);
  const backup = a.exportData();
  correct(a, id); await x.sync();
  a.restore(backup);
  x.configure({ baseUrl: dav.baseUrl, auto: false }); x.unlock(code);
  await x.sync(); await y.sync();
  for (const store of [a, b]) {
    assert.equal(store.state.conflicts.length, 0);
    assert.equal(store.state.memories.find((item) => item.id === id).content, "纠正资料：喜欢红茶");
  }
});

test("all known correction conflict candidates suppress old sources and retain permission/forget associations", async (t) => {
  const dav = await davFixture(); t.after(() => dav.close());
  const { store: a, user, id } = fixture(t), b = new CompanionStore(); t.after(() => b.close());
  const x = new SyncService(a), y = new SyncService(b);
  for (const sync of [x, y]) sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const code = x.createPair().code;
  await x.sync(); await y.join(code);
  correct(a, id);
  b.editMemory(id, { kind: "experience" });
  await x.sync(); await y.sync();
  const conflict = b.state.conflicts.find((item) => item.id === id);
  assert.equal(conflict.candidates.length, 2);
  assert.equal(buildContext(b.state).refs.messageRefs.some((item) => item.id === user.id), false);
  const preview = b.forgettingPreview({ id });
  assert.equal(preview.counts.sourceMessages, 1);
  y.resolve(conflict.key, conflict.candidates.find((candidate) => candidate.value.supersededSources?.length).id);
  assert.equal(b.state.memories.find((item) => item.id === id).conflicted, undefined);
  assert.equal(buildContext(b.state).refs.messageRefs.some((item) => item.id === user.id), false);
  await y.sync(); await x.sync();
  assert.equal(a.state.conflicts.length, 0);
});

test("expired corrections and deleted corrections still block superseded source versions", (t) => {
  const { store, user, input, id } = fixture(t); correct(store, id);
  store.mutate((state) => { state.memories.find((item) => item.id === id).expiresAt = "2000-01-01T00:00:00Z"; });
  assert.equal(buildContext(store.state).refs.messageRefs.some((item) => item.id === user.id), false);
  assert.equal(store.addMemory({ ...input, content: "到期不应复活原文" }, { automatic: true }), null);
  store.deleteMemory(id);
  const marker = store.state.tombstones.find((item) => item.id === id);
  assert.deepEqual(marker.supersededSources, input.sources);
  assert.equal(buildContext(store.state).refs.messageRefs.some((item) => item.id === user.id), false);
});

test("withdrawing model permission blocks extraction before and during the request without changing sync permission", async (t) => {
  const { store, user, id } = fixture(t);
  const waiting = deferred(), started = deferred(); let calls = 0;
  const companion = service(store, async () => { calls++; started.finish(); return waiting.promise; });
  const pending = companion.extract(user, new AbortController().signal); await started.promise;
  store.editMemory(id, { allowModel: false, allowSync: true });
  waiting.finish('{"memories":[{"content":"撤权后的晚到结果","kind":"fact","expiresAt":null}]}'); await pending;
  await companion.extract(user, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(store.state.memories.some((item) => item.content === "撤权后的晚到结果"), false);
  assert.ok(project(store.state).get(`message:${user.id}`).value);
});
