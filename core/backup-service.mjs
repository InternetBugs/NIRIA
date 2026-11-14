import { encryptBackup, decryptBackup } from "./backup.mjs";
import { ServiceError } from "../prototype/image-service.mjs";

const stopped = () => new ServiceError(504, "备份操作已停止或超时，未继续导出或替换本机资料。");
const changed = () => new ServiceError(409, "当前资料或同步状态已经变化，请重新选择备份并确认恢复；本机新资料已保留。");

export class BackupService {
  constructor(store, { encryptor = encryptBackup, decryptor = decryptBackup, basis = () => store.stateVersion,
    canRestore = () => {}, beforeRestore = () => {}, afterRestore = async () => {}, timeoutMs = 90_000 } = {}) {
    Object.assign(this, { store, encryptor, decryptor, basis, canRestore, beforeRestore, afterRestore, timeoutMs });
    this.active = null;
  }
  get restoring() { return this.active?.operation === "restore"; }
  status() {
    return { busy: !!this.active, operation: this.active?.operation || null,
      committed: !!this.active?.committed, basis: this.basis() };
  }
  cancel(task = this.active) {
    if (task && task === this.active && !task.committed) task.controller.abort();
    return { ok: true, committed: !!task?.committed };
  }
  check(task) { if (task.controller.signal.aborted) throw stopped(); }
  async run(operation, fn) {
    if (this.active) throw new ServiceError(409, "已有备份或恢复任务正在处理，请停止或等候本机任务结束。");
    const task = { operation, controller: new AbortController(), committed: false };
    this.active = task;
    const timer = setTimeout(() => this.cancel(task), this.timeoutMs);
    try {
      const result = await fn(task);
      if (!task.committed) this.check(task);
      return result;
    } catch (error) {
      if (task.controller.signal.aborted && !task.committed) throw stopped();
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(503, "本机备份操作未能完成，当前资料已保留；请检查本机存储后再试。");
    } finally { clearTimeout(timer); this.active = null; }
  }
  async export(secret) {
    return this.run("export", async (task) => {
      const snapshot = this.store.exportData();
      const result = await this.encryptor(snapshot, secret);
      this.check(task);
      return result;
    });
  }
  async restore({ backup, password, expectedBasis } = {}) {
    return this.run("restore", async (task) => {
      if (typeof expectedBasis !== "string" || expectedBasis !== this.basis()) throw changed();
      this.canRestore();
      const restored = await this.decryptor(backup, password);
      this.check(task);
      if (expectedBasis !== this.basis()) throw changed();
      this.canRestore();
      this.beforeRestore();
      this.store.restore(restored);
      task.committed = true;
      try { await this.afterRestore(); }
      catch {
        return { ok: true, credentialWarning: "资料已恢复，但未能清除本机保存的配对码；重新启动可能自动解锁。请检查本机安全存储并清除已保存配置，不要重复恢复。" };
      }
      return { ok: true };
    });
  }
}
