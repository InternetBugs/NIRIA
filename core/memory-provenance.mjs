import { createHash } from "node:crypto";

export const messageHash = (message) => createHash("sha256")
  .update(JSON.stringify([message.id, message.role, message.content, message.revision])).digest("hex");
export const memoryContentHash = (memory) => createHash("sha256").update(memory.content).digest("hex");
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
function messageValues(state) {
  return [...state.messages, ...(state.conflicts || []).filter((item) => item.kind === "message")
    .flatMap((item) => item.candidates.map((candidate) => candidate.value).filter(Boolean))];
}
const citations = (message) => message.role === "assistant" && Array.isArray(message.context?.memoryRefs)
  ? message.context.memoryRefs : [];

// Follow recorded memory citations, explicit memory sources and replyTo links.
// General history context and similar wording do not create dependencies.
function dependentRecords(state, roots, memoryRoots = [], { taintRoots = true } = {}) {
  const messages = new Set(roots), memories = new Set(memoryRoots);
  if (!messages.size && !memories.size) return { messages, memories };
  const replies = new Map(), derived = new Map(), cited = new Map();
  const add = (index, id, value) => {
    if (!index.has(id)) index.set(id, new Set());
    index.get(id).add(value);
  };
  for (const message of messageValues(state)) {
    if (message.replyTo) add(replies, message.replyTo, message.id);
    for (const ref of citations(message)) add(cited, ref.id, message.id);
  }
  for (const memory of memoryValues(state)) for (const source of memory.sources || []) add(derived, source.id, memory.id);
  const tainted = new Set(taintRoots ? roots : []);
  const queue = [...messages].map((id) => ["message", id, taintRoots]);
  queue.push(...[...memories].map((id) => ["memory", id]));
  const mark = (kind, id) => {
    if (kind === "message") {
      if (tainted.has(id)) return;
      messages.add(id); tainted.add(id); queue.push([kind, id, true]);
    } else if (!memories.has(id)) {
      memories.add(id); queue.push([kind, id]);
    }
  };
  for (let index = 0; index < queue.length; index++) {
    const [kind, id, propagateSources] = queue[index];
    if (kind === "memory") {
      for (const child of cited.get(id) || []) mark("message", child);
    } else {
      for (const child of replies.get(id) || []) mark("message", child);
      if (propagateSources) for (const child of derived.get(id) || []) mark("memory", child);
    }
  }
  return { messages, memories };
}
export function linkedMessageIds(state, roots) {
  const result = new Set(roots), children = new Map();
  if (!result.size) return result;
  for (const message of messageValues(state)) if (message.replyTo) {
    if (!children.has(message.replyTo)) children.set(message.replyTo, new Set());
    children.get(message.replyTo).add(message.id);
  }
  const queue = [...result];
  for (let i = 0; i < queue.length; i++) for (const id of children.get(queue[i]) || []) {
    if (!result.has(id)) { result.add(id); queue.push(id); }
  }
  return result;
}
export function supersededMessageIds(state, at = Date.now()) {
  const values = memoryValues(state);
  const refs = [...values, ...state.tombstones].flatMap((item) => item.supersededSources || []);
  const messages = new Map(state.messages.map((message) => [message.id, message]));
  const memories = new Map(state.memories.map((memory) => [memory.id, memory]));
  const hashes = new Map(), roots = new Set(), invalid = new Set();
  const sourceCurrent = (source) => {
    const message = messages.get(source.id);
    if (!message || message.deleted || message.conflicted || message.status !== "completed" || message.revision !== source.revision) return false;
    if (!source.hash) return true;
    if (!hashes.has(source.id)) hashes.set(source.id, messageHash(message));
    return hashes.get(source.id) === source.hash;
  };
  for (const source of refs) {
    const message = messages.get(source.id);
    if (!message || message.revision !== source.revision) continue;
    if (source.hash) {
      if (!hashes.has(source.id)) hashes.set(source.id, messageHash(message));
      if (hashes.get(source.id) !== source.hash) continue;
    }
    roots.add(source.id);
  }
  for (const memory of values) {
    if (memory.deleted || memory.invalidated || memory.conflicted ||
        (memory.expiresAt && Date.parse(memory.expiresAt) <= at) || !memory.sources.every(sourceCurrent)) invalid.add(memory.id);
  }
  for (const conflict of state.conflicts || []) if (conflict.kind === "memory") invalid.add(conflict.id);
  const contentHashes = new Map(), legacyHashes = new Map();
  for (const message of messageValues(state)) for (const ref of citations(message)) {
    const memory = memories.get(ref.id);
    let obsolete = !memory || invalid.has(ref.id);
    if (!obsolete) {
      if (ref.contentHash) {
        if (!contentHashes.has(ref.id)) contentHashes.set(ref.id, memoryContentHash(memory));
        obsolete = ref.contentHash !== contentHashes.get(ref.id);
      } else if (ref.hash) {
        if (!legacyHashes.has(ref.id)) legacyHashes.set(ref.id, createHash("sha256").update(JSON.stringify(memory)).digest("hex"));
        obsolete = ref.hash !== legacyHashes.get(ref.id);
      } else obsolete = ref.revision !== memory.revision;
    }
    if (obsolete) roots.add(message.id);
  }
  return dependentRecords(state, roots, invalid).messages;
}
function permissionBlocks(state, permission) {
  const setting = state.settings[permission];
  const denied = memoryValues(state).filter((memory) => !memory.deleted && !(memory[permission] ?? setting));
  // A private memory hides its complete raw source, while other memories
  // extracted directly from that source retain their own permission choices.
  // Replies that consumed the denied memory and their derivatives are blocked.
  return dependentRecords(state, denied.flatMap((memory) => associatedSources(memory).map((source) => source.id)),
    denied.map((memory) => memory.id), { taintRoots: false });
}
export function permissionBlockedMessageIds(state, permission) {
  return permissionBlocks(state, permission).messages;
}
export function permissionBlockedMemoryIds(state, permission) {
  return permissionBlocks(state, permission).memories;
}
export function modelBlockedMessageIds(state, at = Date.now()) {
  return new Set([...supersededMessageIds(state, at), ...permissionBlockedMessageIds(state, "allowModel")]);
}
export function contextExpiry(state, selectedMessages, selectedMemories, at = Date.now()) {
  const messages = new Map(state.messages.map((message) => [message.id, message]));
  const memories = new Map(state.memories.map((memory) => [memory.id, memory]));
  const seenMessages = new Set(), seenMemories = new Set();
  const queue = selectedMessages.map((message) => ["message", message.id]);
  queue.push(...selectedMemories.map((memory) => ["memory", memory.id]));
  let deadline = null;
  for (let index = 0; index < queue.length; index++) {
    const [kind, id] = queue[index];
    if (kind === "message") {
      if (seenMessages.has(id)) continue;
      seenMessages.add(id);
      const message = messages.get(id);
      if (!message) continue;
      if (message.replyTo) queue.push(["message", message.replyTo]);
      for (const ref of citations(message)) queue.push(["memory", ref.id]);
    } else {
      if (seenMemories.has(id)) continue;
      seenMemories.add(id);
      const memory = memories.get(id);
      if (!memory) continue;
      const expiry = Date.parse(memory.expiresAt);
      if (Number.isFinite(expiry) && expiry > at) deadline = Math.min(deadline ?? expiry, expiry);
      for (const source of memory.sources) queue.push(["message", source.id]);
    }
  }
  return deadline;
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
