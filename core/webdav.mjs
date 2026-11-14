import { randomUUID } from "node:crypto";
import { ServiceError } from "../prototype/image-service.mjs";

export const MAX_SYNC_BYTES = 100 * 1024 * 1024;
export function davBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new ServiceError(400, "请填写完整的 WebDAV 文件夹地址。"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new ServiceError(400, "远程 WebDAV 必须使用 HTTPS，本机测试服务可以使用 HTTP。");
  if (url.username || url.password || url.search || url.hash) throw new ServiceError(400, "WebDAV 地址不能内嵌账号、查询参数或片段。");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}
export function strongETag(value) {
  return typeof value === "string" && /^"[^"\r\n]{1,250}"$/.test(value);
}
export const syncStopped = () => new ServiceError(504,
  "同步已停止或超时，本机资料已保留；已发出的写入结果可能未知，下次同步会重新检查服务器状态。");
export function checkSync(signal) {
  if (signal?.aborted) throw syncStopped();
}
const interrupted = (error) => ["AbortError", "TimeoutError"].includes(error?.name);
async function discard(response) {
  try { await response.body?.cancel(); } catch { /* Discard failures never replace the operation result. */ }
}
async function bounded(response, signal, limit = MAX_SYNC_BYTES) {
  try {
    checkSync(signal);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      checkSync(signal);
      size += chunk.byteLength;
      if (size > limit) throw new ServiceError(502, "WebDAV 返回内容超过同步大小上限。");
      chunks.push(Buffer.from(chunk));
    }
    checkSync(signal);
    return Buffer.concat(chunks);
  } catch (error) {
    await discard(response);
    if (signal?.aborted || interrupted(error)) throw syncStopped();
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, "未能完整读取 WebDAV 资料，本机资料已保留，请检查网络和服务器状态。");
  }
}

export class WebDAV {
  constructor({ baseUrl, username = "", password = "" }, { fetchImpl = fetch } = {}) {
    this.baseUrl = davBase(baseUrl);
    if (typeof username !== "string" || typeof password !== "string" || username.length > 256 || password.length > 4096 ||
        /[:\r\n]/.test(username) || /[\r\n]/.test(password)) throw new ServiceError(400, "WebDAV 登录资料格式无效。");
    this.authorization = username || password ? `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` : "";
    this.fetch = fetchImpl;
  }
  url(path) {
    if (typeof path !== "string" || !/^[a-zA-Z0-9./_-]+$/.test(path) || path.includes("..") || path.startsWith("/")) throw new ServiceError(400, "同步对象路径无效。");
    return new URL(path, this.baseUrl).href;
  }
  async request(method, path, { headers = {}, body, signal } = {}) {
    checkSync(signal);
    try {
      const response = await this.fetch(this.url(path), {
        method, headers: { ...(this.authorization ? { Authorization: this.authorization } : {}), ...headers },
        body, signal, redirect: "error"
      });
      if (signal?.aborted) { await discard(response); throw syncStopped(); }
      return response;
    } catch (error) {
      if (signal?.aborted || interrupted(error)) throw syncStopped();
      throw new ServiceError(502, "无法连接 WebDAV，请检查地址、网络和服务器状态。");
    }
  }
  async require(response, statuses, signal) {
    if (signal?.aborted) { await discard(response); throw syncStopped(); }
    if (!statuses.includes(response.status)) {
      await discard(response);
      checkSync(signal);
      throw new ServiceError(502, response.status === 401 || response.status === 403
        ? "WebDAV 拒绝访问，请检查账号、应用专用密码与文件夹权限。"
        : "WebDAV 未接受操作，请检查文件夹地址与服务能力。");
    }
  }
  async directory(folder, signal) {
    const created = await this.request("MKCOL", folder, { signal });
    await this.require(created, [201, 405], signal);
    await discard(created);
    const listed = await this.request("PROPFIND", folder, {
      signal, headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
    });
    await this.require(listed, [207], signal);
    const xml = (await bounded(listed, signal, 1024 * 1024)).toString("utf8");
    if (!/DAV:/.test(xml) || !/<(?:[\w-]+:)?multistatus\b/i.test(xml) || !/<(?:[\w-]+:)?collection\b/i.test(xml)) throw new ServiceError(502, "服务没有返回有效的 WebDAV 文件夹能力。");
  }
  async read(path, signal) {
    const response = await this.request("GET", path, { signal });
    if (response.status === 404) { await discard(response); checkSync(signal); return null; }
    await this.require(response, [200], signal);
    const etag = response.headers.get("etag");
    if (!strongETag(etag)) { await discard(response); checkSync(signal); throw new ServiceError(502, "WebDAV 未提供强 ETag，无法安全进行并发同步。"); }
    return { etag, data: await bounded(response, signal) };
  }
  async write(path, data, etag, signal) {
    if (Buffer.byteLength(data) > MAX_SYNC_BYTES) throw new ServiceError(413, "同步资料超过当前 100 MB 上限。");
    const response = await this.request("PUT", path, {
      signal, body: data,
      headers: { "Content-Type": "application/octet-stream", ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }) }
    });
    if (response.status === 412) { await discard(response); checkSync(signal); return false; }
    await this.require(response, [200, 201, 204], signal);
    await discard(response);
    checkSync(signal);
    return true;
  }
  async probe(folder, signal) {
    await this.directory(folder, signal);
    const path = `${folder}probe-${randomUUID()}`;
    const original = Buffer.from(`NIRIA capability check ${randomUUID()}`);
    let owned = false;
    try {
      if (!await this.write(path, original, null, signal)) throw new ServiceError(502, "无法创建同步能力测试对象。");
      owned = true;
      const first = await this.read(path, signal);
      if (!first || !first.data.equals(original)) throw new ServiceError(502, "WebDAV 未能完整读回测试对象。");
      const rejected = await this.write(path, "must-not-overwrite", '"niria-deliberately-invalid-etag"', signal);
      const duplicate = await this.write(path, "must-not-create-again", null, signal);
      const unchanged = await this.read(path, signal);
      if (rejected || duplicate || !unchanged || !unchanged.data.equals(original)) throw new ServiceError(502, "服务忽略了条件写入，不能用于 NIRIA 同步。");
      if (!await this.write(path, "NIRIA conditional update verified", unchanged.etag, signal)) throw new ServiceError(502, "服务未接受有效的条件更新。");
      return { ok: true, checks: ["WebDAV collection", "read/write", "strong ETag", "If-Match", "If-None-Match"] };
    } finally {
      if (owned) {
        try {
          const cleanup = await this.request("DELETE", path, { signal: AbortSignal.timeout(5000) });
          await cleanup.body?.cancel();
        } catch { /* Only this uniquely named probe can remain; never delete the folder. */ }
      }
      checkSync(signal);
    }
  }
}
