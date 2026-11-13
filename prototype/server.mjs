import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generateAction, ServiceError } from "./image-service.mjs";
import { CompanionStore, validateAvatar } from "../core/store.mjs";
import { CompanionService, buildContext, previewContext } from "../core/chat-service.mjs";
import { contextReviewBasis } from "./public/context-review.js";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { SpeechService } from "../core/speech-service.mjs";
import { Connections } from "../core/connections.mjs";
import { stateEvents } from "../core/state-events.mjs";
import { adoptLive2D } from "../core/live2d-adoption.mjs";
import { live2DRuntimeInfo } from "./public/live2d-runtime.js";

const publicRoot = new URL("./public/", import.meta.url);
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/avatar", ["index.html", "text/html; charset=utf-8"]],
  ["/companion.html", ["companion.html", "text/html; charset=utf-8"]],
  ["/companion.css", ["companion.css", "text/css; charset=utf-8"]],
  ["/companion.js", ["companion.js", "text/javascript; charset=utf-8"]],
  ["/widget", ["widget.html", "text/html; charset=utf-8"]],
  ["/widget.js", ["widget.js", "text/javascript; charset=utf-8"]],
  ["/avatar-player.js", ["avatar-player.js", "text/javascript; charset=utf-8"]],
  ["/avatar-expressions.js", ["avatar-expressions.js", "text/javascript; charset=utf-8"]],
  ["/live2d-import.js", ["live2d-import.js", "text/javascript; charset=utf-8"]],
  ["/live2d-avatar.js", ["live2d-avatar.js", "text/javascript; charset=utf-8"]],
  ["/live2d-assets.js", ["live2d-assets.js", "text/javascript; charset=utf-8"]],
  ["/live2d-runtime.js", ["live2d-runtime.js", "text/javascript; charset=utf-8"]],
  ["/live2d-adapter.js", ["live2d-adapter.js", "text/javascript; charset=utf-8"]],
  ["/live2d-player.js", ["live2d-player.js", "text/javascript; charset=utf-8"]],
  ["/live2d-dialog.js", ["live2d-dialog.js", "text/javascript; charset=utf-8"]],
  ["/vendor/live2d/NOTICE.md", ["live2d-notice.md", "text/plain; charset=utf-8"]],
  ["/frame-blender.js", ["frame-blender.js", "text/javascript; charset=utf-8"]],
  ["/state-events.js", ["state-events.js", "text/javascript; charset=utf-8"]],
  ["/sync-security.js", ["sync-security.js", "text/javascript; charset=utf-8"]],
  ["/history.js", ["history.js", "text/javascript; charset=utf-8"]],
  ["/memory-browser.js", ["memory-browser.js", "text/javascript; charset=utf-8"]],
  ["/context-review.js", ["context-review.js", "text/javascript; charset=utf-8"]],
  ["/chat-activity.js", ["chat-activity.js", "text/javascript; charset=utf-8"]],
  ["/forget-review.js", ["forget-review.js", "text/javascript; charset=utf-8"]],
  ["/image-analysis.js", ["image-analysis.js", "text/javascript; charset=utf-8"]],
  ["/animeface.js", ["animeface.js", "text/javascript; charset=utf-8"]],
  ["/vendor/animeface/model.json", ["vendor/animeface/model.json", "application/json; charset=utf-8"]],
  ["/vendor/animeface/LICENSE.txt", ["vendor/animeface/LICENSE.txt", "text/plain; charset=utf-8"]],
  ["/image-background.js", ["image-background.js", "text/javascript; charset=utf-8"]],
  ["/background-editor.js", ["background-editor.js", "text/javascript; charset=utf-8"]],
  ["/image-tools.js", ["image-tools.js", "text/javascript; charset=utf-8"]],
  ["/image-worker.js", ["image-worker.js", "text/javascript; charset=utf-8"]]
]);
const live2DManifest = live2DRuntimeInfo.available
  ? JSON.parse(await readFile(new URL("vendor/live2d/manifest.json", publicRoot), "utf8")) : { files: {} };
for (const path of live2DRuntimeInfo.available ? [...Object.keys(live2DManifest.files), "manifest.json"] : []) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Invalid bundled Live2D path");
  files.set(`/vendor/live2d/${path}`, [`vendor/live2d/${path}`,
    path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8"]);
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request, limit = 12 * 1024 * 1024) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new ServiceError(415, "请求需要使用 JSON。");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new ServiceError(413, "请求超过当前大小上限。");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError(400, "请求内容无效。");
  }
}

function safeEqual(actual, expected) {
  const left = Buffer.from(typeof actual === "string" ? actual : "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createPrototypeServer({ generator = generateAction, timeoutMs = 180_000, store, companion, sync, speech, vault } = {}) {
  const token = randomBytes(32).toString("hex");
  const voice = speech || (store && new SpeechService(store));
  const synchronization = sync || (store && new SyncService(store, { beforeApply: () => { companion.cancel(); voice.cancel(); } }));
  let busy = false;
  const connections = new Connections({ companion, speech: voice, synchronization, vault, imageBusy: () => busy });
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'"
    ].join("; "));
    try {
      const port = request.socket.localPort;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!hosts.has(request.headers.host)) {
        throw new ServiceError(403, "只允许从本机实验台访问。");
      }
      const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      if (request.headers.origin && !origins.has(request.headers.origin)) {
        throw new ServiceError(403, "请求来源无效。");
      }
      const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
      if (request.method === "GET" && pathname === "/live2d-runtime-info.js") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        return response.end(`export const live2DRuntimeInfo = Object.freeze(${JSON.stringify(live2DRuntimeInfo)});`);
      }
      if (request.method === "GET" && pathname === "/api/live2d/runtime")
        return json(response, 200, live2DRuntimeInfo);
      if (request.method === "GET" && pathname === "/api/session") {
        return json(response, 200, { token, busy, prototype: !store });
      }
      if (request.method === "GET" && files.has(pathname)) {
        const [filename, type] = store && ["/", "/index.html"].includes(pathname)
          ? ["companion.html", "text/html; charset=utf-8"] : files.get(pathname);
        const content = await readFile(new URL(filename, publicRoot));
        response.writeHead(200, { "Content-Type": type });
        return response.end(content);
      }
      if (pathname === "/api/connections" || pathname === "/api/image/configure") {
        if (!safeEqual(request.headers["x-niria-token"], token)) throw new ServiceError(403, "本机会话已失效，请刷新页面。");
        if (pathname === "/api/connections" && request.method === "GET") return json(response, 200, connections.status());
        if (pathname === "/api/image/configure" && request.method === "POST") return json(response, 200, await connections.configure("image", await readJson(request, 64 * 1024)));
        return json(response, 404, { error: "找不到这个接口。" });
      }
      if (store && pathname.startsWith("/api/") && pathname !== "/api/generate") {
        if (!safeEqual(request.headers["x-niria-token"], token)) {
          throw new ServiceError(403, "本机会话已失效，请刷新页面后重试。");
        }
        if (request.method === "GET" && pathname === "/api/events") {
          if (!subscribe(response)) throw new ServiceError(429, "本机窗口连接过多，请关闭多余窗口后重试。");
          return;
        }
        if (request.method === "GET" && pathname === "/api/state") {
          const parameters = new URL(request.url, `http://${request.headers.host}`).searchParams;
          if (parameters.has("messages") && parameters.get("messages") !== "recent") throw new ServiceError(400, "消息读取范围无效。");
          if (parameters.has("memories") && parameters.get("memories") !== "none") throw new ServiceError(400, "记忆读取范围无效。");
          const snapshot = store.clientSnapshot({ assets: parameters.get("assets") !== "0", recentMessages: parameters.get("messages") === "recent",
            includeMemories: parameters.get("memories") !== "none" });
          return json(response, 200, { ...snapshot, avatarKey: store.avatarKey, service: companion.status(), synchronization: synchronization.status(), speech: voice.status(), connections: connections.status() });
        }
        if (request.method === "GET" && pathname === "/api/messages") {
          const parameters = new URL(request.url, `http://${request.headers.host}`).searchParams;
          return json(response, 200, store.history.page({ query: parameters.get("q") || "", cursor: parameters.get("cursor") || "",
            anchor: parameters.get("anchor") || "", limit: parameters.has("limit") ? Number(parameters.get("limit")) : 60 }));
        }
        if (request.method === "GET" && pathname === "/api/memories") {
          const parameters = new URL(request.url, `http://${request.headers.host}`).searchParams;
          return json(response, 200, store.memories.page({ query: parameters.get("q") || "", status: parameters.get("status") || "all",
            kind: parameters.get("kind") || "all", cursor: parameters.get("cursor") || "", anchor: parameters.get("anchor") || "",
            limit: parameters.has("limit") ? Number(parameters.get("limit")) : 60 }));
        }
        if (request.method === "GET" && pathname === "/api/context") {
          return json(response, 200, buildContext(store.state));
        }
        if (request.method !== "POST") return json(response, 404, { error: "找不到这个接口。" });
        const input = await readJson(request, ["/api/avatar", "/api/avatar/live2d", "/api/backup/restore"].includes(pathname) ? 120 * 1024 * 1024 : 1024 * 1024);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new ServiceError(400, "请求内容无效。");
        if (pathname === "/api/memories/sources") {
          if (typeof input.id !== "string" || input.id.length > 100 || !Number.isSafeInteger(input.revision)) throw new ServiceError(400, "记忆来源参数无效。");
          return json(response, 200, store.memorySourcePreview(input.id, input.revision));
        }
        if (pathname === "/api/memories/forget-preview") return json(response, 200, store.forgettingPreview(input));
        if (pathname === "/api/memories/references") return json(response, 200, store.memoryReferences(input));
        if (pathname === "/api/chat/activity") {
          if (Object.keys(input).length) throw new ServiceError(400, "输入活动不接收消息正文或其他参数。");
          companion.recordInteraction();
          return json(response, 200, { ok: true });
        }
        connections.assertReady();
        if (pathname === "/api/connection") {
          if (companion.active) throw new ServiceError(409, "请先停止正在处理的请求，再切换服务。");
          await connections.configure("chat", input);
          return json(response, 200, companion.status());
        }
        if (pathname === "/api/connection/test") return json(response, 200, await companion.testConnection());
        if (pathname === "/api/context/preview") {
          const context = previewContext(store.state, input.draft);
          const previewBasis = contextReviewBasis({ identity: store.state.identity, settings: store.state.settings,
            memoryWindow: store.memories.summary(), messageWindow: store.history.summary(),
            connections: connections.status(), service: companion.status(), avatarKey: store.avatarKey }, input.draft);
          return json(response, 200, { ...context, previewBasis });
        }
        if (pathname === "/api/chat") {
          const disconnect = () => { if (!response.writableFinished) companion.cancel(); };
          response.once("close", disconnect);
          try { return json(response, 200, await companion.send(input, { snapshot: false })); }
          finally { response.off("close", disconnect); }
        }
        if (pathname === "/api/cancel") { companion.cancel(); return json(response, 200, { ok: true }); }
        if (pathname === "/api/speech/configure") { await connections.configure("speech", input); return json(response, 200, voice.status()); }
        if (pathname === "/api/speech/speak") return json(response, 200, await voice.speak(input));
        if (pathname === "/api/speech/cancel") { voice.cancel(); return json(response, 200, { ok: true }); }
        if (pathname === "/api/sync/configure") { await connections.configure("sync", input); return json(response, 200, synchronization.status()); }
        if (pathname === "/api/sync/create") {
          const pair = synchronization.createPair(); await connections.rememberPair(input.rememberPair ?? false);
          return json(response, 200, pair);
        }
        if (pathname === "/api/sync/unlock") {
          synchronization.unlock(input.code); await connections.rememberPair(input.rememberPair ?? false);
          return json(response, 200, synchronization.status());
        }
        if (pathname === "/api/sync/pairing") return json(response, 200, synchronization.exportPair());
        if (pathname === "/api/sync/rotation/prepare") return json(response, 200, await connections.prepareSyncRotation());
        if (pathname === "/api/sync/rotation/cancel") return json(response, 200, synchronization.rotation.cancel());
        if (pathname === "/api/sync/rotation/activate") return json(response, 200, await connections.rotateSync(input));
        if (pathname === "/api/sync/rotation/recover") return json(response, 200, await connections.recoverSyncRotation(input));
        if (pathname === "/api/sync/remember") { await connections.rememberPair(input.rememberPair); return json(response, 200, connections.status()); }
        if (pathname === "/api/sync/join") {
          if (companion.active) throw new ServiceError(409, "请先停止聊天，再加入并恢复。");
          await synchronization.join(input.code); await connections.rememberPair(input.rememberPair ?? false);
          return json(response, 200, synchronization.status());
        }
        if (pathname === "/api/sync/probe") return json(response, 200, await synchronization.probe());
        if (pathname === "/api/sync/run") return json(response, 200, await synchronization.sync());
        if (pathname === "/api/sync/lock") {
          await connections.rememberPair(false);
          connections.current.delete("sync");
          return json(response, 200, synchronization.lock());
        }
        if (pathname === "/api/sync/cancel") { synchronization.active?.abort(); return json(response, 200, { ok: true }); }
        if (pathname === "/api/sync/resolve") return json(response, 200, synchronization.resolve(input.key, input.headId));
        if (pathname === "/api/credentials/forget") { await connections.forget(input.slot || "all"); return json(response, 200, connections.status()); }
        if (pathname === "/api/backup/export") return json(response, 200, await encryptBackup(store.exportData(), input.password));
        if (pathname === "/api/backup/restore") {
          if (companion.active) throw new ServiceError(409, "请先停止正在处理的请求，再恢复备份。");
          const restored = await decryptBackup(input.backup, input.password);
          // Recheck after asynchronous key derivation.
          if (companion.active) throw new ServiceError(409, "有新对话正在处理，请稍后恢复备份。");
          voice.cancel();
          store.restore(restored);
          connections.current.delete("sync");
          await connections.rememberPair(false);
          return json(response, 200, { ok: true });
        }
        if (pathname === "/api/avatar/live2d") {
          if (!live2DRuntimeInfo.available)
            return json(response, 200, adoptLive2D(store, input, { runtimeReady: false }));
          const { validateLive2DMoc } = await import("../core/live2d-moc.mjs");
          return json(response, 200, adoptLive2D(store, input, { runtimeReady: live2DRuntimeInfo.available,
            beforeApply: () => { validateLive2DMoc(input.avatar); companion.cancel(); voice.cancel(); } }));
        }
        if (pathname === "/api/avatar" && input.format === "niria-live2d-avatar")
          throw new ServiceError(400, "请先在 Live2D 导入窗口预览，再采用模型。");
        const mutations = new Map([
          ["/api/identity", () => store.identity(input)],
          ["/api/settings", () => store.settings(input)],
          ["/api/messages/edit", () => store.editMessage(input.id, input.content)],
          ["/api/messages/delete", () => store.deleteMessage(input.id)],
          ["/api/memories/add", () => store.addMemory(input)],
          ["/api/memories/edit", () => store.editMemory(input.id, input)],
          ["/api/memories/delete", () => store.deleteMemory(input.id, input.forgetSources === true, input.previewToken)],
          ["/api/avatar", () => store.mutate((state) => { state.avatar = validateAvatar(input); })]
        ]);
        if (mutations.has(pathname)) {
          if (pathname === "/api/memories/delete" && input.forgetSources === true) {
            if (typeof input.previewToken !== "string" || !/^[a-f0-9]{64}$/.test(input.previewToken)) throw new ServiceError(400, "请先查看遗忘清单，再确认删除相关记录。");
            store.forgettingPreview({ id: input.id, token: input.previewToken });
          }
          companion.cancel();
          voice.cancel();
          mutations.get(pathname)();
          return json(response, 200, { ok: true });
        }
        return json(response, 404, { error: "找不到这个接口。" });
      }
      if (request.method === "POST" && pathname === "/api/generate") {
        if (!safeEqual(request.headers["x-niria-token"], token)) {
          throw new ServiceError(403, "实验台会话已失效，请刷新页面后重试。");
        }
        if (busy) throw new ServiceError(409, "已有生成请求正在处理，请等候完成后再试。");
        connections.assertReady();
        busy = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        timeout.unref();
        const disconnect = () => {
          if (!response.writableFinished) controller.abort();
        };
        response.once("close", disconnect);
        try {
          const input = await readJson(request);
          const result = await generator(connections.image(input), { signal: controller.signal });
          if (!response.destroyed) json(response, 200, result);
        } finally {
          clearTimeout(timeout);
          response.off("close", disconnect);
          busy = false;
        }
        return;
      }
      json(response, 404, { error: "找不到这个页面或接口。" });
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      const known = error instanceof ServiceError;
      json(response, known ? error.status : 500, {
        error: known ? error.message : "本机实验台未能处理请求，请重启后重试。"
      });
    }
  });
  const subscribe = store ? stateEvents(server, store) : null;
  server.connections = connections;
  return server;
}

const entry = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) {
  const port = Number(process.env.NIRIA_PORT || 4217);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("NIRIA_PORT 必须是 1024 到 65535 之间的整数。");
  }
  const store = new CompanionStore(resolve(process.env.NIRIA_DATA_DIR || ".niria", "companion.sqlite"));
  const companion = new CompanionService(store);
  const speech = new SpeechService(store);
  const sync = new SyncService(store, { beforeApply: () => { companion.cancel(); speech.cancel(); } });
  const server = createPrototypeServer({ store, companion, sync, speech });
  const careTimer = setInterval(() => {
    if (server.connections.changing) return;
    companion.tick().catch(() => {});
    sync.tick().catch(() => {});
  }, 60_000);
  careTimer.unref();
  server.once("close", () => { clearInterval(careTimer); companion.cancel(); speech.cancel(); sync.lock(); store.close(); });
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE"
      ? `端口 ${port} 已被占用，请设置 NIRIA_PORT 后重试。`
      : "无法启动 NIRIA 本机实验台。");
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`NIRIA 本机伴侣：http://127.0.0.1:${port}`);
    console.log("只监听本机；聊天与形象保存在本地，服务密钥仅在当前进程中使用。按 Ctrl+C 结束。");
  });
}
