import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CompanionStore } from "../core/store.mjs";
import { STORAGE_VERSION } from "../core/sqlite-state.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { SyncStorage, SYNC_TABLES } from "../core/sync-storage.mjs";
import { observe, validateManifest } from "../core/sync-model.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function fileFor(t) {
  const folder = mkdtempSync(join(tmpdir(), "niria-sync-storage-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(`${resolve(tmpdir())}${sep}`)); rmSync(folder, { recursive: true, force: true }); });
  return join(folder, "companion.sqlite");
}
function fixture(t, filename = ":memory:") {
  const store = new CompanionStore(filename), sync = new SyncService(store);
  t.after(() => { if (store.db.isOpen) store.close(); });
  sync.createPair();
  store.mutate((state) => { state.avatar = { format: "niria-avatar-prototype", version: 1, source: png, actions: { smile: png },
    background: { version: 1, mode: "edge-connected" } }; });
  const source = store.addUser("同步存储的原始来源");
  const memory = store.addMemory({ content: "同步存储的衍生记忆", sources: [{ id: source.id, revision: 1 }] });
  return { store, sync, source, memory };
}
function audit(db) {
  db.exec("CREATE TEMP TABLE sync_writes(name TEXT,op TEXT,key TEXT)");
  for (const name of ["sync_meta", ...SYNC_TABLES]) for (const op of ["INSERT", "UPDATE", "DELETE"]) {
    const row = op === "DELETE" ? "old" : "new";
    const key = name === "sync_meta" ? "'header'" : name === "sync_deletions" ? `${row}.position` : `${row}.key`;
    db.exec(`CREATE TEMP TRIGGER audit_${name}_${op} AFTER ${op} ON main.${name}
      BEGIN INSERT INTO sync_writes VALUES('${name}','${op}',${key}); END`);
  }
  return () => db.prepare("SELECT name,op,key FROM sync_writes ORDER BY name,key").all().map((row) => ({ ...row }));
}
function v2(t) {
  const filename = fileFor(t), { store, sync } = fixture(t, filename);
  const state = store.snapshot(), meta = structuredClone(sync.meta);
  store.db.exec("BEGIN IMMEDIATE");
  for (const name of SYNC_TABLES) store.db.exec(`DROP TABLE ${name}`);
  store.db.prepare("UPDATE sync_meta SET data=?").run(JSON.stringify(meta));
  store.db.prepare("UPDATE companion SET data=?").run(JSON.stringify({ version: 2, storage: "niria-entity-tables" }));
  store.db.exec("PRAGMA user_version=2; COMMIT");
  store.close();
  return { filename, state, meta };
}
function inspect(filename, read) {
  const db = new DatabaseSync(filename);
  try { return read(db); } finally { db.close(); }
}

for (const populated of [false, true]) test(`immediate pairing backup restores a valid ${populated ? "populated" : "empty"} companion without another edit`, async (t) => {
  const store = new CompanionStore(), sync = new SyncService(store);
  const fresh = new CompanionStore(), freshSync = new SyncService(fresh);
  t.after(() => { store.close(); fresh.close(); });
  if (populated) {
    const source = store.addUser("配对之前的共同经历");
    store.addMemory({ content: "配对之前的记忆", sources: [{ id: source.id, revision: 1 }] });
  }
  const before = store.snapshot(), { code } = sync.createPair();
  assert.deepEqual(store.snapshot(), before);
  validateManifest(sync.meta.manifest);
  const saved = await encryptBackup(store.exportData(), "isolated-immediate-pair-backup");
  fresh.restore(await decryptBackup(saved, "isolated-immediate-pair-backup"));
  freshSync.unlock(code);
  assert.equal(fresh.state.identity.id, before.identity.id);
  assert.deepEqual(fresh.state.messages, before.messages);
  assert.deepEqual(fresh.state.memories, before.memories);
  validateManifest(freshSync.meta.manifest);
  assert.equal(freshSync.status().unlocked, true);
  assert.deepEqual(sync.persistence.load(), sync.meta);
});

test("pair creation persistence failure leaves no partial pair and allows retry", (t) => {
  const store = new CompanionStore(), sync = new SyncService(store);
  t.after(() => store.close());
  const before = structuredClone(sync.meta), state = store.snapshot();
  store.db.exec(`CREATE TEMP TRIGGER reject_pair_insert BEFORE INSERT ON main.sync_records
    BEGIN SELECT RAISE(ABORT, 'isolated pair failure'); END`);
  assert.throws(() => sync.createPair(), /isolated pair failure/);
  assert.deepEqual(sync.meta, before);
  assert.deepEqual(sync.persistence.load(), before);
  assert.deepEqual(store.snapshot(), state);
  assert.equal(sync.pair, null);
  store.db.exec("DROP TRIGGER reject_pair_insert");
  const { code } = sync.createPair();
  assert.ok(code.startsWith("NIRIA1."));
  validateManifest(sync.meta.manifest);
  assert.deepEqual(sync.persistence.load(), sync.meta);
});

test("paired appends persist only the new sync body and fingerprint; identical metadata makes no writes", (t) => {
  const { store, sync } = fixture(t), writes = audit(store.db);
  const message = store.addUser("一条新增的日常聊天");
  assert.deepEqual(writes().filter((row) => row.name === "sync_records"), [
    { name: "sync_records", op: "INSERT", key: `message:${message.id}` }
  ]);
  assert.deepEqual(writes().filter((row) => row.name === "sync_fingerprints"), [
    { name: "sync_fingerprints", op: "INSERT", key: `message:${message.id}` }
  ]);
  assert.ok(!store.db.prepare("SELECT data FROM sync_meta").get().data.includes(png));
  store.db.exec("DELETE FROM sync_writes");
  sync.persist();
  store.settings({ memoryDailyLimit: 7 });
  assert.deepEqual(writes(), []);
});

test("record reorder is preserved without rewriting bodies, including repeated deletion markers", (t) => {
  const { store, sync } = fixture(t), storage = sync.persistence, writes = audit(store.db);
  const next = structuredClone(sync.meta);
  next.manifest.records.reverse();
  const marker = { id: store.state.messages[0].id, type: "message", at: new Date().toISOString() };
  next.manifest.tombstones = [marker, marker];
  storage.save(next);
  assert.deepEqual(storage.load(), next);
  assert.deepEqual(writes().filter((row) => row.name === "sync_records"), []);
  assert.ok(writes().some((row) => row.name === "sync_record_order"));
});

test("source withdrawal removes private plaintext from persisted sync bodies while keeping local content", (t) => {
  const { store, sync, source, memory } = fixture(t);
  store.editMemory(memory, { allowSync: false });
  const raw = store.db.prepare("SELECT data FROM sync_records UNION ALL SELECT data FROM sync_meta UNION ALL SELECT data FROM sync_deletions").all().map((row) => row.data).join("\n");
  assert.ok(!raw.includes("同步存储的原始来源") && !raw.includes("同步存储的衍生记忆"));
  assert.equal(store.state.messages.find((item) => item.id === source.id).content, "同步存储的原始来源");
  assert.deepEqual(sync.persistence.load(), sync.meta);
});

test("explicit forgetting deletes graph bodies and retains only required markers on disk", (t) => {
  const { store, sync, memory } = fixture(t);
  store.deleteMemory(memory, true, store.forgettingPreview({ id: memory }).token);
  const raw = store.db.prepare("SELECT data FROM sync_records UNION ALL SELECT data FROM sync_meta UNION ALL SELECT data FROM sync_deletions").all().map((row) => row.data).join("\n");
  assert.ok(!raw.includes("同步存储的原始来源") && !raw.includes("同步存储的衍生记忆"));
  assert.ok(sync.persistence.load().manifest.tombstones.some((marker) => marker.id === memory));
  assert.deepEqual(sync.persistence.load(), sync.meta);
});

test("late shard failure rolls back state, graphs, fingerprints and revisions, then a retry persists", (t) => {
  const { store, sync, source } = fixture(t), state = store.snapshot(), meta = structuredClone(sync.meta);
  const messageVersion = store.messageVersion, memoryVersion = store.memoryVersion;
  store.db.exec("CREATE TEMP TRIGGER fail_fingerprint BEFORE UPDATE ON main.sync_fingerprints BEGIN SELECT RAISE(ABORT,'isolated shard failure'); END");
  assert.throws(() => store.editMessage(source.id, "不应保存的内容"), /shard failure/);
  assert.deepEqual(store.snapshot(), state);
  assert.deepEqual(sync.meta, meta);
  assert.deepEqual(sync.persistence.load(), meta);
  assert.equal(store.messageVersion, messageVersion);
  assert.equal(store.memoryVersion, memoryVersion);
  store.db.exec("DROP TRIGGER fail_fingerprint");
  store.editMessage(source.id, "成功保存的新内容");
  assert.deepEqual(sync.persistence.load(), sync.meta);
  assert.ok(JSON.stringify(sync.persistence.load()).includes("成功保存的新内容"));
});

test("remote commit failure after shard writes restores the same state and sync lineage", (t) => {
  const { store, sync } = fixture(t), state = store.snapshot(), meta = structuredClone(sync.meta);
  const next = store.snapshot(); next.identity.name = "不应提交的名字"; next.identity.revision++;
  const nextMeta = structuredClone(meta);
  nextMeta.manifest = observe(nextMeta.manifest, nextMeta.fingerprints, next, nextMeta.device);
  nextMeta.lastSuccess = new Date().toISOString();
  store.db.exec("CREATE TEMP TRIGGER fail_header BEFORE UPDATE ON main.sync_meta BEGIN SELECT RAISE(ABORT,'isolated commit failure'); END");
  assert.throws(() => sync.commit(next, nextMeta), /commit failure/);
  assert.deepEqual(store.snapshot(), state);
  assert.deepEqual(sync.meta, meta);
  assert.deepEqual(sync.persistence.load(), meta);
  store.db.exec("DROP TRIGGER fail_header");
  sync.commit(next, nextMeta);
  assert.deepEqual(sync.persistence.load(), nextMeta);
});

test("standalone metadata save owns a transaction and cannot leave partial body inserts", (t) => {
  const { store, sync } = fixture(t), before = structuredClone(sync.meta), next = structuredClone(before);
  next.fingerprints.extra = "isolated-digest";
  next.manifest.records[0].heads[0].at = "2026-11-13T12:00:00.000Z";
  store.db.exec("CREATE TEMP TRIGGER fail_insert BEFORE INSERT ON main.sync_fingerprints WHEN new.key='extra' BEGIN SELECT RAISE(ABORT,'isolated standalone failure'); END");
  assert.throws(() => sync.persistence.save(next), /standalone failure/);
  assert.deepEqual(sync.persistence.load(), before);
  assert.equal(store.db.isTransaction, false);
});

test("v2 migration preserves every state and metadata field and repeats without writes", (t) => {
  const { filename, state, meta } = v2(t);
  inspect(filename, (db) => db.exec("DROP INDEX messages_history; DROP INDEX memories_browse"));
  const store = new CompanionStore(filename);
  try {
    assert.deepEqual(store.snapshot(), state);
    const sync = new SyncService(store);
    assert.deepEqual(sync.meta, meta);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, STORAGE_VERSION);
    assert.equal(JSON.parse(store.db.prepare("SELECT data FROM companion").get().data).version, STORAGE_VERSION);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('messages_history','memories_browse')").get().n, 2);
    const count = store.db.prepare("SELECT total_changes() AS n").get().n;
    new SyncStorage(store.db).save(sync.meta);
    assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, count);
  } finally { store.close(); }
});

test("failed v2 migration rolls back all shards, legacy metadata, version and downgrade marker", (t) => {
  const { filename, state, meta } = v2(t);
  const original = SyncStorage.prototype.save;
  const mocked = t.mock.method(SyncStorage.prototype, "save", function (...args) {
    original.apply(this, args);
    throw new Error("isolated migration failure");
  });
  assert.throws(() => new CompanionStore(filename), /格式不完整/);
  inspect(filename, (db) => {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(JSON.parse(db.prepare("SELECT data FROM companion").get().data).version, 2);
    assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM sync_meta").get().data), meta);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'sync_record%'").get().n, 0);
  });
  mocked.mock.restore();
  const retry = new CompanionStore(filename);
  try { assert.deepEqual(retry.snapshot(), state); assert.deepEqual(new SyncService(retry).meta, meta); }
  finally { retry.close(); }
});

test("unpaired v2 data migrates without inventing a sync identity or touching companion content", (t) => {
  const { filename, state } = v2(t);
  inspect(filename, (db) => { db.exec("DROP TABLE sync_meta"); });
  const store = new CompanionStore(filename);
  try {
    assert.deepEqual(store.snapshot(), state);
    assert.equal(new SyncStorage(store.db).load(), null);
    assert.equal(new SyncService(store).meta.vaultId, null);
  } finally { store.close(); }
});

test("invalid legacy metadata aborts v2 upgrade without replacing the original row", (t) => {
  for (const altered of [{}, { manifest: { records: [], tombstones: [] }, fingerprints: null }, "broken", "future"]) {
    const { filename, meta } = v2(t);
    const metadata = altered === "future" ? { ...meta, manifest: { ...meta.manifest, version: 9 } } : altered;
    inspect(filename, (db) => { db.prepare("UPDATE sync_meta SET data=?").run(JSON.stringify(metadata)); });
    assert.throws(() => new CompanionStore(filename), /格式不完整/);
    inspect(filename, (db) => {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
      assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM sync_meta").get().data), metadata);
    });
  }
});

test("missing shards, incomplete order, missing rows and unsupported headers stop without a blank replacement", (t) => {
  const alterations = [
    "DROP TABLE sync_fingerprints",
    "DELETE FROM sync_records WHERE key=(SELECT key FROM sync_records LIMIT 1)",
    "UPDATE sync_record_order SET key=(SELECT key FROM sync_record_order WHERE position=0) WHERE position=1",
    "UPDATE sync_meta SET data=json_set(data,'$.version',9)",
    "DELETE FROM sync_meta"
  ];
  for (const sql of alterations) {
    const filename = fileFor(t), { store } = fixture(t, filename), expected = store.state.identity.id;
    store.db.exec(sql); store.close();
    assert.throws(() => new CompanionStore(filename), /格式不完整/);
    inspect(filename, (db) => {
      assert.equal(JSON.parse(db.prepare("SELECT data FROM state_meta").get().data).identity.id, expected);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, STORAGE_VERSION);
    });
  }
});

test("missing downgrade guard blocks a v2 upgrade and duplicate graph keys cannot be written", (t) => {
  const { filename } = v2(t);
  inspect(filename, (db) => db.exec("DELETE FROM companion"));
  assert.throws(() => new CompanionStore(filename), /格式不完整/);
  inspect(filename, (db) => assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2));
  const { sync } = fixture(t), meta = structuredClone(sync.meta);
  meta.manifest.records.push(meta.manifest.records[0]);
  assert.throws(() => sync.persistence.save(meta), /格式不完整/);
  assert.deepEqual(sync.persistence.load(), sync.meta);
});

test("actual SQLite reopen restores graphs, withdrawals, rotation markers and ordered metadata", (t) => {
  const filename = fileFor(t), { store, sync, memory } = fixture(t, filename);
  store.editMemory(memory, { allowSync: false });
  sync.meta.rotation = { id: "isolated-journal", startedAt: "2026-11-13T00:00:00.000Z", fromTag: "old", toTag: "new", baseUrl: "http://127.0.0.1/test/" };
  sync.persist();
  const expected = structuredClone(sync.meta), state = store.snapshot();
  store.close();
  const reopened = new CompanionStore(filename);
  try {
    const restored = new SyncService(reopened);
    assert.deepEqual(reopened.snapshot(), state);
    assert.deepEqual(restored.meta, expected);
    assert.equal(restored.rotation.status().pending, true);
    const changes = reopened.db.prepare("SELECT total_changes() AS n").get().n;
    restored.persist();
    assert.equal(reopened.db.prepare("SELECT total_changes() AS n").get().n, changes);
  } finally { reopened.close(); }
});
