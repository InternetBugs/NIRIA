import { createHash } from "node:crypto";

export const messageHash = (message) => createHash("sha256")
  .update(JSON.stringify([message.id, message.role, message.content, message.revision])).digest("hex");
export const associatedSources = (memory) => [...(memory.sources || []), ...(memory.supersededSources || [])];
export function mergeSourceReferences(...lists) {
  const refs = new Map();
  for (const source of lists.flat()) {
    const value = { id: source.id, revision: source.revision, ...(source.hash ? { hash: source.hash } : {}) };
    refs.set(JSON.stringify([value.id, value.revision, value.hash || null]), value);
  }
  return [...refs].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
function memoryValues(state) {
  return [...state.memories, ...(state.conflicts || []).filter((item) => item.kind === "memory")
    .flatMap((item) => item.candidates.map((candidate) => candidate.value).filter(Boolean))];
}
export function linkedMessageIds(state, roots) {
  const result = new Set(roots), children = new Map();
  if (!result.size) return result;
  const messages = [...state.messages, ...(state.conflicts || []).filter((item) => item.kind === "message")
    .flatMap((item) => item.candidates.map((candidate) => candidate.value).filter(Boolean))];
  for (const message of messages) if (message.replyTo) {
    if (!children.has(message.replyTo)) children.set(message.replyTo, new Set());
    children.get(message.replyTo).add(message.id);
  }
  const queue = [...result];
  for (let i = 0; i < queue.length; i++) for (const id of children.get(queue[i]) || []) {
    if (!result.has(id)) { result.add(id); queue.push(id); }
  }
  return result;
}
export function supersededMessageIds(state) {
  const refs = [...memoryValues(state), ...state.tombstones].flatMap((item) => item.supersededSources || []);
  if (!refs.length) return new Set();
  const messages = new Map(state.messages.map((message) => [message.id, message])), hashes = new Map(), roots = new Set();
  for (const source of refs) {
    const message = messages.get(source.id);
    if (!message || message.revision !== source.revision) continue;
    if (source.hash) {
      if (!hashes.has(source.id)) hashes.set(source.id, messageHash(message));
      if (hashes.get(source.id) !== source.hash) continue;
    }
    roots.add(source.id);
  }
  return linkedMessageIds(state, roots);
}
export function permissionBlockedMessageIds(state, permission) {
  const setting = state.settings[permission];
  return linkedMessageIds(state, memoryValues(state).filter((memory) => !memory.deleted && !(memory[permission] ?? setting))
    .flatMap((memory) => associatedSources(memory).map((source) => source.id)));
}
export function modelBlockedMessageIds(state) {
  return new Set([...supersededMessageIds(state), ...permissionBlockedMessageIds(state, "allowModel")]);
}
export function automaticMemoryAllowed(state, sources) {
  if (!state.settings.autoMemory || !state.settings.allowModel || !sources.length) return false;
  const blocked = new Set(state.tombstones.filter((item) => item.type === "memory").flatMap((item) => item.sources || []));
  for (const id of modelBlockedMessageIds(state)) blocked.add(id);
  return sources.every((source) => !blocked.has(source.id));
}
export function invalidateSupersededMemories(state, { revise = true } = {}) {
  const blocked = supersededMessageIds(state);
  for (const memory of state.memories) {
    if (memory.deleted || memory.invalidated || !memory.sources.some((source) => blocked.has(source.id))) continue;
    memory.invalidated = true;
    if (revise) { memory.revision++; memory.updatedAt = new Date().toISOString(); }
  }
}

// Restoring the same identity must not replace a correction with its original
// uncorrected record. A backup that already has a correction supplies its text.
export function preserveCorrections(next, previous) {
  if (next.identity.id !== previous.identity.id) return;
  const memories = new Map(next.memories.map((memory, index) => [memory.id, index]));
  for (const memory of previous.memories) {
    if (memory.deleted || !memory.supersededSources?.length) continue;
    const index = memories.get(memory.id), restored = index === undefined ? null : next.memories[index];
    if (restored?.deleted) continue;
    if (!restored?.supersededSources?.length) {
      const retained = structuredClone(memory);
      for (const permission of ["allowModel", "allowSync"]) if (restored?.[permission] === false) retained[permission] = false;
      if (index === undefined) next.memories.push(retained); else next.memories[index] = retained;
    } else restored.supersededSources = mergeSourceReferences(restored.supersededSources, memory.supersededSources);
  }
}
