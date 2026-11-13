import { randomUUID, randomBytes } from "node:crypto";
import { WebDAV } from "./webdav.mjs";
import { emptyManifest, observe, mergeManifest, validateManifest, materialize, project, hash, recordKey, seal, unseal } from "./sync-model.mjs";
import { now, defaults } from "./store.mjs";
import { ServiceError } from "../prototype/image-service.mjs";
import { pairingCode, parsePairing, keyTag, keyMeta } from "./sync-pairing.mjs";
import { SyncKeyRotation } from "./sync-rotation.mjs";
import { stateDeletionRecords } from "./deletion-cascade.mjs";
import { SyncStorage } from "./sync-storage.mjs";
export { pairingCode, parsePairing } from "./sync-pairing.mjs";

const uuid = (s) => typeof s === "string" && /^[a-f0-9-]{36}$/.test(s);

export class SyncService {
  constructor(store, { fetchImpl = fetch, beforeApply = () => {}, timeoutMs = 90_000 } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.beforeApply = beforeApply;
    this.timeoutMs = timeoutMs;
    this.connection = null;
    this.pair = null;
    this.active = null;
    this.auto = false;
    this.lastAttempt = 0;
    this.lastError = null;
    this.capabilities = null;
    this.persistence = new SyncStorage(store.db);
    this.meta = this.persistence.load() || {
      device: randomUUID(), vaultId: null, manifest: emptyManifest(store.state.identity.id), fingerprints: {}, lastSuccess: null
    };
    this.rotation = new SyncKeyRotation(this);
    if (this.meta.manifest.records.length) validateManifest(this.meta.manifest);
    if (this.meta.vaultId && this.meta.manifest.identityId === store.state.identity.id) {
      this.meta.manifest = observe(this.meta.manifest, this.meta.fingerprints, store.state, this.meta.device);
    }
    this.persist();
    this.applying = false;
    store.exportExtension = () => {
      if (!this.meta.vaultId) return null;
      const manifest = structuredClone(this.meta.manifest);
      const projected = project(store.state);
      for (const record of manifest.records) for (const head of record.heads) {
        const local = projected.get(recordKey(record.kind, record.id));
        if (local && head.value !== null && hash(head.value) === hash(local.value)) head.value = { backupRef: recordKey(record.kind, record.id) };
      }
      return { vaultId: this.meta.vaultId, manifest };
    };
    store.prepareRestore = (next) => {
      if (this.meta.rotation) throw new ServiceError(409, "请先核对换钥结果，再在此设备恢复备份；本机恢复信息已保留。");
      const recovered = next.syncState;
      if (recovered) {
        if (!uuid(recovered.vaultId)) throw new ServiceError(400, "备份同步空间无效。");
        const projected = project(next);
        for (const record of recovered.manifest?.records || []) for (const head of record.heads || []) {
          if (head.value?.backupRef) {
            const expected = recordKey(record.kind, record.id);
            const local = projected.get(expected);
            if (head.value.backupRef !== expected || !local || local.value === null) throw new ServiceError(400, "备份的同步资料引用无效。");
            head.value = structuredClone(local.value);
          }
        }
        validateManifest(recovered.manifest);
        if (recovered.manifest.identityId !== next.identity.id) throw new ServiceError(400, "备份同步身份不一致。");
      }
      if (this.active) throw new ServiceError(409, "请先停止同步，再恢复备份。");
      // Capture the backup projection before local deletion/correction decisions
      // are applied, so those retained changes create new sync revisions.
      const fingerprints = Object.fromEntries([...project(next)].map(([key, r]) => [key, hash(r.value)]));
      const restoredMemories = new Map(next.memories.map((memory) => [memory.id, memory]));
      const retainedCorrections = new Set(store.state.identity.id === next.identity.id ? store.state.memories
        .filter((memory) => !memory.deleted && memory.supersededSources?.length &&
          !restoredMemories.get(memory.id)?.deleted && !restoredMemories.get(memory.id)?.supersededSources?.length)
        .map((memory) => memory.id) : []);
      return () => {
        const previous = this.meta;
        let manifest = recovered ? structuredClone(recovered.manifest) : emptyManifest(next.identity.id);
        if (recovered?.vaultId === previous.vaultId && previous.manifest.identityId === next.identity.id && retainedCorrections.size) {
          manifest = this.merge(manifest, { ...emptyManifest(next.identity.id),
            records: previous.manifest.records.filter((record) => record.kind === "memory" && retainedCorrections.has(record.id)) });
        }
        this.meta = {
          device: previous.device, vaultId: recovered?.vaultId || null,
          manifest,
          fingerprints, lastSuccess: null
        };
        try { this.persist(); }
        catch (error) { this.meta = previous; throw error; }
        this.lock();
        return () => { this.meta = previous; };
      };
    };
    store.listeners.add(() => {
      if (this.applying || !this.meta.vaultId || this.meta.manifest.identityId !== store.state.identity.id) return;
      const previous = { ...this.meta, fingerprints: { ...this.meta.fingerprints } };
      try {
        this.meta.manifest = observe(this.meta.manifest, this.meta.fingerprints, store.state, this.meta.device);
        this.persist();
      } catch (error) { this.meta = previous; throw error; }
      return () => { this.meta = previous; };
    });
  }
  persist() {
    this.persistence.save(this.meta);
  }
  merge(left, right) { return mergeManifest(left, right, stateDeletionRecords(this.store.state)); }
  commit(state, meta) {
    const previous = this.store.snapshot();
    const previousMessageVersion = this.store.messageVersion;
    const previousMemoryVersion = this.store.memoryVersion;
    this.store.db.exec("BEGIN IMMEDIATE");
    this.applying = true;
    try {
      this.store.mutate(() => { this.store.state = state; });
      this.persistence.save(meta);
      this.store.db.exec("COMMIT");
      this.meta = meta;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      this.store.state = previous;
      this.store.messageVersion = previousMessageVersion;
      this.store.memoryVersion = previousMemoryVersion;
      throw error;
    } finally { this.applying = false; }
  }
  status() {
    return {
      configured: !!this.connection, unlocked: !!this.pair, busy: !!this.active, auto: this.auto,
      baseUrl: this.connection?.baseUrl || "", device: this.meta.device, vaultId: this.pair?.vaultId || this.meta.vaultId,
      lastSuccess: this.meta.lastSuccess, error: this.lastError, capabilities: this.capabilities,
      rotation: this.rotation.status(),
      conflicts: this.store.state.conflicts || []
    };
  }
  configure(input) {
    if (this.active) throw new ServiceError(409, "同步正在执行，请先停止后再更换连接。");
    const connection = new WebDAV(input, { fetchImpl: this.fetchImpl });
    if (typeof input.auto !== "boolean") throw new ServiceError(400, "同步开关无效。");
    this.rotation.assertTarget(connection);
    this.rotation.discard();
    this.connection = connection;
    this.auto = this.meta.rotation ? false : input.auto;
    this.capabilities = null;
    this.lastError = null;
    return this.status();
  }
  createPair() {
    if (this.active) throw new ServiceError(409, "请等候当前同步完成。");
    if (this.meta.vaultId || this.pair) throw new ServiceError(409, "此设备已属于一个同步空间，请使用已有配对码。");
    const pair = { vaultId: randomUUID(), identityId: this.store.state.identity.id, key: randomBytes(32) };
    try {
      const fingerprints = {};
      const manifest = observe(emptyManifest(pair.identityId), fingerprints, this.store.state, this.meta.device);
      const meta = keyMeta({ ...this.meta, vaultId: pair.vaultId, manifest, fingerprints }, pair);
      // A newly paired backup must already contain a valid revision graph.
      // Publish the in-memory pair only after all local sync tables commit.
      this.persistence.save(meta);
      this.meta = meta;
      this.pair = pair;
      return { code: pairingCode(pair) };
    } catch (error) {
      pair.key.fill(0);
      throw error;
    }
  }
  unlock(code) {
    if (this.active) throw new ServiceError(409, "请等候当前同步完成。");
    const next = parsePairing(code);
    if (next.identityId !== this.store.state.identity.id) { next.key.fill(0); throw new ServiceError(409, "配对码属于另一位伴侣。请在空白新设备使用“加入并恢复”。"); }
    if (this.meta.vaultId && this.meta.vaultId !== next.vaultId) { next.key.fill(0); throw new ServiceError(409, "配对码与本机记录的同步空间不一致。"); }
    if (this.meta.retiredKeyTags?.includes(keyTag(next))) { next.key.fill(0); throw new ServiceError(409, "这个配对码已在本机停用，请使用换钥后的新配对码。"); }
    this.rotation.discard();
    this.pair?.key.fill(0);
    this.pair = next;
    this.meta.vaultId = next.vaultId;
    this.persist();
    return this.status();
  }
  exportPair() {
    if (!this.pair) throw new ServiceError(400, "请先使用配对码解锁，或在首台设备创建同步空间。");
    return { code: pairingCode(this.pair) };
  }
  lock() {
    this.active?.abort();
    this.auto = false;
    this.rotation.discard();
    this.pair?.key.fill(0);
    this.pair = null;
    this.connection = null;
    this.capabilities = null;
    return { ok: true };
  }
  async exclusive(fn) {
    if (this.active) throw new ServiceError(409, "已有同步任务正在处理。");
    const controller = new AbortController();
    this.active = controller;
    this.lastAttempt = Date.now();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await fn(controller.signal);
      this.lastError = null;
      return result;
    } catch (error) {
      this.lastError = error instanceof ServiceError ? error.message : "同步未完成，本机资料已保留。";
      throw error instanceof ServiceError ? error : new ServiceError(502, this.lastError);
    } finally { clearTimeout(timer); this.active = null; }
  }
  requirePair() {
    if (!this.connection || !this.pair) throw new ServiceError(400, "请配置 WebDAV，并创建或解锁同步空间。");
    if (this.pair.identityId !== this.store.state.identity.id) throw new ServiceError(409, "本机伴侣身份已改变，请用对应配对码重新解锁。");
  }
  folder(pair = this.pair) { return `niria-${pair.vaultId}/`; }
  async probe() {
    this.requirePair();
    return this.exclusive(async (signal) => {
      this.capabilities = await this.connection.probe(this.folder(), signal);
      return this.capabilities;
    });
  }
  async sync() {
    this.requirePair();
    this.rotation.assertCanSync();
    const pair = this.pair, connection = this.connection;
    return this.exclusive(async (signal) => {
      if (!this.capabilities) this.capabilities = await connection.probe(this.folder(pair), signal);
      for (let attempt = 0; attempt < 4; attempt++) {
        if (signal.aborted) throw new ServiceError(504, "同步已停止。");
        const remote = await connection.read(`${this.folder(pair)}state.niria`, signal);
        if (!remote && this.meta.keyTag && keyTag(pair) !== this.meta.keyTag) {
          throw new ServiceError(409, "远端资料不存在，无法验证新配对码；未上传或改写同步空间。");
        }
        const observed = observe(this.meta.manifest, this.meta.fingerprints, this.store.state, this.meta.device);
        // Persist exact outgoing version IDs before I/O so an unknown PUT outcome
        // can be merged idempotently after a timeout or process interruption.
        this.meta.manifest = observed;
        this.persist();
        let manifest = observed;
        if (remote) manifest = this.merge(manifest, unseal(remote.data.toString("utf8"), pair.key, pair.vaultId, pair.identityId));
        validateManifest(manifest);
        const localDigest = hash([...project(this.store.state)]);
        const encrypted = seal(manifest, pair.key, pair.vaultId);
        const committed = await connection.write(`${this.folder(pair)}state.niria`, encrypted, remote?.etag || null, signal);
        if (!committed) continue;
        if (signal.aborted || this.pair !== pair) throw new ServiceError(504, "同步已停止，远端写入结果会在下次核对。");
        // Local edits during upload must be observed as children of the old local frontier,
        // not of the remote frontier that the editor has not yet seen.
        if (localDigest !== hash([...project(this.store.state)])) {
          this.meta.manifest = observe(this.meta.manifest, this.meta.fingerprints, this.store.state, this.meta.device);
          this.persist();
          continue;
        }
        this.commitManifest(manifest, pair);
        return this.status();
      }
      throw new ServiceError(409, "资料正在另一端或本机连续更新，本次未覆盖新版本，请稍后再次同步。");
    });
  }
  commitManifest(manifest, pair, extra = {}) {
    const state = materialize(manifest, this.store.state);
    if (hash([state.identity, state.messages, state.memories, state.avatar, state.conflicts]) !==
        hash([this.store.state.identity, this.store.state.messages, this.store.state.memories, this.store.state.avatar, this.store.state.conflicts || []])) this.beforeApply();
    const fingerprints = Object.fromEntries([...project(state)].map(([key, record]) => [key, hash(record.value)]));
    this.commit(state, keyMeta({ ...this.meta, manifest, fingerprints, lastSuccess: now(), ...extra }, pair));
  }
  async join(code) {
    if (!this.connection) throw new ServiceError(400, "请先配置 WebDAV 连接。");
    if (this.meta.vaultId || this.store.state.messages.length || this.store.state.memories.length || this.store.state.avatar ||
        this.store.state.identity.revision !== 1) throw new ServiceError(409, "加入并恢复只允许在空白新设备执行。已有资料请先备份并使用相同身份的配对码。");
    const pair = parsePairing(code), connection = this.connection;
    try {
      return await this.exclusive(async (signal) => {
        const remote = await connection.read(`${this.folder(pair)}state.niria`, signal);
        if (!remote) throw new ServiceError(404, "这个同步空间还没有资料，请先在原设备成功同步一次。");
        const manifest = unseal(remote.data.toString("utf8"), pair.key, pair.vaultId, pair.identityId);
        if (signal.aborted || this.store.state.messages.length || this.store.state.memories.length ||
            this.store.state.avatar || this.store.state.identity.revision !== 1) throw new ServiceError(409, "本机资料已经改变，未替换伴侣。");
        const empty = defaults();
        empty.settings = this.store.snapshot().settings;
        const state = materialize(manifest, empty);
        this.beforeApply();
        const meta = keyMeta({ ...this.meta, vaultId: pair.vaultId, manifest,
          fingerprints: Object.fromEntries([...project(state)].map(([key, r]) => [key, hash(r.value)])), lastSuccess: now() }, pair);
        this.commit(state, meta);
        this.pair = pair;
        return this.status();
      });
    } catch (error) { pair.key.fill(0); throw error; }
  }
  resolve(key, headId) {
    if (this.active) throw new ServiceError(409, "请等候当前同步结束，再解决冲突。");
    const conflict = this.store.state.conflicts?.find((c) => c.key === key);
    const record = this.meta.manifest.records.find((r) => recordKey(r.kind, r.id) === key);
    const selected = record?.heads.find((h) => h.id === headId);
    if (!conflict || !selected) throw new ServiceError(409, "冲突版本已变化，请刷新后重新选择。");
    const manifest = structuredClone(this.meta.manifest);
    const target = manifest.records.find((r) => recordKey(r.kind, r.id) === key);
    const id = randomUUID();
    target.nodes.push({ id, parents: target.heads.map((h) => h.id) });
    target.heads = [{ id, device: this.meta.device, at: now(), value: structuredClone(selected.value) }];
    const state = materialize(manifest, this.store.state);
    this.beforeApply();
    this.commit(state, { ...this.meta, manifest,
      fingerprints: Object.fromEntries([...project(state)].map(([k, r]) => [k, hash(r.value)])) });
    return this.status();
  }
  async tick() {
    if (!this.auto || !this.pair || !this.connection || this.active || this.rotation.plan || this.meta.rotation || Date.now() - this.lastAttempt < 5 * 60_000) return false;
    await this.sync();
    return true;
  }
}
