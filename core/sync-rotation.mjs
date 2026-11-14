import { randomUUID, randomBytes } from "node:crypto";
import { pairingCode, parsePairing, keyTag } from "./sync-pairing.mjs";
import { observe, unseal, seal } from "./sync-model.mjs";
import { now } from "./store.mjs";
import { ServiceError } from "../prototype/image-service.mjs";
import { checkSync } from "./webdav.mjs";

// Only nonsecret identifiers enter sync_meta. Recovery keys remain in memory
// and in the recovery file the user explicitly saves before the remote write.
export class SyncKeyRotation {
  constructor(service) { this.service = service; this.plan = null; }
  status() {
    return { prepared: !!this.plan && !this.service.meta.rotation, pending: !!this.service.meta.rotation, id: this.plan?.id || null };
  }
  discard(preserve) {
    if (this.plan?.next !== preserve) this.plan?.next.key.fill(0);
    this.plan = null;
  }
  prepare() {
    const s = this.service;
    s.requirePair();
    if (s.active) throw new ServiceError(409, "请等候当前同步完成。");
    if (s.meta.rotation) throw new ServiceError(409, "上次换钥结果尚待核对，请先用已保存的新旧配对码核对远端。");
    if (!this.plan) this.plan = {
      id: randomUUID(), current: s.pair, connection: s.connection,
      next: { ...s.pair, key: randomBytes(32) }
    };
    s.auto = false;
    return { id: this.plan.id, code: pairingCode(this.plan.next), previousCode: pairingCode(this.plan.current) };
  }
  cancel() {
    const s = this.service;
    if (s.active || s.meta.rotation) throw new ServiceError(409, "换钥已经开始，请先停止任务并只读核对结果，不能直接丢弃恢复信息。");
    this.discard();
    return s.status();
  }
  assertCanSync() {
    if (this.service.meta.rotation) throw new ServiceError(409, "换钥结果尚待核对，已暂停上传。请用已保存的新旧配对码执行只读核对。");
    if (this.plan) throw new ServiceError(409, "请先完成或取消待确认的换钥，再同步。");
  }
  assertTarget(connection) {
    if (this.service.meta.rotation && connection.baseUrl !== this.service.meta.rotation.baseUrl) {
      throw new ServiceError(409, "请连接上次换钥使用的 WebDAV 文件夹，完成结果核对后再更换地址。");
    }
  }
  async activate({ id, confirmed }, beforeWrite = async () => {}) {
    const s = this.service, plan = this.plan;
    s.requirePair();
    if (confirmed !== true) throw new ServiceError(400, "请先保存新旧配对码，并明确确认已保存，再更换同步密钥。");
    if (!plan || id !== plan.id || plan.current !== s.pair || plan.connection !== s.connection || s.meta.rotation) {
      throw new ServiceError(409, "换钥准备已变化，请重新生成并保存配对码；已有待核对结果时先完成核对。");
    }
    return s.exclusive(async (signal) => {
      let remoteMayHaveChanged = false;
      const pair = plan.current, connection = plan.connection;
      s.auto = false;
      const previous = s.meta;
      s.meta = { ...previous,
        rotation: { id, fromTag: keyTag(pair), toTag: keyTag(plan.next), startedAt: now(), baseUrl: connection.baseUrl },
        keyTag: previous.keyTag || keyTag(pair) };
      try { s.persist(); }
      catch {
        s.meta = previous;
        throw new ServiceError(503, "本机未能保存换钥准备记录，未向远端提交换钥，请检查本机存储后再试。");
      }
      try {
        // Remove any saved old key before the remote write. The new key has
        // already been saved by the user; saving it in Windows is a separate opt-in.
        await beforeWrite();
        checkSync(signal);
        if (!s.capabilities) {
          const capabilities = await connection.probe(s.folder(pair), signal);
          checkSync(signal);
          s.capabilities = capabilities;
        }
        for (let attempt = 0; attempt < 4; attempt++) {
          checkSync(signal);
          const remote = await connection.read(`${s.folder(pair)}state.niria`, signal);
          checkSync(signal);
          if (!remote) throw new ServiceError(404, "同步空间还没有远端资料。请取消换钥，先成功同步一次。");
          const received = unseal(remote.data.toString("utf8"), pair.key, pair.vaultId, pair.identityId);
          const observed = observe(s.meta.manifest, s.meta.fingerprints, s.store.state, s.meta.device);
          s.meta.manifest = observed;
          s.persist();
          const manifest = s.merge(observed, received);
          const encrypted = seal(manifest, plan.next.key, pair.vaultId);
          if (signal.aborted) throw new ServiceError(504, "换钥已停止。");
          remoteMayHaveChanged = true;
          const committed = await connection.write(`${s.folder(pair)}state.niria`, encrypted, remote.etag, signal);
          if (!committed) { remoteMayHaveChanged = false; continue; }
          if (signal.aborted || s.pair !== pair) throw new ServiceError(504, "换钥已停止。");
          // Keep edits made while uploading as their original branches.
          const latest = observe(s.meta.manifest, s.meta.fingerprints, s.store.state, s.meta.device);
          s.commitManifest(s.merge(manifest, latest), plan.next, { rotation: null });
          s.pair = plan.next;
          pair.key.fill(0);
          this.discard(s.pair);
          return s.status();
        }
        throw new ServiceError(409, "另一设备持续更新资料，未更换密钥；请稍后重试。");
      } catch (error) {
        if (remoteMayHaveChanged) {
          throw new ServiceError(502, "换钥结果尚未确认，已暂停上传和自动同步。请保留新旧配对码，并执行只读核对；不要重新发起换钥。");
        }
        const cleared = { ...s.meta, rotation: null };
        try { s.persistence.save(cleared); }
        catch {
          throw new ServiceError(503, "本机未能保存换钥停止状态，已保留待核对信息；请检查本机存储后再只读核对。");
        }
        s.meta = cleared;
        throw error;
      }
    });
  }
  async recover(code) {
    const s = this.service, pending = s.meta.rotation;
    if (!pending) throw new ServiceError(409, "本机没有待核对的换钥。其他设备请用新配对码解锁后同步。");
    if (!s.connection) throw new ServiceError(400, "请先配置原 WebDAV 连接，再只读核对。");
    this.assertTarget(s.connection);
    const pair = parsePairing(code);
    const tag = keyTag(pair);
    if (pair.vaultId !== s.meta.vaultId || pair.identityId !== s.store.state.identity.id ||
        ![pending.fromTag, pending.toTag].includes(tag)) {
      pair.key.fill(0);
      throw new ServiceError(400, "请使用这次换钥保存的新配对码或原配对码。");
    }
    let adopted = false;
    try {
      return await s.exclusive(async (signal) => {
        const remote = await s.connection.read(`${s.folder(pair)}state.niria`, signal);
        if (!remote) throw new ServiceError(404, "远端资料不存在，保留待核对状态；请检查原文件夹或从加密备份恢复。");
        const manifest = unseal(remote.data.toString("utf8"), pair.key, pair.vaultId, pair.identityId);
        if (signal.aborted) throw new ServiceError(504, "核对已停止。");
        const observed = observe(s.meta.manifest, s.meta.fingerprints, s.store.state, s.meta.device);
        s.commitManifest(s.merge(observed, manifest), pair, { rotation: null });
        s.pair?.key.fill(0);
        s.pair = pair;
        s.auto = false;
        this.discard(pair);
        adopted = true;
        return { ...s.status(), keyChanged: tag === pending.toTag, readOnly: true };
      });
    } finally { if (!adopted) pair.key.fill(0); }
  }
}
