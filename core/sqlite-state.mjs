import { ServiceError } from "../prototype/image-service.mjs";
import { isDeepStrictEqual } from "node:util";
import { SyncStorage } from "./sync-storage.mjs";

export const STORAGE_VERSION = 3;
const lists = { messages: "message_records", memories: "memory_records", tombstones: "deletion_records", calls: "call_records" };
const schema = `
  CREATE TABLE state_meta(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
  CREATE TABLE avatar_state(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
  CREATE TABLE message_records(
    id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL,
    role TEXT NOT NULL, status TEXT NOT NULL, deleted INTEGER NOT NULL, reply_to TEXT, updated_at TEXT NOT NULL
  );
  CREATE INDEX messages_recent ON message_records(deleted, status, position);
  CREATE INDEX messages_reply ON message_records(reply_to);
  CREATE INDEX messages_history ON message_records(deleted, position);
  CREATE TABLE memory_records(
    id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL,
    kind TEXT NOT NULL, deleted INTEGER NOT NULL, invalidated INTEGER NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX memories_current ON memory_records(deleted, invalidated, updated_at);
  CREATE INDEX memories_browse ON memory_records(deleted, position);
  CREATE TABLE memory_sources(
    memory_id TEXT NOT NULL, position INTEGER NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, source_hash TEXT,
    PRIMARY KEY(memory_id, position)
  );
  CREATE INDEX sources_message ON memory_sources(message_id, memory_id);
  CREATE TABLE deletion_records(id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE INDEX deletions_entity ON deletion_records(kind, entity_id);
  CREATE TABLE call_records(id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL);
  CREATE INDEX calls_recent ON call_records(at);
`;
const serialize = (value) => JSON.stringify(value);
function meta(state) {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !Object.hasOwn(lists, key) && key !== "avatar"));
}
function rows(name, values) {
  // Tombstone duplicates and log ordering are preserved exactly, including old backups.
  const result = new Map(values.map((value, position) => [
    name === "messages" || name === "memories" ? value.id : String(position),
    { position, value }
  ]));
  if (result.size !== values.length) throw new ServiceError(400, "资料中存在重复的消息或记忆 ID，本次修改未保存。");
  return result;
}
const invalid = () => new ServiceError(503, "本机资料库格式不完整，已停止打开，未创建新的伴侣。请保留资料文件并从加密备份恢复。");
export class SQLiteState {
  constructor(db) { this.db = db; this.statements = new Map(); }
  statement(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  initialize(createState, validate) {
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > STORAGE_VERSION) throw new ServiceError(503, "本机资料库来自较新版本。请使用新版 NIRIA 打开，未覆盖现有资料。");
    if (![0, 1, 2, STORAGE_VERSION].includes(version)) throw invalid();
    if (version === STORAGE_VERSION) {
      try {
        const state = validate(this.load());
        this.guard(STORAGE_VERSION);
        new SyncStorage(this.db).load();
        this.db.exec("CREATE INDEX IF NOT EXISTS messages_history ON message_records(deleted, position)");
        this.db.exec("CREATE INDEX IF NOT EXISTS memories_browse ON memory_records(deleted, position)");
        return state;
      }
      catch { throw invalid(); }
    }
    if (version === 2) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const state = validate(this.load());
        this.guard(2);
        SyncStorage.migrate(this.db);
        this.db.exec("CREATE INDEX IF NOT EXISTS messages_history ON message_records(deleted, position)");
        this.db.exec("CREATE INDEX IF NOT EXISTS memories_browse ON memory_records(deleted, position)");
        this.db.prepare("UPDATE companion SET data=? WHERE id=1").run(serialize({ version: STORAGE_VERSION, storage: "niria-entity-tables" }));
        this.db.exec(`PRAGMA user_version=${STORAGE_VERSION}`);
        this.db.exec("COMMIT");
        return state;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error instanceof ServiceError ? error : invalid();
      }
    }
    const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
    if (tables.some((name) => !["companion", "sync_meta"].includes(name)) || (tables.length && !tables.includes("companion"))) throw invalid();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const original = tables.includes("companion") ? this.db.prepare("SELECT data FROM companion WHERE id=1").get() : null;
      if (!original && (version || tables.includes("sync_meta"))) throw invalid();
      let state;
      try { state = original ? validate(JSON.parse(original.data)) : createState(); }
      catch { throw invalid(); }
      this.db.exec(schema);
      this.write(state, null);
      SyncStorage.migrate(this.db);
      // The old binary validates state.version. A guard prevents it from
      // reopening an obsolete snapshot or silently creating a blank companion.
      this.db.exec("CREATE TABLE IF NOT EXISTS companion(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
      this.db.prepare("INSERT INTO companion(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(serialize({ version: STORAGE_VERSION, storage: "niria-entity-tables" }));
      this.db.exec(`PRAGMA user_version=${STORAGE_VERSION}`);
      this.db.exec("COMMIT");
      return state;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.statements.clear();
      throw error;
    }
  }
  load() {
    const record = this.db.prepare("SELECT data FROM state_meta WHERE id=1").get();
    const avatar = this.db.prepare("SELECT data FROM avatar_state WHERE id=1").get();
    this.db.prepare("SELECT memory_id,message_id,revision,source_hash FROM memory_sources LIMIT 0").all();
    if (!record || !avatar) throw invalid();
    const state = JSON.parse(record.data);
    for (const [name, table] of Object.entries(lists)) {
      state[name] = this.db.prepare(`SELECT data FROM ${table} ORDER BY position`).all().map((row) => JSON.parse(row.data));
    }
    state.avatar = JSON.parse(avatar.data);
    return state;
  }
  guard(version) {
    const record = this.db.prepare("SELECT data FROM companion WHERE id=1").get();
    if (!record) throw invalid();
    const marker = JSON.parse(record.data);
    if (marker.version !== version || marker.storage !== "niria-entity-tables") throw invalid();
  }
  save(state, before) {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const changes = this.write(state, before || this.load());
      if (ownsTransaction) this.db.exec("COMMIT");
      return changes;
    } catch (error) {
      if (ownsTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  write(state, before) {
    const changes = { messages: false, memories: false };
    const metadata = meta(state);
    if (!before || !isDeepStrictEqual(metadata, meta(before))) {
      this.statement("INSERT INTO state_meta(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(serialize(metadata));
    }
    if (!before || !isDeepStrictEqual(state.avatar ?? null, before.avatar ?? null)) {
      this.statement("INSERT INTO avatar_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(serialize(state.avatar ?? null));
    }
    for (const [name, table] of Object.entries(lists)) {
      const previous = rows(name, before?.[name] || []), next = rows(name, state[name]);
      for (const [id] of previous) if (!next.has(id)) {
        this.statement(`DELETE FROM ${table} WHERE id=?`).run(id);
        if (name === "messages") changes.messages = true;
        if (name === "memories") { changes.memories = true; this.statement("DELETE FROM memory_sources WHERE memory_id=?").run(id); }
      }
      for (const [id, row] of next) {
        const prior = previous.get(id);
        if (prior?.position === row.position && isDeepStrictEqual(prior.value, row.value)) continue;
        if (name === "messages") changes.messages = true;
        if (name === "memories") changes.memories = true;
        const item = row.value, values = [id, row.position, serialize(row.value)];
        let columns;
        if (name === "messages") { columns = ["role", "status", "deleted", "reply_to", "updated_at"]; values.push(item.role, item.status, Number(item.deleted), item.replyTo ?? null, item.updatedAt); }
        if (name === "memories") { columns = ["kind", "deleted", "invalidated", "updated_at"]; values.push(item.kind, Number(item.deleted), Number(item.invalidated), item.updatedAt); }
        if (name === "tombstones") { columns = ["entity_id", "kind"]; values.push(item.id, item.type); }
        if (name === "calls") { columns = ["kind", "status", "at"]; values.push(item.kind, item.status, item.at); }
        const all = ["id", "position", "data", ...columns];
        this.statement(`INSERT INTO ${table}(${all.join(",")}) VALUES(${all.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${all.slice(1).map((column) => `${column}=excluded.${column}`).join(",")}`).run(...values);
        if (name === "memories" && serialize(item.sources) !== serialize(prior?.value.sources)) {
          this.statement("DELETE FROM memory_sources WHERE memory_id=?").run(id);
          for (const [position, source] of item.sources.entries()) {
            this.statement("INSERT INTO memory_sources(memory_id,position,message_id,revision,source_hash) VALUES(?,?,?,?,?)").run(id, position, source.id, source.revision, source.hash ?? null);
          }
        }
      }
    }
    return changes;
  }
}
