import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { defaults, validateSnapshot, validateAvatar, now, memoryValidator } from "./store.mjs";
import { ServiceError } from "../prototype/image-service.mjs";
import { applyStateDeletions, cascadeDeletions, mergeDeletionMarkers, stateDeletionRecords } from "./deletion-cascade.mjs";
import { permissionBlockedMessageIds, invalidateSupersededMemories } from "./memory-provenance.mjs";

const kinds = ["identity", "message", "memory", "avatar"];
const uuid = (s) => typeof s === "string" && /^[a-f0-9-]{36}$/.test(s);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const clean = (value) => {
  const copy = structuredClone(value);
  if (copy) { delete copy.conflicted; delete copy.syncExcluded; }
  return copy;
};
export const recordKey = (kind, id) => `${kind}:${id}`;
export function project(state) {
  const records = new Map();
  records.set(recordKey("identity", state.identity.id), { kind: "identity", id: state.identity.id, value: clean(state.identity) });
  records.set(recordKey("avatar", state.identity.id), { kind: "avatar", id: state.identity.id, value: state.avatar });
  const excluded = permissionBlockedMessageIds(state, "allowSync");
  for (const message of state.messages) {
    if (message.deleted || message.status === "pending") continue;
    records.set(recordKey("message", message.id), { kind: "message", id: message.id,
      value: message.syncExcluded || excluded.has(message.id) || excluded.has(message.replyTo) ? null : clean(message) });
  }
  for (const memory of state.memories) {
    if (memory.deleted) continue;
    records.set(recordKey("memory", memory.id), { kind: "memory", id: memory.id,
      value: memory.syncExcluded || !(memory.allowSync ?? state.settings.allowSync) ? null : clean(memory) });
  }
  return records;
}
export function emptyManifest(identityId) {
  return { format: "niria-sync-state", version: 1, identityId, records: [], tombstones: [] };
}
export function validateManifest(manifest) {
  const fail = () => { throw new ServiceError(400, "同步资料格式或版本关系无效，未覆盖本机资料。"); };
  if (!manifest || manifest.format !== "niria-sync-state" || manifest.version !== 1 || !uuid(manifest.identityId) ||
      !Array.isArray(manifest.records) || manifest.records.length > 120_000 || !Array.isArray(manifest.tombstones) ||
      manifest.tombstones.length > 250_000) fail();
  const skeleton = defaults();
  const keys = new Set();
  let totalNodes = 0;
  for (const record of manifest.records) {
    if (!kinds.includes(record.kind) || !uuid(record.id) || keys.has(recordKey(record.kind, record.id)) ||
        !Array.isArray(record.nodes) || !record.nodes.length || record.nodes.length > 10000 ||
        !Array.isArray(record.heads) || !record.heads.length || record.heads.length > 32) fail();
    keys.add(recordKey(record.kind, record.id));
    totalNodes += record.nodes.length;
    if (totalNodes > 250_000) fail();
    const nodes = new Map(record.nodes.map((n) => [n.id, n]));
    if (nodes.size !== record.nodes.length) fail();
    for (const node of record.nodes) {
      if (!uuid(node.id) || !Array.isArray(node.parents) || node.parents.length > 32 || new Set(node.parents).size !== node.parents.length ||
          node.parents.some((p) => !nodes.has(p) || p === node.id)) fail();
    }
    // Kahn traversal validates the entire graph, including branches that are no longer heads.
    const degrees = new Map(record.nodes.map((n) => [n.id, n.parents.length]));
    const children = new Map();
    for (const node of record.nodes) for (const parent of node.parents) { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(node.id); }
    const queue = record.nodes.filter((n) => !n.parents.length).map((n) => n.id);
    for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) || []) {
      degrees.set(child, degrees.get(child) - 1); if (!degrees.get(child)) queue.push(child);
    }
    if (queue.length !== record.nodes.length) fail();
    const heads = new Set();
    for (const head of record.heads) {
      if (!nodes.has(head.id) || heads.has(head.id) || !uuid(head.device) || typeof head.at !== "string" || !Number.isFinite(Date.parse(head.at))) fail();
      heads.add(head.id);
      if (head.value === null) {
        if (record.kind === "identity") fail();
        continue;
      }
      const value = head.value;
      if (!value || typeof value !== "object") fail();
      const data = { ...skeleton, messages: [], memories: [], tombstones: manifest.tombstones };
      if (record.kind === "identity") {
        if (value.id !== manifest.identityId || record.id !== manifest.identityId) fail();
        data.identity = value;
      }
      if (record.kind === "message") { if (value.id !== record.id) fail(); data.messages = [value]; }
      if (record.kind === "memory") { if (value.id !== record.id) fail(); data.memories = [value]; }
      if (record.kind === "avatar") { if (record.id !== manifest.identityId) fail(); validateAvatar(value); }
      validateSnapshot(data);
    }
    const leaves = new Set(record.nodes.filter((n) => !children.has(n.id)).map((n) => n.id));
    if (leaves.size !== heads.size || [...heads].some((id) => !leaves.has(id))) fail();
  }
  validateSnapshot({ ...skeleton, tombstones: manifest.tombstones });
  if (!manifest.records.some((r) => r.kind === "identity" && r.id === manifest.identityId)) fail();
  return manifest;
}
function ancestor(id, target, nodes) {
  const visited = new Set(), queue = [target];
  while (queue.length) {
    const current = queue.pop();
    if (current === id) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(nodes.get(current)?.parents || []));
  }
  return false;
}
function withdrawal(record) {
  if (record.heads.length < 2 || !record.heads.some((h) => h.value === null)) return record;
  const heads = [...record.heads].sort((a, b) => a.id.localeCompare(b.id));
  const digest = hash(["withdrawal-v1", record.kind, record.id, heads.map((h) => h.id)]).slice(0, 32);
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
  record.nodes.push({ id, parents: heads.map((h) => h.id) });
  record.heads = [{ id, device: heads.find((h) => h.value === null).device, at: heads.map((h) => h.at).sort().at(-1), value: null }];
  return record;
}
export function mergeManifest(left, right, localRecords = []) {
  if (left.identityId !== right.identityId) throw new ServiceError(409, "同步空间属于另一位伴侣，请使用正确的配对码。");
  const result = emptyManifest(left.identityId);
  let tombstones = mergeDeletionMarkers(left.tombstones, right.tombstones);
  const records = new Map();
  for (const record of [...left.records, ...right.records]) {
    const key = recordKey(record.kind, record.id);
    if (tombstones.has(key)) continue;
    const previous = records.get(key);
    if (!previous) { records.set(key, structuredClone(record)); continue; }
    const nodes = new Map(previous.nodes.map((n) => [n.id, n]));
    for (const node of record.nodes) {
      if (nodes.has(node.id) && canonical(nodes.get(node.id)) !== canonical(node)) throw new ServiceError(400, "同一个同步版本包含矛盾的历史。");
      nodes.set(node.id, node);
    }
    const heads = new Map(previous.heads.map((h) => [h.id, h]));
    for (const head of record.heads) {
      if (heads.has(head.id) && canonical(heads.get(head.id)) !== canonical(head)) throw new ServiceError(400, "同一个同步版本包含矛盾的内容。");
      heads.set(head.id, head);
    }
    const frontier = [...heads.values()].filter((h) => ![...heads.keys()].some((other) => other !== h.id && ancestor(h.id, other, nodes)));
    previous.nodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    previous.heads = frontier.sort((a, b) => a.id.localeCompare(b.id));
  }
  tombstones = cascadeDeletions([...localRecords, ...[...left.records, ...right.records].map((record) => ({
    kind: record.kind, id: record.id, values: record.heads.map((head) => head.value).filter(Boolean)
  }))], [...tombstones.values()]).markers;
  for (const key of records.keys()) if (tombstones.has(key)) records.delete(key);
  result.records = [...records.values()].map(withdrawal).sort((a, b) => recordKey(a.kind, a.id).localeCompare(recordKey(b.kind, b.id)));
  result.tombstones = [...tombstones.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  return result;
}
export function observe(manifest, fingerprints, state, device) {
  const result = structuredClone(manifest);
  result.tombstones = structuredClone(state.tombstones);
  const records = new Map(result.records.map((r) => [recordKey(r.kind, r.id), r]));
  for (const [key, projected] of project(state)) {
    const digest = hash(projected.value);
    if (fingerprints[key] === digest && records.has(key)) continue;
    // An unresolved conflict cannot be implicitly resolved by a periodic sync.
    if (state.conflicts?.some((c) => c.key === key) && projected.value !== null) continue;
    const record = records.get(key) || { kind: projected.kind, id: projected.id, nodes: [], heads: [] };
    const id = randomUUID();
    record.nodes.push({ id, parents: record.heads.map((h) => h.id) });
    record.heads = [{ id, device, at: now(), value: projected.value }];
    records.set(key, record);
    fingerprints[key] = digest;
  }
  result.records = [...records.values()];
  return mergeManifest(result, emptyManifest(state.identity.id), stateDeletionRecords(state));
}
export function materialize(manifest, localState) {
  const state = structuredClone(localState);
  state.conflicts = [];
  const projected = project(localState);
  for (const record of manifest.records) {
    const key = recordKey(record.kind, record.id);
    const local = record.kind === "identity" ? state.identity : record.kind === "avatar" ? state.avatar :
      state[record.kind === "message" ? "messages" : "memories"].find((r) => r.id === record.id);
    const withdrew = record.kind !== "identity" && record.heads.some((h) => h.value === null);
    if (withdrew) {
      // Withdrawal never sends a private local value back to the server.
      if (local && record.kind === "memory") {
        if (local.allowSync ?? state.settings.allowSync) local.allowSync = false;
        local.syncExcluded = true;
      }
      if (local && record.kind === "message") local.syncExcluded = true;
      if (record.kind === "avatar" && !projected.has(key)) state.avatar = null;
      continue;
    }
    let value = structuredClone(record.heads[0].value);
    if (record.heads.length > 1) {
      state.conflicts.push({ key, kind: record.kind, id: record.id, candidates: structuredClone(record.heads) });
      if (local) value = structuredClone(local);
      if (record.kind !== "avatar") value.conflicted = true;
    } else if (value) delete value.conflicted;
    if (record.kind === "identity") state.identity = value;
    else if (record.kind === "avatar") state.avatar = value;
    else {
      const list = state[record.kind === "message" ? "messages" : "memories"];
      const index = list.findIndex((r) => r.id === record.id);
      if (index === -1) list.push(value); else list[index] = value;
    }
  }
  state.tombstones = structuredClone(manifest.tombstones);
  applyStateDeletions(state, { revise: false });
  invalidateSupersededMemories(state, { revise: false });
  const deleted = new Set(state.tombstones.map((t) => `${t.type}:${t.id}`));
  for (const message of state.messages) if (deleted.has(`message:${message.id}`)) {
    message.content = ""; message.deleted = true; delete message.context; delete message.error; delete message.conflicted; delete message.expression;
  }
  const valid = memoryValidator(state);
  for (const memory of state.memories) {
    if (deleted.has(`memory:${memory.id}`)) { memory.content = ""; memory.deleted = true; delete memory.conflicted; }
    if (!valid(memory)) memory.invalidated = true;
  }
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  const order = new Map(state.messages.map((message) => {
    const parent = message.role === "assistant" && byId.get(message.replyTo)?.role === "user" ? byId.get(message.replyTo) : null;
    const at = parent && parent.createdAt > message.createdAt ? parent.createdAt : message.createdAt;
    // Equal-millisecond timestamps must not randomly place a reply before its user message.
    const root = parent?.createdAt === at ? parent.id : message.id;
    return [message.id, { at, root, rank: root === message.id ? 0 : 1 }];
  }));
  state.messages.sort((a, b) => {
    const left = order.get(a.id), right = order.get(b.id);
    return left.at.localeCompare(right.at) || left.root.localeCompare(right.root) || left.rank - right.rank || a.id.localeCompare(b.id);
  });
  validateSnapshot(state);
  return state;
}
function aad(vaultId, identityId) { return Buffer.from(`NIRIA sync v1|${vaultId}|${identityId}`); }
export function seal(manifest, key, vaultId) {
  validateManifest(manifest);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(vaultId, manifest.identityId));
  const data = Buffer.concat([cipher.update(JSON.stringify(manifest), "utf8"), cipher.final()]);
  if (data.length > 74 * 1024 * 1024) throw new ServiceError(413, "同步资料超过当前大小上限，请先保留加密备份。");
  return JSON.stringify({ format: "niria-sync-encrypted", version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}
export function unseal(serialized, key, vaultId, identityId) {
  try {
    const envelope = JSON.parse(serialized);
    if (envelope.format !== "niria-sync-encrypted" || envelope.version !== 1) throw new Error("format");
    for (const [name, size] of [["iv", 12], ["tag", 16]]) {
      if (typeof envelope[name] !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope[name]) ||
          Buffer.from(envelope[name], "base64").length !== size) throw new Error("encoding");
    }
    if (typeof envelope.data !== "string" || envelope.data.length > 100 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data)) throw new Error("data");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(vaultId, identityId));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const result = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    const manifest = validateManifest(JSON.parse(result.toString("utf8")));
    if (manifest.identityId !== identityId) throw new Error("identity");
    return manifest;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(400, "同步资料无法解密或验证，请检查配对码和服务器上的文件是否完整。");
  }
}
