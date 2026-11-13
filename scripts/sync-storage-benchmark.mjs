import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = fileURLToPath(new URL("../", import.meta.url)), baseline = process.argv.includes("--baseline-v2");
let runtime = root;
if (baseline) {
  const fixture = JSON.parse(await readFile(join(root, "artifacts", "storage-v2-upgrade-fixture.json"), "utf8"));
  assert.equal(fixture.oldVersion, "0.14.0");
  runtime = join(dirname(fixture.dataDirectory), "legacy-runtime");
}
const { CompanionStore, defaults, messageHash } = await import(pathToFileURL(join(runtime, "core", "store.mjs")));
const { SyncService } = await import(pathToFileURL(join(runtime, "core", "sync-service.mjs")));
const folder = join(root, "artifacts", `sync-storage-benchmark-${Date.now()}`);
await mkdir(folder, { recursive: true });
const store = new CompanionStore(join(folder, "companion.sqlite"));
try {
  const state = defaults(), at = new Date().toISOString();
  state.settings.autoMemory = false;
  for (let i = 0; i < 2000; i++) state.messages.push({
    id: randomUUID(), role: "user", content: `隔离同步存储诊断 ${i}，用于测量长期共同经历的写入。`.repeat(4),
    revision: 1, status: "completed", deleted: false, createdAt: at, updatedAt: at
  });
  for (let i = 0; i < 400; i++) {
    const source = state.messages[i * 5];
    state.memories.push({ id: randomUUID(), content: `隔离资料 ${i}`, kind: "fact",
      sources: [{ id: source.id, revision: 1, hash: messageHash(source) }], expiresAt: null,
      confirmed: true, allowModel: null, allowSync: null, deleted: false, invalidated: false,
      revision: 1, createdAt: at, updatedAt: at });
  }
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  state.avatar = { format: "niria-avatar-prototype", version: 1, source: png, actions: { smile: png },
    background: { version: 1, mode: "edge-connected" } };
  store.restore(state);
  const sync = new SyncService(store); sync.createPair();
  store.addUser("诊断准备");
  const tables = new Set(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
  store.db.exec("CREATE TEMP TABLE writes(name TEXT,op TEXT,key TEXT,bytes INTEGER)");
  for (const name of ["sync_meta", "sync_records", "sync_record_order", "sync_deletions", "sync_fingerprints"].filter((table) => tables.has(table))) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const row = op === "DELETE" ? "old" : "new";
      const key = name === "sync_meta" ? "'header'" : name === "sync_deletions" ? `${row}.position` : `${row}.key`;
      const data = name === "sync_record_order" ? `${row}.key` : name === "sync_fingerprints" ? `${row}.digest` : `${row}.data`;
      store.db.exec(`CREATE TEMP TRIGGER measure_${name}_${op} AFTER ${op} ON main.${name}
        BEGIN INSERT INTO writes VALUES('${name}','${op}',${key},${op === "DELETE" ? "0" : `length(CAST(${data} AS BLOB))`}); END`);
    }
  }
  const wholeMetaBytes = Buffer.byteLength(JSON.stringify(sync.meta)), start = performance.now();
  const message = store.addUser("一次新的日常聊天");
  const appendMs = performance.now() - start;
  const writes = store.db.prepare("SELECT name,op,count(*) AS rows,sum(bytes) AS bytes FROM writes GROUP BY name,op ORDER BY name,op").all().map((row) => ({ ...row }));
  const bodies = store.db.prepare("SELECT * FROM writes WHERE name='sync_records'").all();
  if (!baseline) {
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].key, `message:${message.id}`);
    assert.equal(bodies[0].op, "INSERT");
  }
  store.db.exec("DELETE FROM writes");
  sync.persist();
  const unchangedWrites = store.db.prepare("SELECT count(*) AS n FROM writes").get().n;
  if (!baseline) assert.equal(unchangedWrites, 0);
  const result = { syntheticData: true, runtime: baseline ? "0.14.0" : "current",
    storageVersion: store.db.prepare("PRAGMA user_version").get().user_version, messages: 2000, memories: 400,
    wholeMetaBytes, appendMs: Math.round(appendMs * 100) / 100, writes, unchangedWrites,
    unchangedBodiesNotWritten: !baseline, limitations: "Logical JSON/key bytes from SQLite triggers, not physical disk or WAL bytes. Whole state and sync projections still load, clone and compare in memory; remote sync still sends one complete encrypted object." };
  await writeFile(join(folder, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { store.close(); }
