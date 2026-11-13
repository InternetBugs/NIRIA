import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ServiceError, pngBytes } from "../prototype/image-service.mjs";
import { EXPRESSIONS } from "./expression.mjs";
import { inspectLive2DAvatar } from "../prototype/public/live2d-avatar.js";
import { SQLiteState } from "./sqlite-state.mjs";
import { clearMemoryTermCache } from "./memory-term-cache.mjs";
import { MessageHistory } from "./message-history.mjs";
import { MemoryList } from "./memory-list.mjs";
import { applyStateDeletions, mergeDeletionMarkers, stateDeletionRecords } from "./deletion-cascade.mjs";
import { forgettingPreview, planForgetting } from "./forget-preview.mjs";
import { messageHash, associatedSources, mergeSourceReferences, supersededMessageIds, automaticMemoryAllowed,
  linkedMessageIds, permissionBlockedMessageIds, invalidateSupersededMemories, preserveCorrections } from "./memory-provenance.mjs";

export const now = () => new Date().toISOString();
export { messageHash };
export const defaults = () => ({
  version: 1,
  identity: {
    id: randomUUID(), name: "Niria", userName: "", persona: "温柔、坦诚，有自己的想法，认真倾听，也会自然地分享感受。",
    style: "使用简体中文，像日常聊天一样自然、简洁。不使用舞台动作或编造共同经历。",
    relationship: "正在彼此了解的长期伴侣，尊重对方的生活和相处节奏。", revision: 1, updatedAt: now()
  },
  settings: {
    allowModel: true, allowSync: true, autoMemory: true, memoryDailyLimit: 8,
    care: { enabled: false, intervalMinutes: 180, quietStart: 22, quietEnd: 8, dailyLimit: 3 }
  },
  messages: [], memories: [], tombstones: [], calls: [], usage: {}, avatar: null
});

export function text(value, label, max = 8000, allowEmpty = false) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    throw new ServiceError(400, `${label}需要是${allowEmpty ? "" : "非空"}文本，最多 ${max} 个字符。`);
  }
  return value.trim();
}

export function validMemory(state, memory, at = Date.now(), lookup) {
  const superseded = lookup?.superseded || supersededMessageIds(state);
  return !memory.deleted && !memory.invalidated && !memory.conflicted &&
    (!memory.expiresAt || Date.parse(memory.expiresAt) > at) &&
    memory.sources.every((source) => {
      if (superseded.has(source.id)) return false;
      const message = lookup ? lookup.messages.get(source.id) : state.messages.find((item) => item.id === source.id);
      if (!message || message.revision !== source.revision || message.deleted || message.conflicted || message.status !== "completed") return false;
      if (!source.hash) return true;
      let digest = lookup?.hashes.get(source.id);
      if (!digest) {
        digest = messageHash(message);
        lookup?.hashes.set(source.id, digest);
      }
      return source.hash === digest;
    });
}
export function memoryValidator(state, at = Date.now()) {
  const lookup = { messages: new Map(state.messages.map((message) => [message.id, message])), hashes: new Map(),
    superseded: supersededMessageIds(state) };
  return (memory) => validMemory(state, memory, at, lookup);
}

function bump(item) { item.revision++; item.updatedAt = now(); }
function invalidate(state, id) {
  for (const memory of state.memories) {
    if (!memory.deleted && memory.sources.some((source) => source.id === id)) {
      memory.invalidated = true;
      bump(memory);
    }
  }
}

export function validateAvatar(value) {
  if (value?.format === "niria-live2d-avatar") {
    try { inspectLive2DAvatar(value); }
    catch (error) { throw new ServiceError(400, error.message); }
    return structuredClone(value);
  }
  if (!value || value.format !== "niria-avatar-prototype" || !(value.source || value.original) || typeof value.actions !== "object" || !value.actions || Array.isArray(value.actions)) {
    throw new ServiceError(400, "请选择从形象实验台导出的素材包。");
  }
  const original = value.source || value.original;
  const source = typeof original === "string" ? original : original.data;
  pngBytes(source);
  const actions = {};
  for (const name of ["blink", "smile", "curious", "shy"]) {
    if (value.actions[name]) {
      const image = typeof value.actions[name] === "string" ? value.actions[name] : value.actions[name].data;
      pngBytes(image);
      actions[name] = image;
    }
  }
  let background;
  if (Object.hasOwn(value, "background")) {
    if (!value.background || value.background.version !== 1 || value.background.mode !== "edge-connected" ||
        Object.keys(value.background).some((key) => !["version", "mode"].includes(key))) {
      throw new ServiceError(400, "背景处理设置无效或来自较新版本，未替换现有形象。");
    }
    background = { version: 1, mode: "edge-connected" };
  }
  return { format: "niria-avatar-prototype", version: 1, source, actions, ...(background ? { background } : {}) };
}

export function validateSnapshot(state) {
  if (!state || state.version !== 1 || !state.identity || !Array.isArray(state.messages) ||
      !Array.isArray(state.memories) || !Array.isArray(state.tombstones) || !Array.isArray(state.calls) || !state.settings) {
    throw new ServiceError(400, "备份格式不受支持。");
  }
  const integer = (n, min = 1, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;
  const date = (value) => typeof value === "string" && value.length <= 80 && Number.isFinite(Date.parse(value));
  const references = (refs) => Array.isArray(refs) && refs.length <= 50 &&
    refs.every((s) => typeof s?.id === "string" && s.id.length <= 100 && integer(s.revision));
  const correctionReferences = (refs, max = 50) => Array.isArray(refs) && refs.length <= max &&
    refs.every((s) => typeof s?.id === "string" && s.id.length > 0 && s.id.length <= 100 && integer(s.revision) &&
      (s.hash === undefined || (typeof s.hash === "string" && /^[a-f0-9]{64}$/.test(s.hash))));
  const invalid = () => { throw new ServiceError(400, "备份包含不完整或无效的资料，未修改本机数据。"); };
  for (const field of ["id", "name", "persona", "style", "relationship"]) text(state.identity[field], "角色资料", 8000);
  text(state.identity.userName, "称呼", 80, true);
  if (!integer(state.identity.revision) || !date(state.identity.updatedAt)) invalid();
  if (state.messages.length > 100_000 || state.memories.length > 20_000 || state.tombstones.length > 250_000 || state.calls.length > 500) throw new ServiceError(400, "备份记录数量超过当前上限。");
  const ids = new Set();
  for (const message of state.messages) {
    text(message.id, "消息 ID", 100);
    if (ids.has(message.id)) throw new ServiceError(400, "备份包含重复记录。");
    ids.add(message.id);
    text(message.content, "消息", 16000, true);
    if (!["user", "assistant"].includes(message.role) || !integer(message.revision) ||
        typeof message.deleted !== "boolean" || !date(message.createdAt) || !date(message.updatedAt) ||
        !["pending", "completed", "failed", "cancelled", "stale"].includes(message.status)) {
      throw new ServiceError(400, "备份消息无效。");
    }
    if (message.context && (!references(message.context.messageRefs) || !references(message.context.memoryRefs) ||
      !integer(message.context.personaRevision) || typeof message.context.model !== "string")) invalid();
    if (message.replyTo != null && typeof message.replyTo !== "string") invalid();
    if (message.expression !== undefined && (message.role !== "assistant" || !message.expression ||
        !EXPRESSIONS.includes(message.expression.name) || !date(message.expression.at) ||
        typeof message.expression.avatarKey !== "string" || !/^[a-f0-9]{64}$/.test(message.expression.avatarKey))) invalid();
    if (message.deleted && message.content) invalid();
  }
  for (const memory of state.memories) {
    text(memory.id, "记忆 ID", 100);
    if (ids.has(memory.id)) invalid();
    ids.add(memory.id);
    text(memory.content, "记忆", 2000, true);
    if (!references(memory.sources) || (memory.supersededSources !== undefined && !correctionReferences(memory.supersededSources)) ||
        !["fact", "experience", "inference"].includes(memory.kind)) throw new ServiceError(400, "备份记忆无效。");
    if (!integer(memory.revision) || !date(memory.createdAt) || !date(memory.updatedAt) ||
      typeof memory.deleted !== "boolean" || typeof memory.invalidated !== "boolean" || typeof memory.confirmed !== "boolean" ||
      ![null, true, false].includes(memory.allowModel) || ![null, true, false].includes(memory.allowSync) ||
      (memory.expiresAt !== null && !date(memory.expiresAt)) || (memory.deleted && memory.content)) invalid();
  }
  for (const tombstone of state.tombstones) {
    if (typeof tombstone?.id !== "string" || !["message", "memory"].includes(tombstone.type) || !date(tombstone.at) ||
        (tombstone.forget !== undefined && typeof tombstone.forget !== "boolean") ||
        (tombstone.supersededSources !== undefined && !correctionReferences(tombstone.supersededSources, 1600)) ||
        (tombstone.sources && (!Array.isArray(tombstone.sources) || tombstone.sources.some((id) => typeof id !== "string")))) invalid();
  }
  if (state.conflicts !== undefined && (!Array.isArray(state.conflicts) || state.conflicts.length > 120_000 ||
      state.conflicts.some((conflict) => !conflict || typeof conflict.key !== "string" || typeof conflict.id !== "string" ||
        !["identity", "message", "memory", "avatar"].includes(conflict.kind) || !Array.isArray(conflict.candidates) ||
        conflict.candidates.length < 2 || conflict.candidates.length > 32 ||
        conflict.candidates.some((h) => typeof h?.id !== "string" || typeof h.device !== "string" || !date(h.at) || !h.value || typeof h.value !== "object")))) invalid();
  for (const conflict of state.conflicts || []) if (conflict.kind === "memory") {
    for (const candidate of conflict.candidates) if (!references(candidate.value.sources) ||
      (candidate.value.supersededSources !== undefined && !correctionReferences(candidate.value.supersededSources))) invalid();
  }
  for (const conflict of state.conflicts || []) if (conflict.kind === "avatar")
    for (const candidate of conflict.candidates) validateAvatar(candidate.value);
  if (state.avatar) validateAvatar(state.avatar);
  if (typeof state.settings.allowModel !== "boolean" || typeof state.settings.allowSync !== "boolean" ||
      typeof state.settings.autoMemory !== "boolean") throw new ServiceError(400, "备份隐私设置无效。");
  const care = state.settings.care;
  if (!integer(state.settings.memoryDailyLimit, 0, 50) || !care || typeof care.enabled !== "boolean" ||
      !integer(care.intervalMinutes, 30, 1440) || !integer(care.dailyLimit, 1, 10) ||
      !integer(care.quietStart, 0, 23) || !integer(care.quietEnd, 0, 23)) invalid();
  if (state.usage !== undefined && (!state.usage || typeof state.usage !== "object" || Array.isArray(state.usage) ||
      Object.entries(state.usage).some(([day, counts]) => !/^\d{4}-\d{2}-\d{2}$/.test(day) || !counts ||
        typeof counts !== "object" || Array.isArray(counts) || Object.values(counts).some((n) => !integer(n, 0))))) invalid();
  for (const call of state.calls) {
    if (typeof call?.id !== "string" || !["chat", "memory", "care", "test", "speech"].includes(call.kind) ||
        !["pending", "completed", "failed", "unknown"].includes(call.status) || !date(call.at) ||
        typeof call.model !== "string" || typeof call.endpoint !== "string") invalid();
  }
  return state;
}

export class CompanionStore {
  constructor(filename = ":memory:") {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON");
      this.persistence = new SQLiteState(this.db);
      this.listeners = new Set();
      this.state = this.persistence.initialize(defaults, validateSnapshot);
      this.messageVersion = randomUUID();
      this.memoryVersion = randomUUID();
      this.history = new MessageHistory(this);
      this.memories = new MemoryList(this, memoryValidator);
      const before = this.snapshot();
      this.state.usage ||= {};
      // Interrupted requests are never silently submitted again on restart.
      for (const message of this.state.messages) {
        if (message.status === "pending") { message.status = "failed"; message.error = "上次请求被中断，请手动重试。"; }
      }
      for (const call of this.state.calls) if (call.status === "pending") call.status = "unknown";
      // Add content identity to old numeric revisions before the first multi-device merge.
      const messages = new Map(this.state.messages.map((message) => [message.id, message]));
      for (const memory of this.state.memories) for (const source of memory.sources) {
        const candidate = messages.get(source.id);
        const message = candidate?.revision === source.revision && !candidate.deleted ? candidate : null;
        if (message && !source.hash && !memory.invalidated) source.hash = messageHash(message);
      }
      applyStateDeletions(this.state);
      this.save(before);
    } catch (error) { this.db.close(); throw error; }
  }
  save(before) {
    invalidateSupersededMemories(this.state);
    clearMemoryTermCache();
    const changes = this.persistence.save(this.state, before);
    if (changes.messages) this.messageVersion = randomUUID();
    if (changes.memories || (before && !isDeepStrictEqual(this.state.conflicts, before.conflicts))) this.memoryVersion = randomUUID();
  }
  close() { clearMemoryTermCache(); this.db.close(); }
  get avatarKey() {
    if (this.avatarReference !== this.state.avatar) {
      this.avatarReference = this.state.avatar;
      this.avatarDigest = this.state.avatar ? createHash("sha256").update(JSON.stringify(this.state.avatar)).digest("hex") : null;
    }
    return this.avatarDigest || null;
  }
  snapshot() { return structuredClone(this.state); }
  clientSnapshot({ assets = true, recentMessages = false, includeMemories = true } = {}) {
    const data = { ...this.state };
    if (!assets) delete data.avatar;
    if (!includeMemories) { delete data.memories; data.memoryWindow = this.memories.summary(); }
    if (recentMessages) {
      data.messages = this.history.latest();
      data.messageWindow = this.history.summary();
    }
    return structuredClone(data);
  }
  memorySourcePreview(id, revision) {
    const memory = this.state.memories.find((item) => item.id === id && !item.deleted);
    if (!memory) throw new ServiceError(404, "这条记忆已删除，请刷新列表。");
    if (memory.revision !== revision) throw new ServiceError(409, "记忆已经变化，请重新展开来源。");
    const preview = (sources) => sources.map((source) => {
        const row = this.db.prepare("SELECT data FROM message_records WHERE id=? AND deleted=0").get(source.id);
        const message = row ? JSON.parse(row.data) : null;
        const available = !!message && !message.conflicted && message.status === "completed" &&
          message.revision === source.revision && (!source.hash || source.hash === messageHash(message));
        return { id: source.id, available, content: available ? message.content : "来源已修改、冲突或删除，旧内容不再引用。" };
      });
    return { id, revision, sources: preview(memory.sources),
      ...(memory.supersededSources?.length ? { supersededSources: preview(memory.supersededSources) } : {}) };
  }
  memoryReferences({ id, revision, expected } = {}) {
    if (typeof id !== "string" || !id || id.length > 100 || !Number.isSafeInteger(revision) || revision < 1 ||
      !expected || typeof expected !== "object" || !Array.isArray(expected.memoryRefs) || expected.memoryRefs.length > 50) {
      throw new ServiceError(400, "引用记忆参数无效。");
    }
    const message = this.state.messages.find((item) => item.id === id && !item.deleted && !item.conflicted);
    if (!message?.context || message.status !== "completed") throw new ServiceError(404, "这条回复已删除或不再可读。");
    if (message.revision !== revision || !isDeepStrictEqual(message.context, expected)) throw new ServiceError(409, "这条回复的引用已经变化，请重新打开查看。");
    const memories = new Map(this.state.memories.map((memory) => [memory.id, memory])), valid = memoryValidator(this.state);
    let validUntil = null;
    const references = message.context.memoryRefs.map((ref) => {
      const memory = memories.get(ref.id);
      const available = !!memory && valid(memory) && memory.revision === ref.revision &&
        (!ref.hash || ref.hash === createHash("sha256").update(JSON.stringify(memory)).digest("hex"));
      const expiry = available ? Date.parse(memory.expiresAt) : NaN;
      if (Number.isFinite(expiry)) validUntil = Math.min(validUntil ?? expiry, expiry);
      return { id: ref.id, available, reason: ref.reason || null, content: available ? memory.content : "这条记忆已变化、过期或删除，旧正文不再展示。" };
    });
    return { id, revision, memories: references, validUntil };
  }
  mutate(fn) {
    const before = this.snapshot();
    const previousMessageVersion = this.messageVersion;
    const previousMemoryVersion = this.memoryVersion;
    const rollback = [];
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const onRollback = (restore) => { if (typeof restore === "function") rollback.push(restore); };
      const result = fn(this.state, onRollback);
      if (this.state.conflicts?.length) {
        const deleted = new Set(this.state.tombstones.map((t) => `${t.type}:${t.id}`));
        this.state.conflicts = this.state.conflicts.filter((c) => !deleted.has(c.key));
      }
      this.save(before);
      for (const listener of this.listeners) onRollback(listener());
      if (ownsTransaction) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (ownsTransaction) this.db.exec("ROLLBACK");
      this.state = before;
      this.messageVersion = previousMessageVersion;
      this.memoryVersion = previousMemoryVersion;
      for (const restore of rollback.reverse()) restore();
      throw error;
    }
  }
  identity(input) {
    return this.mutate((state) => {
      if (state.identity.conflicted) throw new ServiceError(409, "请先在“多端同步”中选择伴侣资料的冲突版本。");
      for (const [key, max] of [["name", 80], ["userName", 80], ["persona", 4000], ["style", 2000], ["relationship", 2000]]) {
        if (Object.hasOwn(input, key)) state.identity[key] = text(input[key], "角色资料", max, key === "userName");
      }
      bump(state.identity);
    });
  }
  settings(input) {
    return this.mutate((state) => {
      for (const key of ["allowModel", "allowSync", "autoMemory"]) {
        if (Object.hasOwn(input, key)) {
          if (typeof input[key] !== "boolean") throw new ServiceError(400, "开关设置无效。");
          state.settings[key] = input[key];
        }
      }
      if (Object.hasOwn(input, "memoryDailyLimit")) {
        if (!Number.isInteger(input.memoryDailyLimit) || input.memoryDailyLimit < 0 || input.memoryDailyLimit > 50) throw new ServiceError(400, "记忆整理上限需要在 0 到 50 之间。");
        state.settings.memoryDailyLimit = input.memoryDailyLimit;
      }
      if (input.allowSync === true) {
        for (const memory of state.memories) if (memory.allowSync === null) delete memory.syncExcluded;
        const blocked = permissionBlockedMessageIds(state, "allowSync");
        for (const message of state.messages) if (!blocked.has(message.id)) delete message.syncExcluded;
      }
      if (input.care) {
        const c = { ...state.settings.care, ...input.care };
        if (typeof c.enabled !== "boolean" || !Number.isInteger(c.intervalMinutes) || c.intervalMinutes < 30 || c.intervalMinutes > 1440 ||
          !Number.isInteger(c.dailyLimit) || c.dailyLimit < 1 || c.dailyLimit > 10 ||
          ![c.quietStart, c.quietEnd].every((n) => Number.isInteger(n) && n >= 0 && n <= 23)) {
          throw new ServiceError(400, "请检查关心频率、每日上限和免打扰时间。");
        }
        state.settings.care = c;
      }
    });
  }
  addUser(content) {
    return this.mutate((state) => {
      const message = { id: randomUUID(), role: "user", content: text(content, "消息", 16000), revision: 1, createdAt: now(), updatedAt: now(), status: "completed", deleted: false };
      state.messages.push(message);
      return structuredClone(message);
    });
  }
  findMessage(id) {
    const value = this.state.messages.find((m) => m.id === id && !m.deleted);
    if (!value) throw new ServiceError(404, "这条消息已不存在。");
    return value;
  }
  editMessage(id, content) {
    this.mutate((state) => {
      const message = this.findMessage(id);
      if (message.conflicted) throw new ServiceError(409, "请先在“多端同步”中选择这条消息的冲突版本。");
      const last = state.messages.findLast((m) => m.role === "user" && !m.deleted);
      if (last?.id !== id || message.role !== "user") throw new ServiceError(409, "当前只支持编辑最近一条用户消息。");
      message.content = text(content, "消息", 16000);
      bump(message);
      invalidate(state, id);
      for (const reply of state.messages.filter((m) => m.replyTo === id && !m.deleted)) this.removeMessageInState(state, reply);
    });
  }
  removeMessageInState(state, message, forget = false) {
    applyStateDeletions(state, { roots: [{ id: message.id, type: "message", at: now(), ...(forget ? { forget: true } : {}) }] });
  }
  deleteMessage(id) {
    this.mutate((state) => {
      const message = this.findMessage(id);
      this.removeMessageInState(state, message);
    });
  }
  addMemory(input, { automatic = false } = {}) {
    return this.mutate((state) => {
      const content = text(input.content, "记忆", 2000);
      const kind = ["fact", "experience", "inference"].includes(input.kind) ? input.kind : "fact";
      const sources = Array.isArray(input.sources) ? input.sources : [];
      if (sources.length > 20 || sources.some((source) => !state.messages.some((m) =>
        m.id === source.id && m.revision === source.revision && !m.deleted && !m.conflicted &&
        (!source.hash || source.hash === messageHash(m)) && m.status === "completed"))) {
        throw new ServiceError(409, "来源消息已经改变，未保存这条旧记忆。");
      }
      if (automatic && !automaticMemoryAllowed(state, sources)) return null;
      const valid = memoryValidator(state);
      if (state.memories.some((m) => m.content === content && valid(m))) return null;
      const expiresAt = this.memoryExpiry(input.expiresAt === undefined ? null : input.expiresAt);
      const memory = {
        id: randomUUID(), content, kind, sources: sources.map((source) => ({
          ...source, hash: messageHash(state.messages.find((m) => m.id === source.id))
        })), expiresAt,
        confirmed: automatic ? false : true, allowModel: null, allowSync: null,
        deleted: false, invalidated: false, revision: 1, createdAt: now(), updatedAt: now()
      };
      state.memories.push(memory);
      return memory.id;
    });
  }
  memoryExpiry(value) {
    if (value !== null && (typeof value !== "string" || value.length > 80 || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())) {
      throw new ServiceError(400, "请选择未来的记忆到期时间，或设为长期保留。");
    }
    return value === null ? null : new Date(value).toISOString();
  }
  editMemory(id, input) {
    this.mutate((state) => {
      const memory = state.memories.find((m) => m.id === id && !m.deleted);
      if (!memory) throw new ServiceError(404, "这条记忆已不存在。");
      if (Object.hasOwn(input, "expected") && !isDeepStrictEqual(input.expected, memory)) throw new ServiceError(409, "记忆已在别处改变，请关闭编辑并重新查看，未覆盖新版本。");
      if ((Object.hasOwn(input, "content") || Object.hasOwn(input, "kind") || Object.hasOwn(input, "expiresAt")) && memory.conflicted) {
        throw new ServiceError(409, "请先在“多端同步”中选择这条记忆的冲突版本。");
      }
      if (Object.hasOwn(input, "content")) {
        const content = text(input.content, "记忆", 2000);
        if (content !== memory.content) {
          memory.content = content;
          const superseded = mergeSourceReferences(memory.supersededSources || [], memory.sources);
          if (superseded.length > 50) throw new ServiceError(400, "原关联记录超过当前上限，未保存这次纠正。");
          if (superseded.length) memory.supersededSources = superseded;
          // The correction is user-authored; former sources remain associations,
          // rather than validity dependencies or a copy of their old prose.
          memory.sources = [];
          memory.invalidated = false;
          memory.confirmed = true;
        }
      }
      if (Object.hasOwn(input, "kind")) {
        if (!["fact", "experience", "inference"].includes(input.kind)) throw new ServiceError(400, "记忆类型无效。");
        memory.kind = input.kind;
      }
      if (Object.hasOwn(input, "expiresAt")) memory.expiresAt = this.memoryExpiry(input.expiresAt);
      for (const field of ["allowModel", "allowSync"]) {
        if (Object.hasOwn(input, field)) {
          if (input[field] !== null && typeof input[field] !== "boolean") throw new ServiceError(400, "记忆权限无效。");
          memory[field] = input[field];
        }
      }
      if (typeof input.confirmed === "boolean") memory.confirmed = input.confirmed;
      if (Object.hasOwn(input, "allowSync") && (input.allowSync ?? state.settings.allowSync)) {
        delete memory.syncExcluded;
        const blocked = permissionBlockedMessageIds(state, "allowSync");
        const associated = linkedMessageIds(state, associatedSources(memory).map((source) => source.id));
        for (const message of state.messages) if (associated.has(message.id) && !blocked.has(message.id)) delete message.syncExcluded;
      }
      bump(memory);
    });
  }
  forgettingPreview(input) { return forgettingPreview(this.state, input); }
  deleteMemory(id, forgetSources = false, previewToken) {
    this.mutate((state) => {
      const memory = state.memories.find((m) => m.id === id && !m.deleted);
      if (!memory) throw new ServiceError(404, "这条记忆已不存在。");
      if (forgetSources) {
        const plan = planForgetting(state, id);
        if (previewToken !== undefined && previewToken !== plan.token) throw new ServiceError(409, "相关记录已经变化，请重新查看遗忘清单后确认。");
        applyStateDeletions(state, { roots: plan.roots });
      } else {
        const record = stateDeletionRecords(state).find((item) => item.kind === "memory" && item.id === id);
        const sources = [...new Set(record.values.flatMap((value) => associatedSources(value).map((source) => source.id)))].sort();
        const supersededSources = mergeSourceReferences(...record.values.map((value) => value.supersededSources || []));
        applyStateDeletions(state, { roots: [{ id, type: "memory", sources, at: now(),
          ...(supersededSources.length ? { supersededSources } : {}) }] });
      }
    });
  }
  exportData() {
    const state = this.snapshot();
    state.calls = [];
    if (this.exportExtension) state.syncState = this.exportExtension();
    return state;
  }
  restore(data) {
    const next = validateSnapshot(structuredClone(data));
    const applyExtension = this.prepareRestore?.(next);
    delete next.syncState;
    preserveCorrections(next, this.state);
    // Local deletion decisions take precedence when an older backup is restored.
    const tombstones = mergeDeletionMarkers(next.tombstones, this.state.tombstones);
    next.tombstones = [...tombstones.values()];
    applyStateDeletions(next, { revise: false });
    invalidateSupersededMemories(next, { revise: false });
    for (const message of next.messages) {
      if (message.status === "pending") message.status = "failed";
    }
    const valid = memoryValidator(next);
    for (const memory of next.memories) {
      if (!valid(memory)) memory.invalidated = true;
    }
    validateSnapshot(next);
    this.mutate((_state, onRollback) => { this.state = next; onRollback(applyExtension?.()); });
  }
}
