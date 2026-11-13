import { createHash } from "node:crypto";
import { ServiceError } from "../prototype/image-service.mjs";
import { cascadeDeletions, stateDeletionRecords } from "./deletion-cascade.mjs";
import { associatedSources, mergeSourceReferences } from "./memory-provenance.mjs";

export function planForgetting(state, id) {
  const target = state.memories.find((memory) => memory.id === id && !memory.deleted);
  if (!target) throw new ServiceError(404, "这条记忆已不存在，请刷新列表。");
  const records = stateDeletionRecords(state), targetRecord = records.find((record) => record.kind === "memory" && record.id === id);
  const sourceIds = [...new Set(targetRecord.values.flatMap((memory) => associatedSources(memory).map((source) => source.id)))].sort();
  const supersededSources = mergeSourceReferences(...targetRecord.values.map((memory) => memory.supersededSources || []));
  const at = new Date().toISOString();
  const roots = [
    { id, type: "memory", at, sources: sourceIds, ...(supersededSources.length ? { supersededSources } : {}) },
    ...sourceIds.map((id) => ({ id, type: "message", at, forget: true }))
  ];
  const { markers } = cascadeDeletions(records, [...state.tombstones, ...roots], at);
  const live = new Map([
    ...state.messages.filter((item) => !item.deleted).map((item) => [`message:${item.id}`, item]),
    ...state.memories.filter((item) => !item.deleted).map((item) => [`memory:${item.id}`, item])
  ]);
  const affected = records.filter((record) => markers.has(`${record.kind}:${record.id}`) && live.has(`${record.kind}:${record.id}`))
    .filter((record) => record.kind === "memory"
      ? record.id === id || record.values.some((memory) => associatedSources(memory).some((source) => markers.get(`message:${source.id}`)?.forget))
      : markers.get(`message:${record.id}`)?.forget);
  const items = affected.map((record) => {
    const value = live.get(`${record.kind}:${record.id}`);
    return { id: value.id, kind: record.kind, revision: value.revision, conflicted: !!value.conflicted,
      relationship: record.kind === "memory" ? record.id === id ? "target" : "derived" : sourceIds.includes(record.id) ? "source" : "reply",
      role: value.role || null, content: value.content.slice(0, record.kind === "memory" ? 2000 : 300),
      truncated: record.kind === "message" && value.content.length > 300, createdAt: value.createdAt };
  }).sort((a, b) => Number(b.relationship === "target") - Number(a.relationship === "target") ||
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const signature = affected.map((record) => ({ ...record, values: record.values.map((value) => ({ ...value })) }))
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const token = createHash("sha256").update(JSON.stringify({ identity: state.identity.id, id, sourceIds, records: signature })).digest("hex");
  const counts = {
    memories: items.filter((item) => item.kind === "memory").length,
    sourceMessages: items.filter((item) => item.relationship === "source").length,
    replies: items.filter((item) => item.relationship === "reply").length,
    unavailableSources: sourceIds.filter((sourceId) => !live.has(`message:${sourceId}`)).length
  };
  return { id, token, roots, target: { id, content: target.content, revision: target.revision }, counts, items };
}
export function forgettingPreview(state, { id, token, offset = 0, limit = 30 } = {}) {
  if (typeof id !== "string" || !id || id.length > 100 || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 || (token !== undefined && (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)))) {
    throw new ServiceError(400, "遗忘预览参数无效。");
  }
  const plan = planForgetting(state, id);
  if (token !== undefined && token !== plan.token) throw new ServiceError(409, "相关记录已经变化，请重新查看遗忘清单后确认。");
  if (offset > plan.items.length) throw new ServiceError(400, "清单位置无效，请重新查看。");
  return { id, token: plan.token, target: plan.target, counts: plan.counts, total: plan.items.length,
    items: plan.items.slice(offset, offset + limit), nextOffset: offset + limit < plan.items.length ? offset + limit : null };
}
