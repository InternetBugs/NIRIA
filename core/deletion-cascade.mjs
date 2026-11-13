const keyOf = (kind, id) => `${kind}:${id}`;
export function mergeDeletionMarkers(...lists) {
  const markers = new Map();
  for (const marker of lists.flat()) {
    const key = keyOf(marker.type, marker.id), previous = markers.get(key);
    if (!previous) { markers.set(key, structuredClone(marker)); continue; }
    const latest = Date.parse(marker.at) >= Date.parse(previous.at) ? marker : previous;
    const combined = { ...previous, ...latest };
    if (previous.forget || marker.forget) combined.forget = true;
    if (previous.sources || marker.sources) combined.sources = [...new Set([...(previous.sources || []), ...(marker.sources || [])])].sort();
    if (previous.supersededSources || marker.supersededSources) {
      combined.supersededSources = mergeSourceReferences(previous.supersededSources || [], marker.supersededSources || []);
    }
    markers.set(key, combined);
  }
  return markers;
}
export function stateDeletionRecords(state) {
  const records = new Map();
  for (const [kind, values] of [["message", state.messages], ["memory", state.memories]]) {
    for (const value of values) records.set(keyOf(kind, value.id), { kind, id: value.id, values: [value] });
  }
  for (const conflict of state.conflicts || []) {
    if (!["message", "memory"].includes(conflict.kind)) continue;
    const key = keyOf(conflict.kind, conflict.id);
    const record = records.get(key) || { kind: conflict.kind, id: conflict.id, values: [] };
    record.values.push(...conflict.candidates.map((candidate) => candidate.value).filter(Boolean));
    records.set(key, record);
  }
  return [...records.values()];
}

// Only explicit source IDs and replyTo links are followed. Similar prose or
// general model-context references do not expand a user's deletion scope.
export function cascadeDeletions(records, input, at = new Date().toISOString()) {
  const markers = mergeDeletionMarkers(input), changes = [], children = new Map();
  const mark = (marker) => {
    const key = keyOf(marker.type, marker.id), previous = markers.get(key);
    if (!previous) { markers.set(key, marker); changes.push(marker); return; }
    const forget = !!marker.forget && !previous.forget;
    const sources = marker.sources ? [...new Set([...(previous.sources || []), ...marker.sources])].sort() : previous.sources;
    const supersededSources = marker.supersededSources ? mergeSourceReferences(previous.supersededSources || [], marker.supersededSources) : previous.supersededSources;
    if (!forget && JSON.stringify(sources) === JSON.stringify(previous.sources) &&
      JSON.stringify(supersededSources) === JSON.stringify(previous.supersededSources)) return;
    const next = { ...previous, ...(forget ? { forget: true } : {}), ...(sources ? { sources } : {}),
      ...(supersededSources ? { supersededSources } : {}) };
    markers.set(key, next); changes.push(next);
  };
  for (const record of records) {
    if (record.kind !== "message") continue;
    for (const value of record.values) if (value?.replyTo) {
      if (!children.has(value.replyTo)) children.set(value.replyTo, new Set());
      children.get(value.replyTo).add(record.id);
    }
  }
  const flags = new Map([...markers.values()].filter((item) => item.type === "message").map((item) => [item.id, !!item.forget]));
  const queue = [...flags].map(([id, forget]) => ({ id, forget }));
  for (let i = 0; i < queue.length; i++) {
    const { id, forget } = queue[i];
    for (const child of children.get(id) || []) {
      if (flags.has(child) && (!forget || flags.get(child))) continue;
      flags.set(child, forget);
      mark({ type: "message", id: child, at, ...(forget ? { forget: true } : {}) });
      queue.push({ id: child, forget });
    }
  }
  for (const record of records) {
    if (record.kind !== "memory") continue;
    const sources = [...new Set(record.values.flatMap((value) => associatedSources(value).map((source) => source.id)))].sort();
    const supersededSources = mergeSourceReferences(...record.values.map((value) => value?.supersededSources || []));
    if (markers.has(keyOf("memory", record.id)) || sources.some((id) => flags.get(id))) mark({ type: "memory", id: record.id, at, sources,
      ...(supersededSources.length ? { supersededSources } : {}) });
  }
  return { markers, changes };
}

export function applyStateDeletions(state, { roots = [], revise = true } = {}) {
  const records = stateDeletionRecords(state);
  const result = cascadeDeletions(records, [...state.tombstones, ...roots]);
  // Keep existing duplicate markers compatible with old databases and backups.
  state.tombstones.push(...roots, ...result.changes);
  const touch = (value) => {
    if (revise) { value.revision++; value.updatedAt = new Date().toISOString(); }
  };
  for (const message of state.messages) if (result.markers.has(keyOf("message", message.id))) {
    if (!message.deleted || message.content || message.context || message.error || message.expression || message.conflicted) touch(message);
    message.deleted = true;
    message.content = "";
    for (const field of ["context", "error", "expression", "conflicted"]) delete message[field];
  }
  for (const memory of state.memories) {
    if (result.markers.has(keyOf("memory", memory.id))) {
      if (!memory.deleted || memory.content || memory.conflicted) touch(memory);
      memory.deleted = true;
      memory.content = "";
      delete memory.conflicted;
    } else if (!memory.deleted && !memory.invalidated && memory.sources.some((source) => result.markers.has(keyOf("message", source.id)))) {
      memory.invalidated = true;
      touch(memory);
    }
  }
  if (state.conflicts) state.conflicts = state.conflicts.filter((conflict) => !result.markers.has(conflict.key));
  return result;
}
import { associatedSources, mergeSourceReferences } from "./memory-provenance.mjs";
