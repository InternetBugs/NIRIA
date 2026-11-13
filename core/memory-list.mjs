import { createHash } from "node:crypto";
import { ServiceError } from "../prototype/image-service.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const states = ["all", "pending", "confirmed", "inactive"];
const kinds = ["all", "fact", "experience", "inference"];
export class MemoryList {
  constructor(store, validator) {
    this.store = store;
    this.validator = validator;
    store.db.function("niria_memory_state", (id) => this.cache?.states.get(id) || "inactive");
  }
  info(at = Date.now()) {
    const basis = [this.store.state.identity.id, this.store.memoryVersion, this.store.messageVersion].join(":");
    if (this.cache?.basis === basis && at >= this.cache.at && at < this.cache.nextExpiry) return this.cache;
    const valid = this.validator(this.store.state, at), values = new Map(), counts = { pending: 0, confirmed: 0, inactive: 0 };
    let nextExpiry = Infinity, lastExpiry = 0;
    for (const memory of this.store.state.memories) {
      if (memory.deleted) continue;
      const expires = Date.parse(memory.expiresAt);
      if (Number.isFinite(expires)) {
        if (expires > at) nextExpiry = Math.min(nextExpiry, expires); else lastExpiry = Math.max(lastExpiry, expires);
      }
      const status = valid(memory) ? memory.confirmed ? "confirmed" : "pending" : "inactive";
      values.set(memory.id, status);
      counts[status]++;
    }
    this.cache = { basis, at, nextExpiry, states: values, revision: digest([basis, lastExpiry]), counts };
    return this.cache;
  }
  summary() {
    const info = this.info();
    return { revision: info.revision, total: info.states.size, counts: { ...info.counts },
      nextExpiry: Number.isFinite(info.nextExpiry) ? info.nextExpiry : null };
  }
  page({ query = "", status = "all", kind = "all", cursor = "", anchor = "", limit = 60 } = {}) {
    if (typeof query !== "string" || query.length > 200 || !states.includes(status) || !kinds.includes(kind) ||
      typeof cursor !== "string" || cursor.length > 1600 || typeof anchor !== "string" || anchor.length > 100 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 || (anchor && cursor)) {
      throw new ServiceError(400, "记忆筛选或分页参数无效。搜索最多 200 个字符，每页最多 100 条。");
    }
    query = query.trim();
    const summary = this.summary(), identity = this.store.state.identity.id, filter = digest([query, status, kind]);
    let boundary;
    if (cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        boundary = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (boundary.version !== 1 || boundary.type !== "memory" || !["older", "newer"].includes(boundary.direction) ||
          !Number.isSafeInteger(boundary.position) || boundary.position < 0 || boundary.position > 20_000 || boundary.filter !== filter) throw new Error();
      } catch { throw new ServiceError(400, "记忆分页位置无效，请重新筛选。"); }
      if (boundary.identity !== identity || boundary.revision !== summary.revision) throw new ServiceError(409, "记忆或来源已经变化，请重新载入这一页。");
    }
    const db = this.store.db, parameters = [], clauses = ["deleted=0"];
    if (query) { clauses.push("instr(lower(json_extract(data,'$.content')),lower(?))>0"); parameters.push(query); }
    if (status !== "all") { clauses.push("niria_memory_state(id)=?"); parameters.push(status); }
    if (kind !== "all") { clauses.push("kind=?"); parameters.push(kind); }
    const where = clauses.join(" AND ");
    const range = (operator, position, order, count) => db.prepare(
      `SELECT id,position,data FROM memory_records WHERE ${where}${operator ? ` AND position${operator}?` : ""} ORDER BY position ${order} LIMIT ?`
    ).all(...parameters, ...(operator ? [position] : []), count);
    let rows;
    if (anchor) {
      const current = db.prepare(`SELECT position FROM memory_records WHERE ${where} AND id=?`).get(...parameters, anchor);
      if (!current) throw new ServiceError(404, "这条记忆已删除或不符合当前筛选，已回到最近记录。");
      rows = range("<=", current.position, "DESC", limit);
    } else {
      const newer = boundary?.direction === "newer";
      rows = range(boundary ? newer ? ">" : "<" : "", boundary?.position, newer ? "ASC" : "DESC", limit);
      if (newer) rows.reverse();
    }
    const exists = (operator, position) => !!db.prepare(`SELECT 1 FROM memory_records WHERE ${where} AND position${operator}? LIMIT 1`).get(...parameters, position);
    const makeCursor = (direction, position) => encode({ version: 1, type: "memory", identity, revision: summary.revision, filter, direction, position });
    return { ...summary, query, status, kind, totalMatches: db.prepare(`SELECT count(*) AS count FROM memory_records WHERE ${where}`).get(...parameters).count,
      memories: rows.map((row) => JSON.parse(row.data)), states: Object.fromEntries(rows.map((row) => [row.id, this.cache.states.get(row.id)])),
      olderCursor: rows.length && exists("<", rows.at(-1).position) ? makeCursor("older", rows.at(-1).position) : null,
      newerCursor: rows.length && exists(">", rows[0].position) ? makeCursor("newer", rows[0].position) : null };
  }
}
