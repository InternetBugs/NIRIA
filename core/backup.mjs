import { randomBytes, scrypt as derive, createCipheriv, createDecipheriv } from "node:crypto";
import { promisify } from "node:util";
import { ServiceError } from "../prototype/image-service.mjs";
import { validateSnapshot } from "./store.mjs";

const scrypt = promisify(derive);
const aad = Buffer.from("NIRIA encrypted companion backup v1");
function password(value) {
  if (typeof value !== "string" || value.length < 10 || value.length > 256) throw new ServiceError(400, "备份口令需要 10 到 256 个字符，请单独妥善保存。");
  return value;
}
function bytes(value, size) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > size * 2) throw new Error("invalid encoding");
  const data = Buffer.from(value, "base64");
  if (data.length !== size) throw new Error("invalid size");
  return data;
}
async function keyFor(secret, salt) {
  return scrypt(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}
export async function encryptBackup(data, secret) {
  password(secret);
  validateSnapshot(data);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await keyFor(secret, salt);
  try {
    const plaintext = JSON.stringify(data);
    if (Buffer.byteLength(plaintext) > 74 * 1024 * 1024) throw new ServiceError(413, "完整备份超过当前大小上限，请减少形象素材大小后再导出。");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      format: "niria-encrypted-backup", version: 1, kdf: "scrypt-N32768-r8-p1", cipher: "AES-256-GCM",
      salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64")
    };
  } finally { key.fill(0); }
}
export async function decryptBackup(envelope, secret) {
  password(secret);
  if (!envelope || envelope.format !== "niria-encrypted-backup" || envelope.version !== 1 ||
      envelope.kdf !== "scrypt-N32768-r8-p1" || envelope.cipher !== "AES-256-GCM" ||
      typeof envelope.data !== "string" || envelope.data.length > 100 * 1024 * 1024) throw new ServiceError(400, "备份格式或大小不受支持。");
  let key;
  try {
    const salt = bytes(envelope.salt, 16);
    const iv = bytes(envelope.iv, 12);
    const tag = bytes(envelope.tag, 16);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data)) throw new Error("invalid ciphertext");
    key = await keyFor(secret, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    return validateSnapshot(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new ServiceError(400, "无法恢复：口令不正确，或备份文件已损坏。");
  } finally { key?.fill(0); }
}
