import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ServiceError } from "../prototype/image-service.mjs";

export const CREDENTIAL_SLOTS = Object.freeze(["chat", "image", "speech", "sync", "pair"]);
export class CredentialVault {
  constructor(filename, protector) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS credentials (slot TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)");
    this.protector = protector;
    this.available = false;
    this.warning = null;
    this.tail = Promise.resolve();
  }
  async initialize() {
    try { this.available = await this.protector.available(); }
    catch { this.available = false; }
    if (!this.available) this.warning = "Windows 安全存储当前不可用，已保存的配置未解锁；可以继续使用仅本次会话的连接。";
    return this.status();
  }
  status() {
    return { available: this.available, saved: this.db.prepare("SELECT slot FROM credentials ORDER BY slot").all().map((r) => r.slot), warning: this.warning };
  }
  slot(slot) {
    if (!CREDENTIAL_SLOTS.includes(slot)) throw new ServiceError(400, "不支持的服务配置类型。");
  }
  enqueue(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async write(slot, data) {
    this.slot(slot);
    return this.enqueue(async () => {
      if (!this.available) throw new ServiceError(503, "Windows 安全存储不可用，配置没有写入磁盘。可取消“记住配置”后仅在本次使用。");
      const serialized = JSON.stringify({ version: 1, slot, data });
      if (Buffer.byteLength(serialized) > 32 * 1024) throw new ServiceError(400, "服务配置过大。");
      let encrypted;
      try { encrypted = await this.protector.encrypt(serialized); }
      catch { throw new ServiceError(503, "系统未能加密服务配置，没有以明文保存。"); }
      if (!Buffer.isBuffer(encrypted) || encrypted.length < 16) throw new ServiceError(503, "系统未返回有效的加密配置。");
      this.db.prepare("INSERT INTO credentials(slot,ciphertext) VALUES(?,?) ON CONFLICT(slot) DO UPDATE SET ciphertext=excluded.ciphertext").run(slot, encrypted);
    });
  }
  async read(slot) {
    this.slot(slot);
    return this.enqueue(async () => {
      const row = this.db.prepare("SELECT ciphertext FROM credentials WHERE slot=?").get(slot);
      if (!row || !this.available) return null;
      try {
        const decoded = JSON.parse(await this.protector.decrypt(Buffer.from(row.ciphertext)));
        if (decoded.version !== 1 || decoded.slot !== slot || !decoded.data || typeof decoded.data !== "object") throw new Error("invalid record");
        return decoded.data;
      } catch {
        this.warning = "部分已保存配置无法解锁，未自动连接。请重新填写该服务，或清除已保存配置。";
        return null;
      }
    });
  }
  async remove(slot) {
    if (slot !== "all") this.slot(slot);
    return this.enqueue(() => {
      if (slot === "all") this.db.exec("DELETE FROM credentials");
      else this.db.prepare("DELETE FROM credentials WHERE slot=?").run(slot);
      this.warning = this.available ? null : this.warning;
    });
  }
  async close() { await this.tail; this.db.close(); }
}
