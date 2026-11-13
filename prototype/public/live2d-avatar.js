import { inspectLive2DImport } from "./live2d-import.js";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const invalid = () => { throw new Error("Live2D 形象设置无效，未替换当前形象。"); };
export function inspectLive2DAvatar(value) {
  if (!object(value) || value.format !== "niria-live2d-avatar" || value.version !== 1 ||
      Object.keys(value).some((key) => !["format", "version", "package", "bindings"].includes(key))) invalid();
  const summary = inspectLive2DImport(value.package);
  const bindings = value.bindings;
  if (!object(bindings) || Object.keys(bindings).some((key) => !["idleGroup", "expressions"].includes(key)) ||
      !object(bindings.expressions) ||
      Object.keys(bindings.expressions).some((name) => !["smile", "curious", "shy"].includes(name))) invalid();
  if (bindings.idleGroup !== null && (typeof bindings.idleGroup !== "string" ||
      !summary.motions.some((motion) => motion.group === bindings.idleGroup))) invalid();
  const names = new Set(summary.expressions.map((expression) => expression.name));
  if (Object.values(bindings.expressions).some((name) => typeof name !== "string" || !names.has(name))) invalid();
  return summary;
}
export function live2DAvatar(bundle, bindings = { idleGroup: null, expressions: {} }) {
  const avatar = { format: "niria-live2d-avatar", version: 1, package: bundle, bindings };
  inspectLive2DAvatar(avatar);
  return structuredClone(avatar);
}
