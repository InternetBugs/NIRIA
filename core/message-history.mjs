import { createHash } from "node:crypto";
import { ServiceError } from "../prototype/image-service.mjs";

const filterHash = (value) => createHash("sha256").update(value).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const stale = () => new ServiceError(409, "聊天记录已经变化，请重新载入这一页。");
export class MessageHistory {
  constructor(store) { this.store = store; }
  summary() {
    const db = this.store.db;
    return {
      revision: this.store.messageVersion,
      total: db.prepare("SELECT count(*) AS count FROM message_records WHERE deleted=0").get().count,
      lastUserId: db.prepare("SELECT id FROM message_records WHERE deleted=0 AND role='user' ORDER BY position DESC LIMIT 1").get()?.id || null
    };
  }
  latest(limit = 120) {
    return this.store.db.prepare("SELECT data FROM message_records WHERE deleted=0 ORDER BY position DESC LIMIT ?").all(limit)
      .map((row) => JSON.parse(row.data)).reverse();
  }
  page({ query = "", cursor = "", anchor = "", limit = 60 } = {}) {
    if (typeof query !== "string" || query.length > 200 || typeof cursor !== "string" || cursor.length > 1600 ||
        typeof anchor !== "string" || anchor.length > 100 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (anchor && cursor)) throw new ServiceError(400, "请检查搜索文字或分页参数。每页最多 100 条，搜索最多 200 个字符。");
    query = query.trim();
    const summary = this.summary(), identity = this.store.state.identity.id, filter = filterHash(query);
    let boundary = null;
    if (cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        boundary = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (boundary.version !== 1 || !["before", "after"].includes(boundary.direction) ||
            !Number.isSafeInteger(boundary.position) || boundary.position < 0 || boundary.position > 100_000 ||
            boundary.filter !== filter) throw new Error();
      } catch { throw new ServiceError(400, "分页位置无效，请重新搜索。"); }
      if (boundary.revision !== summary.revision || boundary.identity !== identity) throw stale();
    }
    const where = "deleted=0" + (query ? " AND instr(lower(json_extract(data,'$.content')),lower(?))>0" : "");
    const parameters = query ? [query] : [];
    const db = this.store.db;
    const range = (operator, position, order, count) => db.prepare(
      `SELECT id,position,data FROM message_records WHERE ${where}${operator ? ` AND position${operator}?` : ""} ORDER BY position ${order} LIMIT ?`
    ).all(...parameters, ...(operator ? [position] : []), count);
    let rows;
    if (anchor) {
      const current = db.prepare("SELECT position FROM message_records WHERE id=? AND deleted=0").get(anchor);
      if (!current) throw new ServiceError(404, "这条消息已删除或不在本机，请重新载入记录。");
      const after = range(">=", current.position, "ASC", Math.ceil(limit / 2));
      const before = range("<", current.position, "DESC", limit - after.length).reverse();
      rows = [...before, ...after];
    } else {
      const forward = boundary?.direction === "after";
      rows = range(boundary ? forward ? ">" : "<" : "", boundary?.position, forward ? "ASC" : "DESC", limit);
      if (!forward) rows.reverse();
    }
    const exists = (operator, position) => !!db.prepare(`SELECT 1 FROM message_records WHERE ${where} AND position${operator}? LIMIT 1`).get(...parameters, position);
    const makeCursor = (direction, position) => encode({
      version: 1, identity, revision: summary.revision, filter, direction, position
    });
    return {
      ...summary, query, anchorId: anchor || null,
      totalMatches: query ? db.prepare(`SELECT count(*) AS count FROM message_records WHERE ${where}`).get(...parameters).count : summary.total,
      messages: rows.map((row) => JSON.parse(row.data)),
      olderCursor: rows.length && exists("<", rows[0].position) ? makeCursor("before", rows[0].position) : null,
      newerCursor: rows.length && exists(">", rows.at(-1).position) ? makeCursor("after", rows.at(-1).position) : null
    };
  }
}
