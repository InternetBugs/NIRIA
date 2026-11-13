import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CompanionStore, defaults, messageHash } from "../core/store.mjs";
import { recallMemories } from "../core/memory-recall.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const folder = join(root, "artifacts", `storage-benchmark-${Date.now()}`);
await mkdir(folder, { recursive: true });
const state = defaults(), at = new Date().toISOString();
state.settings.autoMemory = false;
for (let i = 0; i < 20000; i++) {
  state.messages.push({
    id: randomUUID(), role: "user", content: `隔离性能测试消息 ${i}。这是用于验证长期存储的合成资料。`.repeat(4),
    revision: 1, status: "completed", deleted: false, createdAt: at, updatedAt: at
  });
}
for (let i = 0; i < 4000; i++) {
  const source = state.messages[i * 5];
  state.memories.push({
    id: randomUUID(), content: i === 0 ? "用户的猫栗子生日在三月十四日。" : `用户喜欢第 ${i} 座公园的下午散步。`,
    kind: "fact", sources: [{ id: source.id, revision: 1, hash: messageHash(source) }], expiresAt: null,
    confirmed: true, allowModel: null, allowSync: null, deleted: false, invalidated: false,
    revision: 1, createdAt: at, updatedAt: at
  });
}
const filename = join(folder, "companion.sqlite");
const legacy = new DatabaseSync(filename);
legacy.exec("CREATE TABLE companion(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)");
legacy.prepare("INSERT INTO companion VALUES(1,?)").run(JSON.stringify(state));
const legacyWriteStart = performance.now();
legacy.prepare("UPDATE companion SET data=? WHERE id=1").run(JSON.stringify(state));
const legacyWriteMs = performance.now() - legacyWriteStart;
legacy.close();
const start = performance.now();
let store = new CompanionStore(filename);
const migrationMs = performance.now() - start;
assert.equal(store.state.messages.length, 20000);
assert.equal(store.state.memories.length, 4000);
const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT memory_id FROM memory_sources WHERE message_id=?").all(state.messages[0].id);
assert.ok(plan.some((row) => row.detail.includes("sources_message")));
store.db.exec(`CREATE TEMP TABLE writes(name TEXT,bytes INTEGER);
  CREATE TEMP TRIGGER message_write AFTER INSERT ON main.message_records
    BEGIN INSERT INTO writes VALUES('message',length(CAST(new.data AS BLOB))); END;
  CREATE TEMP TRIGGER avatar_write AFTER UPDATE ON main.avatar_state
    BEGIN INSERT INTO writes VALUES('avatar',length(CAST(new.data AS BLOB))); END;
  CREATE TEMP TRIGGER meta_write AFTER UPDATE ON main.state_meta
    BEGIN INSERT INTO writes VALUES('meta',length(CAST(new.data AS BLOB))); END;`);
const appendStart = performance.now();
store.addUser("一次新的日常聊天");
const appendMs = performance.now() - appendStart;
const writes = store.db.prepare("SELECT name,sum(bytes) AS bytes,count(*) AS rows FROM writes GROUP BY name").all().map((row) => ({ ...row }));
assert.deepEqual(writes.map((row) => row.name), ["message"]);
assert.equal(writes[0].rows, 1);
const query = () => recallMemories(store.state, { query: "栗子的生日是哪一天？" });
const cold = performance.now(), first = query(), coldRecallMs = performance.now() - cold;
const warm = performance.now(), second = query(), warmRecallMs = performance.now() - warm;
assert.equal(first[0].memory.id, state.memories[0].id);
assert.deepEqual(second.map((r) => r.memory.id), first.map((r) => r.memory.id));
store.close();
const restart = performance.now();
store = new CompanionStore(filename);
const restartMs = performance.now() - restart;
assert.equal(store.state.messages.length, 20001);
store.close();
const round = (number) => Math.round(number * 100) / 100;
const result = {
  syntheticData: true, messages: 20000, memories: 4000,
  legacyWholeSnapshotBytes: Buffer.byteLength(JSON.stringify(state)),
  legacyWholeRewriteMs: round(legacyWriteMs), migrationMs: round(migrationMs),
  appendMs: round(appendMs), writes, coldRecallMs: round(coldRecallMs),
  warmRecallMs: round(warmRecallMs), restartMs: round(restartMs),
  indexedSourceLookup: true,
  limitations: "Local synthetic run; state is still loaded and compared in memory. Sync still transmits a whole encrypted object."
};
await writeFile(join(folder, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
