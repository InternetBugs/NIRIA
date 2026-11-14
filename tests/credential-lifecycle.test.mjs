import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialVault } from "../core/credential-vault.mjs";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { Connections } from "../core/connections.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const secret = "isolated-credential-failure-detail";
const config = { baseUrl: "http://localhost:1/v1", model: "original-model", apiKey: "isolated-synthetic-api-key" };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "niria-credential-lifecycle-"));
  const store = new CompanionStore(), companion = new CompanionService(store), sync = new SyncService(store);
  const filename = join(directory, "credentials.sqlite");
  let vault;
  const protector = { available: async () => true,
    encrypt: async (text) => Buffer.from(text), decrypt: async (bytes) => bytes.toString() };
  const open = async () => { vault = new CredentialVault(filename, protector); await vault.initialize(); return vault; };
  t.after(async () => { sync.lock(); store.close(); await vault?.close(); await rm(directory, { recursive: true, force: true }); });
  const connections = () => new Connections({ companion, synchronization: sync, vault });
  return { directory, filename, store, companion, sync, protector, open, connections };
}
test("a corrupt credential file degrades to session-only use without overwriting the original bytes", async (t) => {
  const { filename, open, connections, companion, store } = await setup(t);
  const original = Buffer.from("isolated damaged credential file: retain every byte");
  await writeFile(filename, original);
  const vault = await open(), services = connections();
  assert.equal(vault.status().available, false);
  assert.equal(vault.status().savedKnown, false);
  assert.match(vault.status().warning, /未.*清除|无法.*清除/);
  await services.restore();
  await services.configure("chat", config);
  assert.equal(companion.connection.model, config.model);
  assert.deepEqual(await readFile(filename), original);
  assert.equal(store.state.calls.length, 0);
  await assert.rejects(services.configure("chat", { ...config, remember: true }), /安全|存储/);
  await assert.rejects(services.forget("all"), /清除/);
  assert.deepEqual(await readFile(filename), original);
});
test("an unreadable credential location leaves companion state usable and does not remove the location", async (t) => {
  const { filename, open, connections, companion } = await setup(t);
  await mkdir(filename);
  const vault = await open();
  assert.equal(vault.status().available, false);
  await connections().configure("chat", config);
  assert.equal(companion.connection.model, config.model);
  await assert.rejects(vault.remove("all"), /清除/);
});
test("an incompatible credential schema is preserved instead of being treated as an empty vault", async (t) => {
  const { filename, open } = await setup(t);
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE credentials (slot TEXT PRIMARY KEY, future_data BLOB); INSERT INTO credentials VALUES('chat',x'0102')");
  db.close();
  const original = await readFile(filename), vault = await open();
  assert.equal(vault.status().available, false);
  assert.equal(vault.status().savedKnown, false);
  assert.equal(await vault.read("chat"), null);
  assert.deepEqual(await readFile(filename), original);
});
test("runtime credential database read faults keep authenticated state and local history available", async (t) => {
  const { open, store, companion, sync } = await setup(t), vault = await open();
  store.addUser("凭据库故障后仍可读取的本机历史");
  const server = createPrototypeServer({ store, companion, sync, vault });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  vault.db.exec("DROP TABLE credentials");
  const base = `http://127.0.0.1:${server.address().port}`, { token } = await (await fetch(`${base}/api/session`)).json();
  const response = await fetch(`${base}/api/state`, { headers: { "X-Niria-Token": token } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.messages[0].content, "凭据库故障后仍可读取的本机历史");
  assert.equal(state.connections.storage.savedKnown, false);
  assert.equal(state.connections.storage.available, false);
  assert.match(state.connections.storage.warning, /存储/);
});
test("native credential write failures are sanitized and preserve the active connection", async (t) => {
  const { open, connections, companion } = await setup(t), vault = await open(), services = connections();
  await services.configure("chat", config);
  const prepare = vault.db.prepare.bind(vault.db);
  vault.db.prepare = (sql) => { if (sql.startsWith("INSERT")) throw new Error(secret); return prepare(sql); };
  await assert.rejects(services.configure("chat", { ...config, model: "must-not-apply", remember: true }), (error) => {
    assert.equal(error.status, 503);
    assert.ok(!error.message.includes(secret));
    assert.match(error.message, /存储|保存/);
    return true;
  });
  assert.equal(companion.connection.model, config.model);
  assert.equal(services.status().chat.model, config.model);
  assert.equal(vault.status().available, false);
});
test("native credential removal failure cannot report saved credentials as cleared", async (t) => {
  const { open, connections } = await setup(t), vault = await open(), services = connections();
  await services.configure("chat", { ...config, remember: true });
  const exec = vault.db.exec.bind(vault.db);
  vault.db.exec = (sql) => { if (sql.startsWith("DELETE")) throw new Error(secret); return exec(sql); };
  await assert.rejects(services.forget("all"), (error) => {
    assert.equal(error.status, 503);
    assert.match(error.message, /未.*清除|无法.*清除/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(vault.db.prepare("SELECT count(*) AS count FROM credentials").get().count, 1);
  assert.equal(vault.status().savedKnown, false);
});
test("saving a new encrypted connection does not publish it before the save succeeds", async (t) => {
  const { open, connections, companion, protector } = await setup(t), vault = await open(), services = connections();
  await services.configure("chat", config);
  const gate = deferred(), encrypt = protector.encrypt;
  protector.encrypt = async (text) => { await gate.promise; return encrypt(text); };
  const previous = companion.connection, previousId = services.status().chat.connectionId;
  const pending = services.configure("chat", { ...config, model: "new-model", remember: true });
  try {
    assert.equal(services.changing, true);
    assert.equal(companion.connection, previous);
    assert.equal(services.status().chat.connectionId, previousId);
    gate.resolve(); await pending;
    assert.equal(companion.connection.model, "new-model");
    assert.notEqual(services.status().chat.connectionId, previousId);
    assert.equal((await vault.read("chat")).model, "new-model");
  } finally { gate.resolve(); await pending; }
});
test("failed encrypted sync configuration preserves the prepared rotation keys and recovery plan", async (t) => {
  const { open, connections, sync, protector } = await setup(t);
  await open(); const services = connections();
  await services.configure("sync", { baseUrl: "http://localhost:1/dav/", auto: false });
  sync.createPair(); const prepared = sync.rotation.prepare(), plan = sync.rotation.plan, key = Buffer.from(plan.next.key);
  const connection = sync.connection;
  protector.encrypt = async () => { throw new Error(secret); };
  await assert.rejects(services.configure("sync", { baseUrl: "http://localhost:2/dav/", auto: true, remember: true }), /未能加密/);
  assert.equal(sync.connection, connection);
  assert.equal(sync.rotation.plan, plan);
  assert.deepEqual(plan.next.key, key);
  assert.equal(sync.rotation.prepare().code, prepared.code);
});
test("disabling secure storage while protection is unavailable still removes previously saved ciphertext", async (t) => {
  const { open, connections, companion } = await setup(t), vault = await open(), services = connections();
  await services.configure("chat", { ...config, remember: true });
  vault.available = false;
  await services.configure("chat", { ...config, model: "session-only", remember: false });
  assert.equal(companion.connection.model, "session-only");
  assert.deepEqual(vault.status().saved, []);
  assert.equal(vault.status().savedKnown, true);
});
