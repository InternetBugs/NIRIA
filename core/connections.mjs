import { ServiceError, validateImageConnection } from "../prototype/image-service.mjs";
import { CREDENTIAL_SLOTS } from "./credential-vault.mjs";
import { randomUUID } from "node:crypto";
import { validateChatAccess, validateConnection } from "./chat-service.mjs";
import { validateSpeechConnection } from "./speech-service.mjs";

function sameEndpoint(left, right) {
  try { return new URL(left).href.replace(/\/+$/, "") === new URL(right).href.replace(/\/+$/, ""); }
  catch { return false; }
}

export class Connections {
  constructor({ companion, speech, synchronization, vault, imageBusy = () => false }) {
    this.services = { chat: companion, speech, sync: synchronization };
    this.imageBusy = imageBusy;
    this.vault = vault;
    this.current = new Map();
    this.versions = new Map();
    this.changing = false;
    this.pendingPairWrites = 0;
    this.warnings = [];
  }
  status() {
    const storage = this.vault?.status() || { available: false, saved: [], warning: "安全保存配置仅在 Windows 桌面版提供，浏览器预览只在本次进程使用。" };
    const result = { storage, warnings: [...this.warnings], changing: this.changing };
    for (const kind of ["chat", "image", "speech", "sync"]) {
      const config = this.current.get(kind);
      result[kind] = {
        configured: !!config, remember: storage.saved.includes(kind), hasSecret: !!config?.[kind === "sync" ? "password" : "apiKey"],
        connectionId: this.versions.get(kind) || null,
        ...(config ? { baseUrl: config.baseUrl, model: config.model, voice: config.voice, username: config.username,
          highFidelity: config.highFidelity, transparent: config.transparent, auto: config.auto, dailyLimit: config.dailyLimit } : {})
      };
    }
    result.rememberPair = storage.saved.includes("pair");
    return result;
  }
  busy(kind) { return kind === "image" ? this.imageBusy() : !!this.services[kind]?.active; }
  assertReady() { if (this.changing) throw new ServiceError(409, "服务配置正在保存，请稍候再操作。"); }
  async restore() {
    if (!this.vault) return;
    for (const kind of ["chat", "image", "speech", "sync"]) {
      const config = await this.vault.read(kind);
      if (!config) continue;
      try {
        this.apply(kind, config);
        this.current.set(kind, config);
        this.versions.set(kind, randomUUID());
      } catch { this.warnings.push(`${{ chat: "对话", image: "图片", speech: "朗读", sync: "同步" }[kind]}配置需要重新填写，未自动连接。`); }
    }
    const pair = await this.vault.read("pair");
    if (pair) {
      try { this.services.sync.unlock(pair.code); }
      catch { this.warnings.push("保存的配对码与当前伴侣不一致，保持锁定。"); }
    }
  }
  apply(kind, data) {
    if (kind === "image") return validateImageConnection(data);
    return this.services[kind].configure(data);
  }
  prepare(kind, data) {
    if (kind === "image") return validateImageConnection(data);
    if (kind === "chat") return validateConnection(data);
    if (kind === "speech") return validateSpeechConnection(data);
    const { connection, auto } = this.services.sync.prepareConfiguration(data);
    return { baseUrl: connection.baseUrl, username: data.username || "", password: data.password || "", auto };
  }
  chatModelAccess(input) {
    this.assertReady();
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        (input.reuseSecret !== undefined && typeof input.reuseSecret !== "boolean")) {
      throw new ServiceError(400, "获取模型列表的配置无效。");
    }
    const data = { baseUrl: input.baseUrl, apiKey: input.apiKey };
    if (input.reuseSecret && !input.apiKey) {
      const previous = this.current.get("chat");
      if (!previous || !sameEndpoint(previous.baseUrl, input.baseUrl)) {
        throw new ServiceError(400, "服务地址已改变，请重新填写密钥，或取消继续使用当前密钥。");
      }
      data.apiKey = previous.apiKey || "";
    }
    return validateChatAccess(data);
  }
  async configure(kind, input) {
    this.assertReady();
    if (!["chat", "image", "speech", "sync"].includes(kind) || !input || typeof input !== "object") throw new ServiceError(400, "服务配置无效。");
    if (this.busy(kind)) throw new ServiceError(409, "这个服务正在处理请求，请先停止或等候完成后更换配置。");
    const remember = input.remember ?? false;
    if (typeof remember !== "boolean" || (input.reuseSecret !== undefined && typeof input.reuseSecret !== "boolean")) throw new ServiceError(400, "配置保存开关无效。");
    if (remember && !this.vault?.available) throw new ServiceError(503, "当前不能安全记住服务配置，请取消“记住配置”后仅在本次使用。");
    const previous = this.current.get(kind);
    const data = { ...input };
    delete data.remember; delete data.reuseSecret;
    const field = kind === "sync" ? "password" : "apiKey";
    if (input.reuseSecret && !input[field]) {
      if (!previous || !sameEndpoint(previous.baseUrl, input.baseUrl) ||
          (kind === "sync" && previous.username !== input.username)) throw new ServiceError(400, "服务地址或账号已改变，请重新填写密钥；不会把旧密钥转发到新地址。");
      data[field] = previous[field] || "";
    }
    const prepared = this.prepare(kind, data);
    this.changing = true;
    try {
      if (remember) await this.vault.write(kind, prepared);
      else if (this.vault?.storageReady !== false) await this.vault?.remove(kind);
      this.apply(kind, prepared);
      this.current.set(kind, prepared);
      this.versions.set(kind, randomUUID());
      return this.status();
    } finally { this.changing = false; }
  }
  async rememberPair(remember) {
    if (typeof remember !== "boolean") throw new ServiceError(400, "配对码保存设置无效。");
    this.pendingPairWrites++;
    try {
      if (remember) {
        if (!this.vault?.available) throw new ServiceError(503, "当前不能安全保存配对码，请单独保管并在需要时解锁。");
        await this.vault.write("pair", this.services.sync.exportPair());
      } else await this.vault?.remove("pair");
    } finally { this.pendingPairWrites--; }
  }
  checkRotationInput(input) {
    this.assertReady();
    if (typeof input.rememberPair !== "boolean") throw new ServiceError(400, "请明确选择是否在本机安全记住配对码。");
    if (input.rememberPair && !this.vault?.available) throw new ServiceError(503, "当前不能安全保存配对码，请取消记住选项，并单独保管新旧配对码。");
  }
  async pauseSyncAuto() {
    this.assertReady();
    this.services.sync.auto = false;
    const previous = this.current.get("sync");
    if (!previous) return;
    this.changing = true;
    try {
      const next = { ...previous, auto: false };
      if (this.vault?.status().saved.includes("sync")) await this.vault.write("sync", next);
      this.current.set("sync", next);
    } finally { this.changing = false; }
  }
  async prepareSyncRotation() {
    this.assertReady();
    const plan = this.services.sync.rotation.prepare();
    await this.pauseSyncAuto();
    return plan;
  }
  async saveChangedPair(result, remember) {
    if (this.changing) return { ...result, credentialWarning: "换钥状态已更新，但其他配置正在保存；请稍后单独应用配对码保存选项。" };
    this.changing = true;
    try {
      await this.rememberPair(remember);
      return result;
    } catch {
      return { ...result, credentialWarning: "远端状态已核对，但配对码未能在本机安全保存。请保管配对码，稍后单独应用保存选项。" };
    } finally { this.changing = false; }
  }
  async rotateSync(input) {
    this.checkRotationInput(input);
    const result = await this.services.sync.rotation.activate(input, async () => {
      await this.pauseSyncAuto();
      this.assertReady();
      this.changing = true;
      try { await this.vault?.remove("pair"); }
      finally { this.changing = false; }
    });
    return this.saveChangedPair(result, input.rememberPair);
  }
  async recoverSyncRotation(input) {
    this.checkRotationInput(input);
    await this.pauseSyncAuto();
    const result = await this.services.sync.rotation.recover(input.code);
    return this.saveChangedPair(result, input.rememberPair);
  }
  async forget(slot = "all") {
    if (slot !== "all" && !CREDENTIAL_SLOTS.includes(slot)) throw new ServiceError(400, "不支持的服务配置类型。");
    this.assertReady();
    await this.vault?.remove(slot);
    this.warnings = [];
    return this.status();
  }
  image(input) {
    if (!input.useConnection) return input;
    const config = this.current.get("image");
    if (!config) throw new ServiceError(400, "请先配置图片编辑服务。");
    if (input.connectionId !== this.versions.get("image")) throw new ServiceError(409, "图片服务配置已经改变，请重新打开设置并确认本次生成。");
    return { ...config, action: input.action, image: input.image };
  }
}
