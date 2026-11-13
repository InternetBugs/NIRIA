import { createHash } from "node:crypto";
import { ServiceError } from "../prototype/image-service.mjs";

const uuid = (s) => typeof s === "string" && /^[a-f0-9-]{36}$/.test(s);
export function pairingCode({ vaultId, identityId, key }) {
  return `NIRIA1.${Buffer.from(JSON.stringify({ vaultId, identityId, key: key.toString("base64url") })).toString("base64url")}`;
}
export function parsePairing(code) {
  try {
    if (typeof code !== "string" || code.length > 1000 || !/^NIRIA1\.[A-Za-z0-9_-]+$/.test(code)) throw new Error();
    const value = JSON.parse(Buffer.from(code.slice(7), "base64url"));
    if (!uuid(value.vaultId) || !uuid(value.identityId) || typeof value.key !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.key)) throw new Error();
    const key = Buffer.from(value.key, "base64url");
    if (key.length !== 32) throw new Error();
    return { vaultId: value.vaultId, identityId: value.identityId, key };
  } catch { throw new ServiceError(400, "配对码格式无效，请从原设备重新复制完整配对码。"); }
}
export const keyTag = (pair) => createHash("sha256").update(`NIRIA sync key identifier v1|${pair.vaultId}|${pair.identityId}|`).update(pair.key).digest("hex");
export function keyMeta(meta, pair) {
  const tag = keyTag(pair);
  const retired = new Set(meta.retiredKeyTags || []);
  if (meta.keyTag && meta.keyTag !== tag) retired.add(meta.keyTag);
  return { ...meta, keyTag: tag, retiredKeyTags: [...retired] };
}
