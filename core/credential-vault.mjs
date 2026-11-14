import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ServiceError } from "../prototype/image-service.mjs";

export const CREDENTIAL_SLOTS = Object.freeze(["chat", "image", "speech", "sync", "pair"]);
const unavailable = "本机凭据存储无法使用，已保存配置尚无法核对或清除，原文件已保留。新连接可仅在本次会话使用；重启后可能仍使用原已存配置，请保留文件并检查存储。";
const storageFailed = (removing = false) => new ServiceError(503, removing
  ? "本机凭据存储无法使用，未能确认清除已保存配置；原文件已保留，重启后可能仍使用原配置。请检查存储后重试。"
  : "本机凭据存储未能保存配置，原会话连接已保留。请检查存储，或取消“记住配置”后仅在本次会话使用。");
export class CredentialVault {
  constructor(filename, protector) {
    this.db = null;
    this.protector = protector;
    this.available = false;
    this.warning = null;
    this.storageReady = false;
    this.tail = Promise.resolve();
    try {
      mkdirSync(dirname(filename), { recursive: true });
      this.db = new DatabaseSync(filename);
      this.db.exec("PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS credentials (slot TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)");
      const columns = this.db.prepare("PRAGMA table_info(credentials)").all();
      if (columns.length !== 2 || !columns.some((c) => c.name === "slot" && c.type === "TEXT" && c.pk === 1) ||
          !columns.some((c) => c.name === "ciphertext" && c.type === "BLOB" && c.notnull === 1)) throw new Error("Invalid credential schema");
      this.storageReady = true;
    } catch {
      this.failStorage();
      try { this.db?.close(); } catch { /* Opening may already have failed. */ }
    }
  }
  failStorage() {
    this.storageReady = false;
    this.available = false;
    this.warning = unavailable;
  }
  async initialize() {
    if (!this.storageReady) return this.status();
    let available = false;
    try { available = await this.protector.available(); }
    catch { /* Session-only use remains available without system protection. */ }
    if (!this.storageReady) return this.status();
    this.available = available;
    if (!this.available) this.warning = "Windows 安全存储当前不可用，已保存的配置未解锁；可以继续使用仅本次会话的连接。";
    return this.status();
  }
  status() {
    let saved = [];
    if (this.storageReady) {
      try { saved = this.db.prepare("SELECT slot FROM credentials ORDER BY slot").all().map((r) => r.slot); }
      catch { this.failStorage(); }
    }
    return { available: this.available, saved, savedKnown: this.storageReady, warning: this.warning };
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
      if (!this.storageReady) throw storageFailed();
      if (!this.available) throw new ServiceError(503, "Windows 安全存储不可用，配置没有写入磁盘。可取消“记住配置”后仅在本次使用。");
      const serialized = JSON.stringify({ version: 1, slot, data });
      if (Buffer.byteLength(serialized) > 32 * 1024) throw new ServiceError(400, "服务配置过大。");
      let encrypted;
      try { encrypted = await this.protector.encrypt(serialized); }
      catch { throw new ServiceError(503, "系统未能加密服务配置，没有以明文保存。"); }
      if (!Buffer.isBuffer(encrypted) || encrypted.length < 16) throw new ServiceError(503, "系统未返回有效的加密配置。");
      try { this.db.prepare("INSERT INTO credentials(slot,ciphertext) VALUES(?,?) ON CONFLICT(slot) DO UPDATE SET ciphertext=excluded.ciphertext").run(slot, encrypted); }
      catch { this.failStorage(); throw storageFailed(); }
    });
  }
  async read(slot) {
    this.slot(slot);
    return this.enqueue(async () => {
      if (!this.storageReady) return null;
      let row;
      try { row = this.db.prepare("SELECT ciphertext FROM credentials WHERE slot=?").get(slot); }
      catch { this.failStorage(); return null; }
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
      if (!this.storageReady) throw storageFailed(true);
      try {
        if (slot === "all") this.db.exec("DELETE FROM credentials");
        else this.db.prepare("DELETE FROM credentials WHERE slot=?").run(slot);
      } catch { this.failStorage(); throw storageFailed(true); }
      this.warning = this.available ? null : this.warning;
    });
  }
  async close() { await this.tail; if (this.db?.isOpen) this.db.close(); }
}
