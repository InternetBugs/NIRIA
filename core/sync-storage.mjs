import { ServiceError } from "../prototype/image-service.mjs";

export const SYNC_TABLES = ["sync_records", "sync_record_order", "sync_deletions", "sync_fingerprints"];
const schema = `
  CREATE TABLE IF NOT EXISTS sync_meta(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
  CREATE TABLE sync_records(key TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE sync_record_order(position INTEGER PRIMARY KEY, key TEXT NOT NULL);
  CREATE TABLE sync_deletions(position INTEGER PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE sync_fingerprints(key TEXT PRIMARY KEY, digest TEXT NOT NULL);
`;
const invalid = () => new ServiceError(503, "本机同步资料库格式不完整或来自较新版本，已停止打开。请保留资料文件并使用兼容版本或加密备份恢复。");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const uuid = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const recordKey = (record) => `${record.kind}:${record.id}`;
function split(meta) {
  if (!object(meta) || !object(meta.manifest) || !object(meta.fingerprints) ||
      meta.manifest.format !== "niria-sync-state" || meta.manifest.version !== 1 || !uuid(meta.manifest.identityId) ||
      !Array.isArray(meta.manifest.records) || !Array.isArray(meta.manifest.tombstones)) throw invalid();
  const { manifest, fingerprints, ...rest } = meta;
  const { records, tombstones, ...manifestHeader } = manifest;
  const keyed = new Map();
  for (const record of records) {
    if (!object(record) || !["identity", "message", "memory", "avatar"].includes(record.kind) ||
        !uuid(record.id) || keyed.has(recordKey(record))) throw invalid();
    keyed.set(recordKey(record), record);
  }
  const entries = Object.entries(fingerprints);
  if (entries.some(([key, digest]) => !key || typeof digest !== "string")) throw invalid();
  return { keyed, records, tombstones, entries, header: {
    format: "niria-sync-meta", version: 1, meta: { ...rest, manifest: manifestHeader },
    counts: { records: records.length, tombstones: tombstones.length, fingerprints: entries.length }
  } };
}

// Bodies and ordering are separate: inserting a sorted message can move many
// small order rows without rewriting an unchanged avatar or revision graph.
// No cache is kept across transactions; SQLite owns rollback of every shard.
export class SyncStorage {
  constructor(db) { this.db = db; this.statements = new Map(); }
  statement(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  static migrate(db) {
    if (!db.isTransaction) throw new Error("Sync storage migration requires a transaction");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
    if (SYNC_TABLES.some((table) => tables.has(table))) throw invalid();
    const row = tables.has("sync_meta") ? db.prepare("SELECT data FROM sync_meta WHERE id=1").get() : null;
    const original = row ? JSON.parse(row.data) : null;
    if (original) split(original);
    db.exec(schema);
    const storage = new SyncStorage(db);
    if (original) storage.save(original);
    storage.load();
  }
  load() {
    try {
      const row = this.statement("SELECT data FROM sync_meta WHERE id=1").get();
      const records = new Map(this.statement("SELECT key,data FROM sync_records").all().map((item) => [item.key, JSON.parse(item.data)]));
      const order = this.statement("SELECT position,key FROM sync_record_order ORDER BY position").all();
      const deletions = this.statement("SELECT position,data FROM sync_deletions ORDER BY position").all();
      const fingerprints = this.statement("SELECT key,digest FROM sync_fingerprints ORDER BY key").all();
      if (!row) {
        if (records.size || order.length || deletions.length || fingerprints.length) throw invalid();
        return null;
      }
      const header = JSON.parse(row.data);
      if (header?.format !== "niria-sync-meta" || header.version !== 1 || !object(header.meta) ||
          !object(header.meta.manifest) || !object(header.counts) ||
          header.counts.records !== records.size || header.counts.records !== order.length ||
          header.counts.tombstones !== deletions.length || header.counts.fingerprints !== fingerprints.length ||
          order.some((item, position) => item.position !== position || !records.has(item.key)) ||
          new Set(order.map((item) => item.key)).size !== records.size ||
          deletions.some((item, position) => item.position !== position) ||
          [...records].some(([key, record]) => !object(record) || recordKey(record) !== key)) throw invalid();
      const result = { ...header.meta, manifest: { ...header.meta.manifest,
        records: order.map(({ key }) => records.get(key)), tombstones: deletions.map(({ data }) => JSON.parse(data)) },
        fingerprints: Object.fromEntries(fingerprints.map(({ key, digest }) => [key, digest])) };
      split(result);
      return result;
    } catch { throw invalid(); }
  }
  save(meta) {
    const { keyed, records, tombstones, entries, header } = split(meta);
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const keys = new Set(keyed.keys()), fingerprints = new Set(entries.map(([key]) => key));
      for (const { key } of this.statement("SELECT key FROM sync_records").all()) {
        if (!keys.has(key)) this.statement("DELETE FROM sync_records WHERE key=?").run(key);
      }
      for (const [key, record] of keyed) {
        this.statement(`INSERT INTO sync_records(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data
          WHERE sync_records.data<>excluded.data`).run(key, JSON.stringify(record));
      }
      this.statement("DELETE FROM sync_record_order WHERE position>=?").run(records.length);
      for (const [position, record] of records.entries()) {
        this.statement(`INSERT INTO sync_record_order(position,key) VALUES(?,?) ON CONFLICT(position) DO UPDATE SET key=excluded.key
          WHERE sync_record_order.key<>excluded.key`).run(position, recordKey(record));
      }
      this.statement("DELETE FROM sync_deletions WHERE position>=?").run(tombstones.length);
      for (const [position, marker] of tombstones.entries()) {
        this.statement(`INSERT INTO sync_deletions(position,data) VALUES(?,?) ON CONFLICT(position) DO UPDATE SET data=excluded.data
          WHERE sync_deletions.data<>excluded.data`).run(position, JSON.stringify(marker));
      }
      for (const { key } of this.statement("SELECT key FROM sync_fingerprints").all()) {
        if (!fingerprints.has(key)) this.statement("DELETE FROM sync_fingerprints WHERE key=?").run(key);
      }
      for (const [key, digest] of entries) {
        this.statement(`INSERT INTO sync_fingerprints(key,digest) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest
          WHERE sync_fingerprints.digest<>excluded.digest`).run(key, digest);
      }
      this.statement(`INSERT INTO sync_meta(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data
        WHERE sync_meta.data<>excluded.data`).run(JSON.stringify(header));
      if (ownsTransaction) this.db.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
