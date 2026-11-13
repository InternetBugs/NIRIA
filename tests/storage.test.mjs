import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CompanionStore, defaults, messageHash, validateSnapshot } from "../core/store.mjs";
import { SQLiteState, STORAGE_VERSION } from "../core/sqlite-state.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { davFixture } from "./fixtures/dav.mjs";
import { SyncStorage } from "../core/sync-storage.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function fileFor(t) {
  const folder = mkdtempSync(join(tmpdir(), "niria-storage-"));
  t.after(() => {
    assert.ok(resolve(folder).startsWith(`${resolve(tmpdir())}${sep}`));
    rmSync(folder, { recursive: true, force: true });
  });
  return join(folder, "companion.sqlite");
}
function legacy(path, state, syncMeta, version = 0) {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE companion(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)");
    db.prepare("INSERT INTO companion VALUES(1,?)").run(JSON.stringify(state));
    if (syncMeta) {
      db.exec("CREATE TABLE sync_meta(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)");
      db.prepare("INSERT INTO sync_meta VALUES(1,?)").run(JSON.stringify(syncMeta));
    }
    db.exec(`PRAGMA user_version=${version}`);
  } finally { db.close(); }
}
function inspect(path, read) {
  const db = new DatabaseSync(path);
  try { return read(db); } finally { db.close(); }
}
function audit(db) {
  db.exec("CREATE TEMP TABLE row_changes(name TEXT,op TEXT,bytes INTEGER)");
  for (const name of ["state_meta", "avatar_state", "message_records", "memory_records", "memory_sources", "deletion_records", "call_records"]) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const bytes = operation !== "DELETE" && name !== "memory_sources" ? "length(CAST(new.data AS BLOB))" : "0";
      db.exec(`CREATE TEMP TRIGGER audit_${name}_${operation} AFTER ${operation} ON main.${name}
        BEGIN INSERT INTO row_changes VALUES('${name}','${operation}',${bytes}); END`);
    }
  }
  return () => db.prepare("SELECT name,op,count(*) AS count FROM row_changes GROUP BY name,op ORDER BY name,op").all().map((row) => ({ ...row }));
}
test("legacy snapshot migrates exactly with privacy, duplicates, avatar and sync metadata; reopening is idempotent", (t) => {
  const path = fileFor(t), original = new CompanionStore(), sync = new SyncService(original);
  t.after(() => original.close());
  sync.createPair();
  original.identity({ name: "迁移验证" });
  const source = original.addUser("旧版来源消息");
  const memory = original.addMemory({ content: "带来源的记忆", sources: [{ id: source.id, revision: 1 }] });
  original.editMemory(memory, { allowModel: false, allowSync: false });
  const deleted = original.addUser("已忘记的正文");
  original.deleteMessage(deleted.id);
  original.mutate((state) => {
    state.avatar = { format: "niria-avatar-prototype", original: { data: png }, actions: { blink: { data: png } } };
    state.tombstones.push({ ...state.tombstones[0], forget: true });
    state.usage = { "2026-11-12": { chat: 9, memory: 3 } };
  });
  const expected = original.snapshot(), metadata = structuredClone(sync.meta);
  legacy(path, expected, metadata);
  const migrated = new CompanionStore(path);
  try {
    assert.deepEqual(migrated.snapshot(), expected);
    assert.deepEqual(new SyncStorage(migrated.db).load(), metadata);
    assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, STORAGE_VERSION);
    assert.equal(migrated.db.prepare("SELECT count(*) AS n FROM deletion_records").get().n, 2);
    assert.equal(migrated.db.prepare("SELECT source_hash FROM memory_sources WHERE memory_id=?").get(memory).source_hash, messageHash(source));
    const guard = JSON.parse(migrated.db.prepare("SELECT data FROM companion").get().data);
    assert.equal(guard.version, STORAGE_VERSION);
    assert.throws(() => validateSnapshot(guard), /不受支持/);
    assert.ok(!JSON.stringify(guard).includes("旧版来源"));
    const restoredSync = new SyncService(migrated);
    assert.deepEqual(restoredSync.meta, metadata);
  } finally { migrated.close(); }
  const second = new CompanionStore(path);
  try { assert.deepEqual(second.snapshot(), expected); } finally { second.close(); }
});
test("migration rolls back schema, guard and every record when a write fails, then succeeds on retry", (t) => {
  const path = fileFor(t), expected = defaults();
  legacy(path, expected);
  const write = SQLiteState.prototype.write;
  const mocked = t.mock.method(SQLiteState.prototype, "write", function (...args) {
    write.apply(this, args);
    throw new Error("isolated migration interruption");
  });
  assert.throws(() => new CompanionStore(path), /migration interruption/);
  inspect(path, (db) => {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
    assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM companion").get().data), expected);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name), ["companion"]);
  });
  mocked.mock.restore();
  const retry = new CompanionStore(path);
  try { assert.deepEqual(retry.snapshot(), expected); } finally { retry.close(); }
});
test("invalid legacy state and unknown future schemas stop without generating a replacement companion", (t) => {
  for (const version of [0, 9]) {
    const path = fileFor(t);
    const state = version ? defaults() : { version: 1, identity: { id: "broken" } };
    legacy(path, state, null, version);
    assert.throws(() => new CompanionStore(path), version ? /较新版本/ : /格式不完整/);
    inspect(path, (db) => {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, version);
      assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM companion").get().data), state);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='state_meta'").get().n, 0);
    });
  }
});
test("startup repairs pending requests and old numeric source references once after migration", (t) => {
  const path = fileFor(t), original = new CompanionStore();
  const message = original.addUser("旧版来源");
  original.addMemory({ content: "旧版记忆", sources: [{ id: message.id, revision: 1 }] });
  const state = original.snapshot(); original.close();
  delete state.memories[0].sources[0].hash;
  state.messages.push({ ...message, id: "interrupted-message", role: "assistant", status: "pending", content: "" });
  state.calls.push({ id: "interrupted-call", kind: "chat", status: "pending", at: message.createdAt, model: "fixture", endpoint: "http://localhost" });
  legacy(path, state, null, 1);
  const migrated = new CompanionStore(path);
  try {
    assert.equal(migrated.state.messages.at(-1).status, "failed");
    assert.equal(migrated.state.calls[0].status, "unknown");
    assert.equal(migrated.state.memories[0].sources[0].hash, messageHash(message));
  } finally { migrated.close(); }
  const next = new CompanionStore(path);
  try {
    const changes = next.db.prepare("SELECT total_changes() AS n").get().n;
    next.save();
    assert.equal(next.db.prepare("SELECT total_changes() AS n").get().n, changes);
  } finally { next.close(); }
});
test("appending a message writes one entity and never rewrites avatar, previous chat or the guard", (t) => {
  const store = new CompanionStore(); t.after(() => store.close());
  store.mutate((state) => { state.avatar = { format: "niria-avatar-prototype", source: png, actions: { smile: png } }; });
  const existing = store.addUser("先前消息");
  const changes = audit(store.db);
  store.addUser("新增消息");
  assert.deepEqual(changes(), [{ name: "message_records", op: "INSERT", count: 1 }]);
  assert.equal(JSON.parse(store.db.prepare("SELECT data FROM message_records WHERE id=?").get(existing.id).data).content, "先前消息");
});
test("transaction failure rolls back records, source index and sync metadata in memory and on disk", (t) => {
  const path = fileFor(t), store = new CompanionStore(path), sync = new SyncService(store);
  sync.createPair();
  const user = store.addUser("原始来源");
  store.addMemory({ content: "原始记忆", sources: [{ id: user.id, revision: 1 }] });
  const before = store.snapshot(), metadata = structuredClone(sync.meta);
  const fail = () => { throw new Error("isolated listener failure"); };
  store.listeners.add(fail);
  assert.throws(() => store.editMessage(user.id, "失败的编辑"), /listener failure/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(sync.meta, metadata);
  assert.deepEqual(new SyncStorage(store.db).load(), metadata);
  assert.equal(store.db.prepare("SELECT source_hash FROM memory_sources").get().source_hash, messageHash(user));
  store.listeners.delete(fail);
  store.editMessage(user.id, "成功的编辑");
  assert.equal(store.state.memories[0].invalidated, true);
  store.close();
  const reopened = new CompanionStore(path);
  try {
    assert.equal(reopened.state.messages[0].content, "成功的编辑");
    assert.equal(reopened.state.memories[0].invalidated, true);
  } finally { reopened.close(); }
});
test("source edits replace indexed provenance and forgetting retains only empty deleted entities", (t) => {
  const store = new CompanionStore(); t.after(() => store.close());
  const user = store.addUser("隐私来源");
  const memory = store.addMemory({ content: "隐私记忆", sources: [{ id: user.id, revision: 1 }] });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM memory_sources WHERE message_id=?").get(user.id).n, 1);
  store.editMemory(memory, { content: "用户主动纠正" });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM memory_sources").get().n, 0);
  const derived = store.addMemory({ content: "另一条衍生", sources: [{ id: user.id, revision: 1 }] });
  store.deleteMemory(derived, true);
  const contents = store.db.prepare("SELECT data FROM message_records UNION ALL SELECT data FROM memory_records UNION ALL SELECT data FROM deletion_records").all().map((row) => row.data).join("\n");
  assert.ok(!contents.includes("隐私来源") && !contents.includes("另一条衍生"));
  assert.ok(!contents.includes("用户主动纠正"), "explicit source forgetting also erases the associated corrected memory");
});
test("encrypted v1 backups still restore and persist using entity tables", async (t) => {
  const source = new CompanionStore(), target = new CompanionStore(fileFor(t));
  try {
    source.addUser("跨存储格式恢复");
    source.addMemory({ content: "恢复后可读" });
    const backup = await encryptBackup(source.exportData(), "isolated-storage-backup");
    target.restore(await decryptBackup(backup, "isolated-storage-backup"));
    assert.equal(target.state.identity.id, source.state.identity.id);
    assert.equal(target.db.prepare("SELECT count(*) AS n FROM memory_records").get().n, 1);
    assert.equal(target.db.prepare("PRAGMA user_version").get().user_version, STORAGE_VERSION);
    assert.deepEqual(target.exportData(), source.exportData());
  } finally { source.close(); target.close(); }
});
test("unresolved sync conflicts survive migration and can resolve and converge using the same revision graph", async (t) => {
  const path = fileFor(t), dav = await davFixture();
  const a = new CompanionStore(), b = new CompanionStore();
  let migrated;
  try {
    const sa = new SyncService(a), sb = new SyncService(b);
    sa.configure({ baseUrl: dav.baseUrl, auto: false }); sb.configure({ baseUrl: dav.baseUrl, auto: false });
    const { code } = sa.createPair();
    await sa.sync(); await sb.join(code);
    a.identity({ name: "A 分支" }); b.identity({ name: "B 分支" });
    await sa.sync(); await sb.sync(); await sa.sync();
    assert.equal(a.state.conflicts.length, 1);
    legacy(path, a.snapshot(), sa.meta);
    migrated = new CompanionStore(path);
    const sync = new SyncService(migrated);
    assert.deepEqual(migrated.state.conflicts, a.state.conflicts);
    assert.deepEqual(sync.meta.manifest, sa.meta.manifest);
    sync.configure({ baseUrl: dav.baseUrl, auto: false }); sync.unlock(code);
    const conflict = migrated.state.conflicts[0];
    sync.resolve(conflict.key, conflict.candidates.find((head) => head.value.name === "B 分支").id);
    await sync.sync(); await sb.sync();
    assert.equal(migrated.state.identity.name, "B 分支");
    assert.equal(b.state.identity.name, "B 分支");
    assert.equal(b.state.conflicts.length, 0);
  } finally { migrated?.close(); a.close(); b.close(); await dav.close(); }
});
test("an incomplete normalized schema stops without opening a blank companion", (t) => {
  const path = fileFor(t), original = new CompanionStore(path);
  original.addUser("不能覆盖的资料");
  original.db.exec("DROP TABLE memory_sources");
  original.close();
  assert.throws(() => new CompanionStore(path), /格式不完整/);
  inspect(path, (db) => {
    assert.match(db.prepare("SELECT data FROM message_records").get().data, /不能覆盖的资料/);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, STORAGE_VERSION);
  });
});
test("a duplicate entity introduced by a mutation is rejected atomically rather than overwritten in a table", (t) => {
  const store = new CompanionStore(); t.after(() => store.close());
  const message = store.addUser("唯一消息");
  assert.throws(() => store.mutate((state) => { state.messages.push({ ...message, content: "重复 ID" }); }), /重复/);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM message_records").get().n, 1);
  assert.match(store.db.prepare("SELECT data FROM message_records").get().data, /唯一消息/);
});
