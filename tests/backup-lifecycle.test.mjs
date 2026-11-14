import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { BackupService } from "../core/backup-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const password = "isolated-backup-password";
const secret = "private-storage-failure-detail";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const wait = async (condition) => {
  for (let index = 0; index < 200; index++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Backup lifecycle condition timed out");
};
async function setup(t, options = {}) {
  const store = new CompanionStore(), companion = new CompanionService(store), sync = new SyncService(store);
  const server = createPrototypeServer({ store, companion, sync, ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    server.backup?.cancel();
    await wait(() => !server.backup?.active);
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    sync.lock(); store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const post = (path, body, headers = {}, options = {}) => fetch(`${base}${path}`, {
    ...options, method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token, ...headers }, body: JSON.stringify(body)
  });
  const state = async () => (await fetch(`${base}/api/state?messages=recent&memories=none`, { headers: { "X-Niria-Token": token } })).json();
  const basis = async () => (await state()).backup?.basis || "baseline-without-restore-basis";
  return { store, companion, sync, server, base, token, post, state, basis };
}
async function fixture() {
  const donor = new CompanionStore();
  try {
    donor.identity({ name: "隔离备份里的伙伴" });
    donor.addUser("隔离备份里的共同经历");
    donor.addMemory({ content: "隔离备份里的长期记忆" });
    const data = donor.exportData();
    return { data, backup: await encryptBackup(data, password) };
  } finally { donor.close(); }
}
test("restoring without a current confirmation basis does not replace the companion", async (t) => {
  const { store, post } = await setup(t), { backup } = await fixture();
  const original = store.snapshot();
  const response = await post("/api/backup/restore", { backup, password });
  assert.equal(response.status, 409);
  assert.deepEqual(store.snapshot(), original);
});
test("a restore confirmed before another window edits the companion is rejected", async (t) => {
  const { store, post, basis } = await setup(t), { backup } = await fixture();
  const expectedBasis = await basis();
  store.addMemory({ content: "确认之后另一窗口新保存的资料" });
  const response = await post("/api/backup/restore", { backup, password, expectedBasis });
  assert.equal(response.status, 409);
  assert.equal(store.state.memories[0].content, "确认之后另一窗口新保存的资料");
});
test("new local data saved during real asynchronous backup decryption cannot be overwritten", async (t) => {
  const { store, server, post, basis } = await setup(t), { backup } = await fixture();
  const expectedBasis = await basis(), changed = deferred();
  server.on("request", (request) => {
    if (request.url === "/api/backup/restore") request.once("end", () => {
      setImmediate(() => { store.addMemory({ content: "解密等待期间保存的本机记忆" }); changed.resolve(); });
    });
  });
  const response = await post("/api/backup/restore", { backup, password, expectedBasis });
  await changed.promise;
  assert.equal(response.status, 409);
  assert.equal(store.state.memories[0].content, "解密等待期间保存的本机记忆");
});
test("successful restore reports saved-pair cleanup failure separately from restored data", async (t) => {
  const { store, server, post, basis } = await setup(t), { backup, data } = await fixture();
  server.connections.rememberPair = async () => { throw new Error(secret); };
  const response = await post("/api/backup/restore", { backup, password, expectedBasis: await basis() });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.match(result.credentialWarning, /已恢复.*配对码/);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(store.state.identity.id, data.identity.id);
  assert.equal(store.state.messages[0].id, data.messages[0].id);
});
test("failed restore transaction retains the previous synchronization session and key", (t) => {
  const store = new CompanionStore(), sync = new SyncService(store);
  t.after(() => { sync.lock(); store.close(); });
  sync.configure({ baseUrl: "http://localhost:1/", auto: true });
  const { code } = sync.createPair(), backup = store.exportData();
  store.identity({ name: "仍应保留的当前伙伴" });
  const before = store.snapshot(), connection = sync.connection, pair = sync.pair, meta = structuredClone(sync.meta);
  const save = store.persistence.save;
  store.persistence.save = () => { throw new Error(secret); };
  try { assert.throws(() => store.restore(backup), /private-storage/); }
  finally { store.persistence.save = save; }
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(sync.meta, meta);
  assert.equal(sync.connection, connection);
  assert.equal(sync.pair, pair);
  assert.equal(sync.exportPair().code, code);
  assert.equal(sync.auto, true);
});
test("stopping a held restore retains busy ownership until decryption settles and preserves local data", async (t) => {
  const gate = deferred(), { data } = await fixture();
  const { store, server, post, basis } = await setup(t, { backupOptions: { decryptor: async () => { await gate.promise; return data; } } });
  const before = store.snapshot();
  const pending = post("/api/backup/restore", { expectedBasis: await basis() });
  try {
    await wait(() => !!server.backup.active);
    const active = server.backup.active;
    assert.equal((await post("/api/backup/cancel", {})).status, 200);
    assert.equal(active.controller.signal.aborted, true);
    assert.equal(server.backup.status().busy, true);
    assert.equal((await post("/api/backup/export", { password })).status, 409);
    gate.resolve();
    const response = await pending;
    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /停止或超时/);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(server.backup.active, null);
  } finally { gate.resolve(); await pending; }
});
test("restore timeout cannot replace local data when a decryptor ignores cancellation", async (t) => {
  const gate = deferred(), { data } = await fixture();
  const { store, server, post, basis } = await setup(t, { backupOptions: {
    timeoutMs: 10, decryptor: async () => { await gate.promise; return data; }
  } });
  const before = store.snapshot(), pending = post("/api/backup/restore", { expectedBasis: await basis() });
  try {
    await wait(() => server.backup.active?.controller.signal.aborted);
    assert.equal(server.backup.status().busy, true);
    gate.resolve();
    assert.equal((await pending).status, 504);
    assert.deepEqual(store.snapshot(), before);
  } finally { gate.resolve(); await pending; }
});
test("a cancelled late encryption response never exports the encrypted payload", async (t) => {
  const gate = deferred();
  const { server, post } = await setup(t, { backupOptions: { encryptor: async () => { await gate.promise; return { data: secret }; } } });
  const pending = post("/api/backup/export", { password });
  try {
    await wait(() => !!server.backup.active);
    await post("/api/backup/cancel", {});
    assert.equal(server.backup.status().busy, true);
    gate.resolve();
    const response = await pending, result = await response.json();
    assert.equal(response.status, 504);
    assert.ok(!JSON.stringify(result).includes(secret));
  } finally { gate.resolve(); await pending; }
});
test("encrypted export uses an immutable snapshot captured before asynchronous encryption", async (t) => {
  const gate = deferred(), store = new CompanionStore();
  t.after(() => store.close());
  store.addMemory({ content: "导出开始前已有的记忆" });
  const snapshot = store.exportData();
  const service = new BackupService(store, { encryptor: async (data, secret) => { await gate.promise; return encryptBackup(data, secret); } });
  const pending = service.export(password);
  store.addMemory({ content: "导出等待期间新增的记忆" });
  gate.resolve();
  assert.deepEqual(await decryptBackup(await pending, password), snapshot);
  assert.equal(store.state.memories.length, 2);
});
test("disconnecting an uncommitted restore cancels that request and retains the current companion", async (t) => {
  const gate = deferred(), { data } = await fixture();
  const { store, server, post, basis } = await setup(t, { backupOptions: { decryptor: async () => { await gate.promise; return data; } } });
  const controller = new AbortController(), before = store.snapshot();
  const pending = post("/api/backup/restore", { expectedBasis: await basis() }, {}, { signal: controller.signal });
  const outcome = assert.rejects(pending, { name: "AbortError" });
  try {
    await wait(() => !!server.backup.active);
    const active = server.backup.active;
    controller.abort(); await outcome;
    await wait(() => active.controller.signal.aborted);
    gate.resolve();
    await wait(() => !server.backup.active);
    assert.deepEqual(store.snapshot(), before);
  } finally { controller.abort(); gate.resolve(); await outcome; }
});
test("a rejected duplicate request cannot cancel the existing backup owner", async (t) => {
  const gate = deferred();
  const { server, post } = await setup(t, { backupOptions: { encryptor: async () => { await gate.promise; return { exported: true }; } } });
  const pending = post("/api/backup/export", { password });
  try {
    await wait(() => !!server.backup.active);
    const active = server.backup.active;
    const duplicate = await post("/api/backup/export", { password });
    assert.equal(duplicate.status, 409);
    await duplicate.json();
    assert.equal(server.backup.active, active);
    assert.equal(active.controller.signal.aborted, false);
    gate.resolve();
    assert.deepEqual(await (await pending).json(), { exported: true });
  } finally { gate.resolve(); await pending; }
});
test("stop during post-commit credential cleanup reports the committed restore truthfully", async (t) => {
  const gate = deferred(), { backup, data } = await fixture();
  const { store, server, post, basis } = await setup(t);
  server.connections.rememberPair = async () => { await gate.promise; };
  const pending = post("/api/backup/restore", { backup, password, expectedBasis: await basis() });
  try {
    await wait(() => server.backup.status().committed);
    assert.equal(store.state.identity.id, data.identity.id);
    assert.deepEqual(await (await post("/api/backup/cancel", {})).json(), { ok: true, committed: true });
    assert.equal(server.backup.active.controller.signal.aborted, false);
    gate.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally { gate.resolve(); await pending; }
});
test("HTTP restore persistence failure is sanitized and retains confirmation and sync state", async (t) => {
  const { store, sync, post, basis } = await setup(t), { backup } = await fixture();
  sync.configure({ baseUrl: "http://localhost:1/", auto: true });
  const { code } = sync.createPair(), connection = sync.connection, before = store.snapshot(), expectedBasis = await basis();
  const save = store.persistence.save;
  store.persistence.save = () => { throw new Error(secret); };
  try {
    const response = await post("/api/backup/restore", { backup, password, expectedBasis });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.match(result.error, /当前资料已保留/);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.deepEqual(store.snapshot(), before);
    assert.equal(await basis(), expectedBasis);
    assert.equal(sync.connection, connection);
    assert.equal(sync.exportPair().code, code);
  } finally { store.persistence.save = save; }
});
test("restore confirmation tracks settings, call accounting, sync session and no-op stability", async (t) => {
  const { store, sync, post, basis } = await setup(t);
  const before = await basis();
  store.mutate(() => {});
  assert.equal(await basis(), before);
  for (const change of [
    () => store.settings({ autoMemory: !store.state.settings.autoMemory }),
    () => store.mutate((state) => { state.usage["2099-01-01"] = { speech: 1 }; }),
    () => store.mutate((state) => { state.calls.push({ id: "restore-basis-call", kind: "speech", model: "test", endpoint: "http://localhost", at: new Date().toISOString(), status: "completed" }); }),
    () => sync.createPair(),
    () => post("/api/sync/configure", { baseUrl: "http://localhost:1/", auto: false, remember: false }),
    () => sync.lock()
  ]) {
    const previous = await basis();
    await change();
    assert.notEqual(await basis(), previous);
  }
});
test("failed local mutation or sync transaction rolls back the restore confirmation token", (t) => {
  const store = new CompanionStore(), sync = new SyncService(store);
  t.after(() => { sync.lock(); store.close(); });
  const original = store.snapshot(), version = store.stateVersion, save = store.persistence.save;
  store.listeners.add(() => { throw new Error(secret); });
  assert.throws(() => store.addMemory({ content: "未能保存的记忆" }), /private-storage/);
  assert.equal(store.stateVersion, version);
  assert.deepEqual(store.snapshot(), original);
  store.listeners.clear();
  const syncSave = sync.persistence.save, changed = store.snapshot();
  changed.settings.autoMemory = !changed.settings.autoMemory;
  sync.persistence.save = () => { throw new Error(secret); };
  try { assert.throws(() => sync.commit(changed, sync.meta), /private-storage/); }
  finally { sync.persistence.save = syncSave; store.persistence.save = save; }
  assert.equal(store.stateVersion, version);
  assert.deepEqual(store.snapshot(), original);
  assert.deepEqual(store.persistence.load(), original);
});
test("restore waits for an in-flight saved pairing-code write before it can replace local data", async (t) => {
  const gate = deferred(), { backup } = await fixture(), { store, sync, server, post, basis } = await setup(t);
  sync.createPair();
  server.connections.vault = { available: true, write: async () => gate.promise,
    status: () => ({ available: true, saved: [] }) };
  const pending = server.connections.rememberPair(true), before = store.snapshot();
  try {
    assert.equal(server.connections.pendingPairWrites, 1);
    const response = await post("/api/backup/restore", { backup, password, expectedBasis: await basis() });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /配对码保存设置正在处理/);
    assert.deepEqual(store.snapshot(), before);
  } finally { gate.resolve(); await pending; }
  assert.equal(server.connections.pendingPairWrites, 0);
});
test("a pending restore blocks new pairing writes and remains cancellable during unrelated config saving", async (t) => {
  const gate = deferred(), { data } = await fixture();
  const { server, post, basis } = await setup(t, { backupOptions: { decryptor: async () => { await gate.promise; return data; } } });
  const pending = post("/api/backup/restore", { expectedBasis: await basis() });
  try {
    await wait(() => server.backup.restoring);
    for (const path of ["configure", "create", "unlock", "remember", "rotation/prepare", "run"]) {
      const response = await post(`/api/sync/${path}`, {});
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /正在恢复/);
    }
    server.connections.changing = true;
    assert.equal((await post("/api/backup/cancel", {})).status, 200);
    assert.equal(server.backup.active.controller.signal.aborted, true);
    gate.resolve();
    assert.equal((await pending).status, 504);
  } finally { server.connections.changing = false; gate.resolve(); await pending; }
});
test("a committed restore clears the prior live synchronization key and connection", async (t) => {
  const { store, sync, post, basis } = await setup(t), { backup, data } = await fixture();
  sync.configure({ baseUrl: "http://localhost:1/", auto: true });
  sync.createPair();
  const key = sync.pair.key;
  const response = await post("/api/backup/restore", { backup, password, expectedBasis: await basis() });
  assert.equal(response.status, 200);
  assert.equal(store.state.identity.id, data.identity.id);
  assert.ok(key.every((byte) => byte === 0));
  assert.equal(sync.connection, null);
  assert.equal(sync.pair, null);
  assert.equal(sync.auto, false);
});
