import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createPrototypeServer } from "../prototype/server.mjs";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService, buildContext } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { davFixture } from "../tests/fixtures/dav.mjs";
import { verifyFrameRendering } from "../desktop/render-smoke.mjs";
import { verifyMemoryBrowsing } from "../desktop/memory-browser-smoke.mjs";
import { verifyBackgroundEditor, verifyBackgroundFailures } from "../desktop/background-smoke.mjs";
import { verifyContextReview } from "../desktop/context-smoke.mjs";
import { verifyRegeneration } from "../desktop/regeneration-smoke.mjs";
import { verifyCare } from "../desktop/care-smoke.mjs";
import { verifyLive2D } from "../desktop/live2d-smoke.mjs";
import { readRealLive2D, verifyRealLive2D } from "../desktop/live2d-real-smoke.mjs";
import { verifyAnimeFace } from "../desktop/animeface-smoke.mjs";
import { verifyAvatarSafety } from "../desktop/avatar-safety-smoke.mjs";
import { verifyImageGeneration } from "../desktop/image-generation-smoke.mjs";
import { verifySpeechSafety } from "../desktop/speech-safety-smoke.mjs";
import { verifyChatFaults } from "../desktop/chat-fault-smoke.mjs";
import { verifySyncSafety } from "../desktop/sync-safety-smoke.mjs";
import { verifyBackupSafety } from "../desktop/backup-safety-smoke.mjs";
import { verifyCredentialSafety } from "../desktop/credential-safety-smoke.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const realLive2D = process.argv.includes("--live2d-real");
const faceMode = process.argv.includes("--faces");
const avatarSafetyMode = process.argv.includes("--avatar-safety");
const imageCallsMode = process.argv.includes("--image-calls");
const speechSafetyMode = process.argv.includes("--speech-safety");
const chatFaultMode = process.argv.includes("--chat-faults");
const syncSafetyMode = process.argv.includes("--sync-safety");
const backupSafetyMode = process.argv.includes("--backup-safety");
const credentialSafetyMode = process.argv.includes("--credential-safety");
const companionMode = process.argv.includes("--companion") || realLive2D || avatarSafetyMode || imageCallsMode || speechSafetyMode || chatFaultMode || syncSafetyMode || backupSafetyMode || credentialSafetyMode;
const output = path.join(root, "artifacts");
await mkdir(output, { recursive: true });
const downloads = path.join(output, `downloads-${Date.now()}`);
await mkdir(downloads, { recursive: true });
const browserCandidates = [
  process.env.NIRIA_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);
let executable;
for (const candidate of browserCandidates) {
  try { await access(candidate); executable = candidate; break; } catch { /* next */ }
}
if (!executable) throw new Error("未找到浏览器，请用 NIRIA_BROWSER 指定 Chromium 浏览器路径。");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params.exceptionDetails.text);
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        }
      }
    });
  }
  call(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    this.socket.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser closed"));
    }
    this.pending.clear();
  }
}

let providerCalls = 0;
let speechCalls = 0;
let expressionReply = null;
let imageReply = null;
const mock = http.createServer(async (request, response) => {
  try {
    if (request.url === "/v1/audio/speech" && companionMode) {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      assert.equal(input.response_format, "wav");
      assert.equal(input.input.includes("NIRIA_EXPRESSION"), false);
      assert.equal(request.headers.authorization, "Bearer fake-speech-key");
      speechCalls++;
      const audio = Buffer.alloc(1644);
      audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
      audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
      audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32);
      audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(1600, 40);
      response.writeHead(200, { "Content-Type": "audio/wav" }); response.end(audio); return;
    }
    if (request.url === "/v1/chat/completions" && companionMode) {
      assert.equal(request.headers.authorization, "Bearer fake-browser-test-key");
      let serialized = "";
      for await (const chunk of request) serialized += chunk;
      const input = JSON.parse(serialized);
      providerCalls++;
      const memory = input.messages[0]?.content.includes("记忆整理器");
      const reply = memory ? JSON.stringify({ memories: [{ content: "用户喜欢乌龙茶", kind: "fact", expiresAt: null }] }) : expressionReply || "我会记得你喜欢乌龙茶。今天想聊点什么？";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      return;
    }
    assert.equal(request.url, "/v1/images/edits");
    assert.equal(request.headers.authorization, "Bearer fake-browser-test-key");
    const body = new Request("http://test.local", {
      method: "POST", headers: request.headers, body: Readable.toWeb(request), duplex: "half"
    });
    const form = await body.formData();
    assert.equal(form.get("n"), "1");
    assert.equal(form.get("model"), "browser-test-model");
    const reference = form.get("image");
    providerCalls++;
    await delay(50);
    // Transport fixture only. Echoing the reference does NOT validate AI or animation quality.
    const encoded = imageReply ? imageReply.slice("data:image/png;base64,".length) : Buffer.from(await reference.arrayBuffer()).toString("base64");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: encoded }] }));
  } catch {
    response.writeHead(500);
    response.end("{}");
  }
});
const store = companionMode ? new CompanionStore() : null;
const companion = store ? new CompanionService(store) : null;
const app = createPrototypeServer(companionMode ? { store, companion } : {});
const mockUrl = await listen(mock);
const appUrl = await listen(app);
const dav = companionMode ? await davFixture() : null;
let peer;
let child;
let cdp;
try {
  const profile = path.join(output, `browser-profile-${Date.now()}`);
  child = spawn(executable, [
    "--headless=new", "--disable-gpu", "--disable-extensions",
    "--disable-background-networking", "--disable-component-update",
    "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("浏览器未能启动调试会话。")), 20_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`浏览器提前退出：${code}`)));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const socket = new WebSocket(endpoint);
  await once(socket, "open");
  cdp = new CDP(socket);
  await cdp.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => cdp.call(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    const visibleState = await evaluate(`({
      notice: document.querySelector('#notice')?.textContent,
      sync: document.querySelector('#sync-status')?.textContent,
      rotation: document.querySelector('#rotation-status')?.textContent,
      rotationDownloadDisabled: document.querySelector('#rotation-download')?.disabled,
      rotationActivateDisabled: document.querySelector('#rotation-activate')?.disabled
    })`);
    throw new Error(`页面条件未满足：${expression}\n${JSON.stringify(visibleState)}`);
  };
  const screenshot = async (name) => {
    const { data } = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(path.join(output, name), Buffer.from(data, "base64"));
  };
  const editMemory = async (id) => {
    await until(`(() => {
      const button = [...document.querySelectorAll('.memory-card[data-id="${id}"] button')].find(item => item.textContent === '编辑');
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`);
    await until("document.querySelector('#edit-dialog').open");
  };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false
  });
  await call("Page.navigate", { url: appUrl });
  await until("document.readyState === 'complete'");
  if (faceMode) {
    const directory = path.join(root, "artifacts/animeface-validation");
    const cases = JSON.parse(await readFile(path.join(directory, "cases.json"), "utf8"));
    const examples = [];
    for (const example of cases.filter(example => example.name !== "empty")) {
      const bytes = await readFile(path.join(directory, example.file));
      const url = await evaluate(`(() => {
        const gray = Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), char => char.charCodeAt(0));
        const canvas = document.createElement('canvas'); canvas.width = ${example.width}; canvas.height = ${example.height};
        const context = canvas.getContext('2d'), pixels = context.createImageData(canvas.width, canvas.height);
        gray.forEach((value, index) => pixels.data.set([value,value,value,255], index * 4));
        context.putImageData(pixels,0,0); return canvas.toDataURL('image/png');
      })()`);
      examples.push({ name: example.name, count: example.expected.length, url });
    }
    const checks = await verifyAnimeFace({ evaluate, examples });
    assert.deepEqual(cdp.errors, []);
    assert.equal(providerCalls, 0);
    console.log(JSON.stringify({ passed: true, checks, providerCalls, errors: cdp.errors }, null, 2));
  } else if (credentialSafetyMode) {
    const checks = await verifyCredentialSafety({ evaluate,
      navigate: (path) => call("Page.navigate", { url: new URL(path, appUrl).href }) });
    assert.deepEqual(cdp.errors, []);
    assert.equal(providerCalls, 0);
    assert.equal(speechCalls, 0);
    console.log(JSON.stringify({ passed: true, checks, providerCalls, errors: cdp.errors }, null, 2));
  } else if (backupSafetyMode) {
    const checks = await verifyBackupSafety({ evaluate,
      navigate: (path) => call("Page.navigate", { url: new URL(path, appUrl).href }) });
    assert.deepEqual(cdp.errors, []);
    assert.equal(providerCalls, 0);
    assert.equal(speechCalls, 0);
    console.log(JSON.stringify({ passed: true, checks, providerCalls, errors: cdp.errors }, null, 2));
  } else if (syncSafetyMode) {
    const checks = await verifySyncSafety({ store, sync: app.connections.services.sync, connections: app.connections,
      evaluate, navigate: (path) => call("Page.navigate", { url: `${appUrl}${path}` }), davBaseUrl: dav.baseUrl });
    assert.deepEqual(cdp.errors, []);
    assert.equal(providerCalls, 0);
    console.log(JSON.stringify({ passed: true, checks, providerCalls, errors: cdp.errors }, null, 2));
  } else if (chatFaultMode) {
    await until("document.querySelector('#calls-list')?.children.length > 0");
    const checks = await verifyChatFaults({ store, companion, evaluate,
      navigate: (path) => call("Page.navigate", { url: `${appUrl}${path}` }) });
    assert.deepEqual(cdp.errors, []);
    assert.equal(providerCalls, 0);
    console.log(JSON.stringify({ passed: true, checks, syntheticCompletions: 7, providerCalls, errors: cdp.errors }, null, 2));
  } else if (speechSafetyMode) {
    await until("document.querySelector('#calls-list')?.children.length > 0");
    const checks = await verifySpeechSafety({ store, evaluate,
      navigate: (path) => call("Page.navigate", { url: `${appUrl}${path}` }),
      capture: () => screenshot("speech-waiting-browser.png") });
    assert.deepEqual(cdp.errors, []);
    assert.equal(providerCalls, 0);
    assert.equal(speechCalls, 0);
    console.log(JSON.stringify({ passed: true, checks, localSpeechRequests: 6, providerCalls, errors: cdp.errors }, null, 2));
  } else if (imageCallsMode) {
    await until("!!document.querySelector('#open-live2d') && document.querySelector('#connection-status')?.textContent.includes('配置')");
    const checks = await verifyImageGeneration({ store, evaluate, navigate: (path) => call("Page.navigate", { url: `${appUrl}${path}` }) });
    assert.deepEqual(cdp.errors, []);
    assert.equal(providerCalls, 0);
    console.log(JSON.stringify({ passed: true, checks, localImageRequests: 3, providerCalls, errors: cdp.errors }, null, 2));
  } else if (avatarSafetyMode) {
    await until("!!document.querySelector('#open-live2d') && document.querySelector('#connection-status')?.textContent.includes('配置')");
    const checks = await verifyAvatarSafety({ store, evaluate, navigate: (path) => call("Page.navigate", { url: `${appUrl}${path}` }) });
    assert.deepEqual(cdp.errors, []);
    assert.equal(providerCalls, 0);
    console.log(JSON.stringify({ passed: true, checks, providerCalls, errors: cdp.errors }, null, 2));
  } else if (realLive2D) {
    await until("!!document.querySelector('#open-live2d') && document.querySelector('#connection-status')?.textContent.includes('配置')");
    const directory = process.env.NIRIA_LIVE2D_MODEL_DIR || path.join(root, "artifacts/cubism-sdk-5-r5/CubismSdkForWeb-5-r.5/Samples/Resources/Haru");
    const checks = await verifyRealLive2D({ store, evaluate, bundle: await readRealLive2D(directory),
      davBaseUrl: dav.baseUrl,
      capture: () => screenshot("live2d-real-haru.png"),
      reload: () => call("Page.reload"),
      setReduced: (reduce) => call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] }) });
    assert.deepEqual(cdp.errors, []);
    console.log(JSON.stringify({ passed: true, officialSample: path.basename(directory), checks, providerCalls, errors: cdp.errors }, null, 2));
  } else {
  const renderChecks = await verifyFrameRendering(evaluate);
  assert.ok(Object.values(renderChecks).every(Boolean), JSON.stringify(renderChecks));
  if (companionMode) {
    await until("document.readyState === 'complete' && document.querySelector('#connection-status')?.textContent.includes('配置')");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await screenshot("companion-browser.png");
    const memoryBrowseChecks = await verifyMemoryBrowsing({ store, evaluate, capture: async () => {
      await screenshot("companion-memory-browser.png");
      await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('#view-memories').scrollWidth <= document.querySelector('#view-memories').clientWidth"), true);
      await screenshot("companion-memory-browser-mobile.png");
      await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
    } });
    const contextChecks = await verifyContextReview({ store, companion: app.connections.services.chat, evaluate,
      capture: async () => {
        await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        assert.equal(await evaluate("document.querySelector('#context-dialog').scrollWidth <= document.querySelector('#context-dialog').clientWidth"), true);
        await screenshot("companion-context-mobile.png");
        await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
      } });
    const regenerationChecks = await verifyRegeneration({ store, companion: app.connections.services.chat, evaluate,
      capture: async () => {
        await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
        await screenshot("companion-regeneration-mobile.png");
        await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
      } });
    const careChecks = await verifyCare({ store, companion: app.connections.services.chat, evaluate,
      capture: async () => {
        await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
        await screenshot("companion-care-mobile.png");
        await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
      } });
    const live2dChecks = await verifyLive2D({ store, evaluate, capture: async () => {
      await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate("document.querySelector('#live2d-dialog').scrollWidth <= document.querySelector('#live2d-dialog').clientWidth"), true);
      await screenshot("companion-live2d-import-mobile.png");
      await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
    } });
    const initialState = store.snapshot(), historyCalls = providerCalls;
    const historyMessages = Array.from({ length: 247 }, (_, index) => {
      const at = new Date(Date.now() - (247 - index) * 1000).toISOString();
      return { id: randomUUID(), role: index % 2 ? "assistant" : "user",
        content: index === 0 ? "早期来源：旧日散步 <img src=x onerror=window.__historyXss=1>" :
          index === 20 ? "更晚独特的聊天片段" : `隔离历史聊天 ${index}`,
        revision: 1, deleted: false, status: "completed", createdAt: at, updatedAt: at };
    });
    await evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.__historyStateReads = [];
      window.fetch = async (...args) => {
        const url = new URL(String(args[0]), location.href);
        if (url.pathname === "/api/state") window.__historyStateReads.push(url.searchParams.get("messages"));
        const response = await original(...args);
        if (url.pathname === "/api/messages" && url.searchParams.get("q") === "延迟查找") {
          window.__historyDelayed = true;
          await new Promise(resolve => { window.__releaseHistory = resolve; });
        }
        return response;
      };
    })()`);
    store.mutate((state) => { state.messages = historyMessages; });
    const oldMemory = store.addMemory({ content: "测试：早期散步的记忆", sources: [{ id: historyMessages[0].id, revision: 1 }] });
    await until("document.querySelectorAll('#messages .message').length === 120");
    assert.equal(await evaluate("document.querySelector('#messages').textContent.includes('旧日散步')"), false);
    assert.ok((await evaluate("window.__historyStateReads")).every((value) => value === "recent"));
    const compactRead = await evaluate(`(async () => {
      const { token } = await (await fetch("/api/session")).json();
      return await (await fetch("/api/state?messages=recent&assets=0", {headers: {"X-Niria-Token": token}})).json();
    })()`);
    assert.equal(compactRead.messages.length, 120);
    assert.equal(compactRead.messageWindow.total, 247);
    assert.equal(Object.hasOwn(compactRead, "avatar"), false);
    await evaluate("document.querySelector('#open-history').click()");
    await until("document.querySelectorAll('#history-results .message').length === 60");
    assert.equal(await evaluate("document.querySelector('#history-results .message').dataset.id"), historyMessages[187].id);
    assert.equal(await evaluate("[...document.querySelectorAll('#history-results button')].filter(b => b.textContent === '编辑').length"), 1);
    await evaluate("document.querySelector('#history-older').click()");
    await until(`document.querySelector('#history-results .message')?.dataset.id === ${JSON.stringify(historyMessages[127].id)}`);
    assert.equal(await evaluate("[...document.querySelectorAll('#history-results button')].filter(b => b.textContent === '编辑').length"), 0);
    await evaluate("document.querySelector('#history-newer').click()");
    await until(`document.querySelector('#history-results .message')?.dataset.id === ${JSON.stringify(historyMessages[187].id)}`);
    await evaluate("document.querySelector('#history-query').value = '旧日散步'; document.querySelector('#history-search').requestSubmit()");
    await until("document.querySelectorAll('#history-results .message').length === 1 && document.querySelector('#history-results').textContent.includes('旧日散步')");
    assert.equal(await evaluate("!!window.__historyXss || !!document.querySelector('#history-results img')"), false);
    await evaluate("[...document.querySelectorAll('#history-results button')].find(b => b.textContent === '查看前后聊天').click()");
    await until("document.querySelector('#history-query').value === '' && document.querySelectorAll('#history-results .message').length > 1");
    await evaluate("document.querySelector('#history-query').value = '延迟查找'; document.querySelector('#history-search').requestSubmit()");
    await until("window.__historyDelayed");
    await evaluate("document.querySelector('#history-query').value = '更晚独特'; document.querySelector('#history-search').requestSubmit()");
    await until("document.querySelector('#history-results').textContent.includes('更晚独特')");
    await evaluate("window.__releaseHistory()");
    await delay(150);
    assert.equal(await evaluate("document.querySelectorAll('#history-results .message').length"), 1);
    assert.equal(await evaluate("document.querySelector('#history-results').textContent.includes('更晚独特')"), true);
    store.deleteMessage(historyMessages[20].id);
    await until("document.querySelector('#history-status').textContent.includes('找到 0 条') && !document.querySelector('#history-results').textContent.includes('更晚独特')");
    await evaluate("document.querySelector('#history-query').value = '隔离历史聊天 246'; document.querySelector('#history-search').requestSubmit()");
    await until("document.querySelectorAll('#history-results .message').length === 1");
    await evaluate("[...document.querySelectorAll('#history-results button')].find(b => b.textContent === '编辑').click()");
    await until("document.querySelector('#edit-dialog').open");
    await evaluate("document.querySelector('#edit-content').value = '修正后的历史测试'; document.querySelector('#edit-form').requestSubmit()");
    await until("!document.querySelector('#edit-dialog').open && document.querySelector('#history-status').textContent.includes('找到 0 条')");
    await evaluate("document.querySelector('[data-close=\"history-dialog\"]').click(); document.querySelector('[data-view=\"memories\"]').click()");
    await until(`!!document.querySelector('.memory-card[data-id="${oldMemory}"]')`);
    await evaluate(`document.querySelector('.memory-card[data-id="${oldMemory}"] details').open = true`);
    await until("document.querySelector('.memory-source blockquote')?.textContent.includes('旧日散步')");
    assert.equal(await evaluate("!!window.__historyXss || !!document.querySelector('.memory-source img')"), false);
    await evaluate("document.querySelector('.memory-source blockquote button').click()");
    await until("document.querySelector('#history-results').textContent.includes('旧日散步')");
    await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('#history-dialog').scrollWidth <= document.querySelector('#history-dialog').clientWidth"), true);
    await screenshot("companion-history-mobile.png");
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
    await screenshot("companion-history.png");
    await evaluate("document.querySelector('[data-close=\"history-dialog\"]').click()");
    await until("document.querySelector('#history-results').children.length === 0");
    store.deleteMessage(historyMessages[0].id);
    await until("document.querySelector('.memory-card')?.textContent.includes('来源改变')");
    await evaluate("document.querySelector('.memory-source').open = true");
    await until("document.querySelector('.memory-source blockquote')?.textContent.includes('来源已修改')");
    assert.equal(await evaluate("document.querySelector('.memory-source').textContent.includes('旧日散步')"), false);
    assert.equal(providerCalls, historyCalls, "history browsing, edits, deletion and sources must not call providers");
    store.mutate(() => { store.state = structuredClone(initialState); });
    await evaluate("document.querySelector('[data-view=\"chat\"]').click()");
    await until("document.querySelectorAll('#messages .message').length === 0");
    const lifecycleRoot = store.addUser("遗忘测试：只清除这段来源");
    const lifecycleReply = { ...lifecycleRoot, id: randomUUID(), role: "assistant", content: "遗忘测试：第一条关联回复", replyTo: lifecycleRoot.id };
    const lifecycleNested = { ...lifecycleReply, id: randomUUID(), content: "遗忘测试：另一条关联回复", replyTo: lifecycleReply.id };
    store.mutate((state) => { state.messages.push(lifecycleNested, lifecycleReply); });
    const preservedMessage = store.addUser("保留测试：独立聊天");
    const originalDeadline = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const lifecycleMemory = store.addMemory({ content: "遗忘测试：待确认的临时资料", kind: "inference", expiresAt: originalDeadline,
      sources: [{ id: lifecycleRoot.id, revision: 1 }] }, { automatic: true });
    store.addMemory({ content: "遗忘测试：从回复提取的资料甲", sources: [{ id: lifecycleReply.id, revision: 1 }] });
    store.addMemory({ content: "遗忘测试：从回复提取的资料乙", sources: [{ id: lifecycleNested.id, revision: 1 }] });
    for (let i = 0; i < 31; i++) store.addMemory({ content: `遗忘测试：同源资料 ${i}`, sources: [{ id: lifecycleRoot.id, revision: 1 }] });
    const originalSources = structuredClone(store.state.memories.find((item) => item.id === lifecycleMemory).sources);
    await evaluate("document.querySelector('[data-view=\"memories\"]').click()");
    await until(`!!document.querySelector('.memory-card[data-id="${lifecycleMemory}"]')`);
    const editLifecycle = () => editMemory(lifecycleMemory);
    await editLifecycle();
    await until("document.querySelector('#edit-dialog').open && !document.querySelector('#edit-memory-fields').hidden");
    assert.equal(await evaluate("document.querySelector('#edit-memory-permanent').checked"), false);
    await evaluate("document.querySelector('#edit-memory-kind').value = 'experience'; document.querySelector('#edit-form').requestSubmit()");
    await until("!document.querySelector('#edit-dialog').open");
    let editedMemory = store.state.memories.find((item) => item.id === lifecycleMemory);
    assert.equal(editedMemory.expiresAt, originalDeadline, "unchanged local minutes must preserve exact UTC seconds");
    assert.deepEqual(editedMemory.sources, originalSources);
    assert.equal(editedMemory.confirmed, false, "type/expiry changes do not silently confirm automatic memories");
    assert.equal(editedMemory.kind, "experience");
    await editLifecycle();
    await evaluate(`(() => {
      const date = new Date(Date.now() + 2 * 86400000);
      document.querySelector('#edit-memory-expiry').value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    })()`);
    await screenshot("companion-memory-expiry.png");
    await evaluate("document.querySelector('#edit-form').requestSubmit()");
    await until("!document.querySelector('#edit-dialog').open");
    editedMemory = store.state.memories.find((item) => item.id === lifecycleMemory);
    assert.ok(Date.parse(editedMemory.expiresAt) < Date.parse(originalDeadline));
    assert.deepEqual(editedMemory.sources, originalSources);
    await editLifecycle();
    await evaluate("document.querySelector('#edit-memory-expiry').value = '2020-01-01T00:00'; document.querySelector('#edit-form').requestSubmit()");
    await until("document.querySelector('#notice').textContent.includes('未来')");
    assert.equal(await evaluate("document.querySelector('#edit-dialog').open"), true);
    await evaluate("document.querySelector('#edit-memory-permanent').click(); document.querySelector('#edit-form').requestSubmit()");
    await until("!document.querySelector('#edit-dialog').open");
    assert.equal(store.state.memories.find((item) => item.id === lifecycleMemory).expiresAt, null);
    assert.deepEqual(store.state.memories.find((item) => item.id === lifecycleMemory).sources, originalSources);
    await evaluate("document.querySelector('#add-memory').click(); document.querySelector('#edit-content').value = '保留测试：临时安排'; document.querySelector('#edit-memory-permanent').click(); document.querySelector('#edit-memory-kind').value = 'experience'; document.querySelector('#edit-form').requestSubmit()");
    await until("!document.querySelector('#edit-dialog').open");
    const preservedMemory = store.state.memories.find((item) => item.content === "保留测试：临时安排");
    assert.ok(preservedMemory?.expiresAt);
    assert.equal(preservedMemory.kind, "experience");
    assert.equal(preservedMemory.sources.length, 0);
    await editMemory(preservedMemory.id);
    store.mutate((state) => { state.memories.find((item) => item.id === preservedMemory.id).content = "保留测试：收到的新版本"; });
    await evaluate("document.querySelector('#edit-content').value = '不应覆盖的新编辑'; document.querySelector('#edit-form').requestSubmit()");
    await until("document.querySelector('#notice').textContent.includes('别处改变')");
    assert.equal(store.state.memories.find((item) => item.id === preservedMemory.id).content, "保留测试：收到的新版本");
    await evaluate("document.querySelector('[data-close=\"edit-dialog\"]').click()");
    await editLifecycle();
    await evaluate("document.querySelector('#edit-content').value = '遗忘测试：手动纠正的资料'; document.querySelector('#edit-form').requestSubmit()");
    await until(`!document.querySelector('#edit-dialog').open && document.querySelector('.memory-card[data-id="${lifecycleMemory}"] .memory-source summary')?.textContent.includes('原关联记录')`);
    editedMemory = store.state.memories.find((item) => item.id === lifecycleMemory);
    assert.deepEqual(editedMemory.sources, []);
    assert.deepEqual(editedMemory.supersededSources, originalSources);
    assert.equal(editedMemory.confirmed, true);
    assert.equal(buildContext(store.state).refs.messageRefs.some((item) => [lifecycleRoot.id, lifecycleReply.id, lifecycleNested.id].includes(item.id)), false);
    assert.equal(buildContext(store.state).refs.memoryRefs.some((item) => item.id !== lifecycleMemory && store.state.memories.find((memory) => memory.id === item.id)?.content.includes("遗忘测试")), false);
    await evaluate(`document.querySelector('.memory-card[data-id="${lifecycleMemory}"] .memory-source').open = true`);
    await until(`document.querySelector('.memory-card[data-id="${lifecycleMemory}"] .memory-source blockquote')?.textContent.includes('遗忘测试：只清除这段来源')`);
    await evaluate(`document.querySelector('.memory-card[data-id="${lifecycleMemory}"]').scrollIntoView({ block: 'center' })`);
    await screenshot("companion-memory-correction.png");
    const openForgetting = `[...document.querySelectorAll('.memory-card[data-id="${lifecycleMemory}"] button')].find(button => button.textContent === '忘记相关记录').click()`;
    const beforeReview = store.snapshot();
    await evaluate(openForgetting);
    await until("document.querySelector('#forget-dialog').open && !document.querySelector('#forget-confirm').disabled");
    assert.match(await evaluate("document.querySelector('#forget-counts').textContent"), /34 条记忆、1 条来源消息、2 条关联回复/);
    assert.equal(await evaluate("document.querySelector('#forget-list').children.length"), 30);
    await evaluate("document.querySelector('#forget-more').click()");
    await until("document.querySelector('#forget-list').children.length === 37");
    await screenshot("companion-forget-review.png");
    await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate("document.querySelector('#forget-dialog').scrollWidth <= document.querySelector('#forget-dialog').clientWidth"), true);
    await screenshot("companion-forget-mobile.png");
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('[data-close=\"forget-dialog\"]').click()");
    await until("document.querySelector('#forget-list').children.length === 0");
    assert.deepEqual(store.snapshot(), beforeReview, "review and cancellation must not mutate companion data");
    await evaluate(openForgetting);
    await until("!document.querySelector('#forget-confirm').disabled");
    await evaluate(`document.querySelector('[data-close="forget-dialog"]').click(); ${openForgetting}`);
    await until("document.querySelector('#forget-dialog').open && !document.querySelector('#forget-confirm').disabled && document.querySelector('#forget-list').children.length === 30");
    assert.deepEqual(store.snapshot(), beforeReview, "an immediate close and reopen preserves the new review and makes no writes");
    await evaluate("document.querySelector('[data-close=\"forget-dialog\"]').click()");
    await until("document.querySelector('#forget-list').children.length === 0");
    await evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.__holdForget = false;
      window.__forgetRelease = [];
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (new URL(String(args[0]), location.href).pathname === "/api/memories/forget-preview" && window.__holdForget) {
          await new Promise(resolve => window.__forgetRelease.push(resolve));
        }
        return response;
      };
    })()`);
    await evaluate(openForgetting);
    await until("!document.querySelector('#forget-confirm').disabled");
    await evaluate("window.__holdForget = true");
    store.addMemory({ content: "遗忘测试：预览后的新衍生记忆", sources: [{ id: lifecycleRoot.id, revision: 1 }] });
    await until("window.__forgetRelease.length > 0 && document.querySelector('#forget-confirm').disabled");
    assert.equal(await evaluate("document.querySelector('#forget-list').children.length"), 0, "changed review must immediately drop old snippets");
    await evaluate("document.querySelector('[data-close=\"forget-dialog\"]').click(); window.__holdForget = false; window.__forgetRelease.forEach(resolve => resolve())");
    await delay(150);
    assert.equal(await evaluate("document.querySelector('#forget-list').children.length"), 0, "closed review rejects delayed results");
    await evaluate(openForgetting);
    await until("!document.querySelector('#forget-confirm').disabled && document.querySelector('#forget-counts').textContent.includes('35 条记忆')");
    await evaluate("document.querySelector('#forget-confirm').click()");
    await until("!document.querySelector('#forget-dialog').open && !document.querySelector('#memory-list').textContent.includes('遗忘测试')");
    assert.equal(store.findMessage(preservedMessage.id).content, preservedMessage.content);
    assert.equal(store.state.memories.find((item) => item.id === preservedMemory.id).deleted, false);
    assert.equal(JSON.stringify(store.snapshot()).includes("遗忘测试"), false);
    assert.equal(providerCalls, 0, "memory editing and forgetting must not call providers");
    store.mutate(() => { store.state = structuredClone(initialState); });
    await evaluate("document.querySelector('[data-view=\"chat\"]').click()");
    await until("document.querySelectorAll('#messages .message').length === 0");
    await evaluate("document.querySelector('#open-settings').click()");
    await evaluate(`(() => {
      document.querySelector('#chat-base').value = ${JSON.stringify(`${mockUrl}/v1`)};
      document.querySelector('#chat-model').value = 'browser-test-model';
      document.querySelector('#chat-key').value = 'fake-browser-test-key';
      document.querySelector('#connection-form').requestSubmit();
    })()`);
    await until("!document.querySelector('#settings-dialog').open && document.querySelector('#connection-status').textContent.includes('已连接')");
    assert.equal(providerCalls, 0, "configuration alone must not call a paid provider");
    await evaluate("document.querySelector('#message-input').value = '我喜欢喝乌龙茶'; document.querySelector('#composer').requestSubmit(); document.querySelector('#composer').requestSubmit()");
    await until("document.querySelectorAll('.message.assistant.completed').length === 1 && !document.querySelector('#send-message').disabled");
    assert.equal(providerCalls, 2, "one chat plus one extraction; duplicate submit must not add requests");
    assert.equal(store.state.memories.length, 1);
    assert.equal(store.state.memories[0].confirmed, false);
    await evaluate("document.querySelector('[data-view=\"memories\"]').click()");
    await until("document.querySelectorAll('.memory-card').length === 1");
    await evaluate("[...document.querySelectorAll('.memory-card button')].find(b => b.textContent === '确认').click()");
    await until("document.querySelector('.memory-card .tag')?.textContent === '已确认'");
    await screenshot("companion-memories.png");
    await evaluate(`(() => {
      document.querySelector('#open-settings').click();
      document.querySelector('[data-tab="speech"]').click();
      document.querySelector('#speech-base').value = ${JSON.stringify(`${mockUrl}/v1`)};
      document.querySelector('#speech-model').value = 'browser-speech';
      document.querySelector('#speech-voice').value = 'fixture-voice';
      document.querySelector('#speech-key').value = 'fake-speech-key';
      document.querySelector('#speech-form').requestSubmit();
    })()`);
    await until("!document.querySelector('#settings-dialog').open");
    assert.equal(speechCalls, 0);
    await evaluate("document.querySelector('[data-view=\"chat\"]').click(); [...document.querySelectorAll('.message.assistant button')].find(b => b.textContent.includes('朗读')).click()");
    await until("!document.querySelector('#speech-player').hidden && document.querySelector('#speech-audio').src.startsWith('blob:')");
    assert.equal(speechCalls, 1);
    assert.equal(await evaluate("document.querySelector('#speech-audio').src.startsWith('blob:')"), true);
    await evaluate("document.querySelector('#speech-stop').click()");
    await evaluate(`(() => {
      document.querySelector('#open-settings').click();
      document.querySelector('[data-tab="sync"]').click();
      document.querySelector('#sync-base').value = ${JSON.stringify(dav.baseUrl)};
      document.querySelector('#sync-form').requestSubmit();
    })()`);
    await until("document.querySelector('#sync-status').textContent.includes('已配置')");
    assert.equal(dav.calls.length, 0, "saving sync connection must not upload");
    await evaluate("document.querySelector('#sync-create').click()");
    await until("document.querySelector('#sync-code').value.startsWith('NIRIA1.')");
    const code = await evaluate("document.querySelector('#sync-code').value");
    await evaluate("document.querySelector('#sync-run').click()");
    await until("document.querySelector('#sync-status').textContent.includes('上次同步')");
    peer = new CompanionStore();
    const peerSync = new SyncService(peer);
    peerSync.configure({ baseUrl: dav.baseUrl, auto: false });
    await peerSync.join(code);
    assert.equal(peer.state.messages.filter((m) => !m.deleted).length, 2);
    assert.equal(peer.state.memories.length, 1);
    peer.identity({ name: "另一端的名字" });
    await evaluate("document.querySelector('[data-tab=\"identity\"]').click(); document.querySelector('#identity-name').value = '这一端的名字'; document.querySelector('#identity-form').requestSubmit()");
    await until("!document.querySelector('#settings-dialog').open && document.querySelector('#companion-name').textContent === '这一端的名字'");
    await peerSync.sync();
    await evaluate("document.querySelector('#open-settings').click(); document.querySelector('[data-tab=\"sync\"]').click(); document.querySelector('#sync-run').click()");
    await until("document.querySelectorAll('#sync-conflicts .sync-candidate').length === 2");
    await evaluate("document.querySelector('#sync-conflicts').scrollIntoView({block:'start'})");
    await screenshot("companion-sync-conflict.png");
    await evaluate("[...document.querySelectorAll('.sync-candidate')].find(n => n.textContent.includes('另一端的名字')).querySelector('button').click()");
    await until("document.querySelector('#companion-name').textContent === '另一端的名字' && document.querySelectorAll('#sync-conflicts .sync-candidate').length === 0");
    await evaluate("document.querySelector('#sync-run').click()");
    await until("!document.querySelector('#sync-run').disabled");
    await peerSync.sync();
    assert.equal(peer.state.identity.name, "另一端的名字");
    const beforePrepare = dav.calls.length;
    await evaluate("document.querySelector('#rotation-prepare').click()");
    await until("!document.querySelector('#rotation-plan').hidden && document.querySelector('#rotation-code').value.startsWith('NIRIA1.') && !document.querySelector('#rotation-download').disabled");
    assert.equal(dav.calls.length, beforePrepare, "preparation must not contact WebDAV");
    assert.equal(await evaluate("document.querySelector('#rotation-activate').disabled"), true);
    const preparedCode = await evaluate("document.querySelector('#rotation-code').value");
    await call("Page.reload");
    await until("document.querySelector('#companion-name')?.textContent === '另一端的名字'");
    await evaluate("document.querySelector('#open-settings').click(); document.querySelector('[data-tab=\"sync\"]').click()");
    await until("document.querySelector('#rotation-prepare').textContent.includes('重新显示')");
    await evaluate("document.querySelector('#rotation-prepare').click()");
    await until("!document.querySelector('#rotation-plan').hidden && !document.querySelector('#rotation-download').disabled");
    assert.equal(await evaluate("document.querySelector('#rotation-code').value"), preparedCode);
    assert.equal(dav.calls.length, beforePrepare);
    await evaluate("document.querySelector('#rotation-download').click()");
    let recovery;
    for (let i = 0; i < 60; i++) {
      const file = (await readdir(downloads)).find((name) => /^niria-key-change-.*\.json$/.test(name));
      if (file) { recovery = JSON.parse(await readFile(path.join(downloads, file), "utf8")); break; }
      await delay(100);
    }
    assert.equal(recovery?.previousCode, code);
    assert.equal(recovery?.code, preparedCode);
    assert.equal(recovery?.format, "niria-key-change-recovery");
    assert.equal(JSON.stringify(recovery).includes("乌龙茶"), false);
    await evaluate("document.querySelector('#rotation-saved').click()");
    assert.equal(await evaluate("document.querySelector('#rotation-activate').disabled"), false);
    await evaluate("document.querySelector('#rotation-activate').click()");
    await until("document.querySelector('#rotation-plan').hidden && document.querySelector('#notice').textContent.includes('密钥已更换')");
    await assert.rejects(peerSync.sync(), /解密/);
    peerSync.unlock(preparedCode);
    peer.addUser("换钥后另一端的离线消息");
    await peerSync.sync();
    await evaluate("document.querySelector('#sync-run').click()");
    await until("!document.querySelector('#sync-run').disabled && document.querySelector('#messages').textContent.includes('换钥后另一端')");
    // Remove this verification-only message before the existing backup/edit checks.
    store.deleteMessage(store.state.messages.find((m) => m.content === "换钥后另一端的离线消息").id);
    await evaluate("document.querySelector('#rotation-prepare').click()");
    await until("!document.querySelector('#rotation-plan').hidden && !document.querySelector('#rotation-download').disabled");
    const pendingCode = await evaluate("document.querySelector('#rotation-code').value");
    await evaluate("document.querySelector('#rotation-download').click(); document.querySelector('#rotation-saved').click()");
    const browserSync = app.connections.services.sync;
    const originalSyncWrite = browserSync.connection.write.bind(browserSync.connection);
    browserSync.connection.write = async (...args) => {
      await originalSyncWrite(...args);
      throw new Error("isolated lost rotation response");
    };
    await evaluate("document.querySelector('#rotation-activate').click()");
    await until("!document.querySelector('#rotation-recovery').hidden && document.querySelector('#notice').textContent.includes('尚未确认')");
    assert.equal(await evaluate("document.querySelector('#sync-run').disabled"), true);
    const recoveryCallCount = dav.calls.length;
    await evaluate(`document.querySelector('#rotation-recovery-code').value = ${JSON.stringify(pendingCode)}; document.querySelector('#rotation-recovery-code').dispatchEvent(new Event('input')); document.querySelector('#rotation-recover').click()`);
    await until("document.querySelector('#rotation-recovery').hidden && document.querySelector('#notice').textContent.includes('只读核对完成')");
    assert.ok(dav.calls.slice(recoveryCallCount).every((entry) => entry.method === "GET"), "rotation recovery must not upload");
    browserSync.connection.write = originalSyncWrite;
    peerSync.unlock(pendingCode);
    await evaluate("document.querySelector('#rotation-status').scrollIntoView({block:'center'})");
    await screenshot("companion-sync-key-change.png");
    await evaluate("document.querySelector('[data-tab=\"identity\"]').click(); document.querySelector('#identity-name').value = 'Niria'; document.querySelector('#identity-form').requestSubmit()");
    await until("!document.querySelector('#settings-dialog').open && document.querySelector('#companion-name').textContent === 'Niria'");
    await evaluate("document.querySelector('[data-view=\"chat\"]').click(); [...document.querySelectorAll('.message.user button')].find(b => b.textContent === '编辑').click()");
    await until("document.querySelector('#edit-dialog').open");
    await evaluate("document.querySelector('#edit-content').value = '其实我更喜欢红茶'; document.querySelector('#edit-form').requestSubmit()");
    await until("!document.querySelector('#edit-dialog').open && document.querySelectorAll('.message.assistant').length === 0");
    assert.equal(store.state.memories[0].invalidated, true);
    await evaluate("document.querySelector('#preview-context').click()");
    await until("document.querySelector('#context-dialog').open");
    assert.equal(await evaluate("document.querySelector('#context-content').textContent.includes('乌龙茶')"), false);
    await evaluate("document.querySelector('[data-close=\"context-dialog\"]').click(); document.querySelector('#open-settings').click(); document.querySelector('[data-tab=\"backup\"]').click(); document.querySelector('#backup-password').value = 'browser-backup-password'; document.querySelector('#export-backup').click()");
    let serialized;
    const filename = `niria-${new Date().toISOString().slice(0, 10)}.niria`;
    for (let i = 0; i < 60; i++) {
      try { serialized = await readFile(path.join(downloads, filename), "utf8"); break; } catch { await delay(100); }
    }
    assert.ok(serialized, "encrypted backup should download");
    assert.equal(serialized.includes("红茶"), false);
    assert.equal(serialized.includes("fake-browser-test-key"), false);
    await evaluate("document.querySelector('[data-tab=\"identity\"]').click(); document.querySelector('#identity-name').value = '临时修改'; document.querySelector('#identity-form').requestSubmit()");
    await until("!document.querySelector('#settings-dialog').open && document.querySelector('#companion-name').textContent === '临时修改'");
    await evaluate(`(() => {
      document.querySelector('#open-settings').click();
      document.querySelector('[data-tab="backup"]').click();
      document.querySelector('#backup-password').value = 'browser-backup-password';
      window.confirm = () => true;
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(serialized)}], 'test.niria', { type: 'application/json' }));
      const input = document.querySelector('#restore-backup');
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until("!document.querySelector('#settings-dialog').open && document.querySelector('#companion-name').textContent === 'Niria'");
    await call("Page.reload");
    await until("document.querySelectorAll('.message.user').length === 1 && document.querySelector('#connection-status').textContent.includes('已连接')");
    assert.match(await evaluate("document.querySelector('.message.user .message-body').textContent"), /红茶/);
    const oldMemoryId = store.addMemory({ content: "用户的猫栗子生日在三月十四日。" });
    store.state.memories.find((m) => m.id === oldMemoryId).updatedAt = "2020-01-01T00:00:00Z";
    for (let i = 0; i < 35; i++) store.addMemory({ content: `用户去过第 ${i} 号公园。` });
    await evaluate("document.querySelector('#message-input').value = '栗子的生日是哪一天？'; document.querySelector('#preview-context').click()");
    await until("document.querySelector('#context-dialog').open && document.querySelector('#context-content').textContent.includes('三月十四日')");
    assert.match(await evaluate("document.querySelector('#context-content').textContent"), /话题相关/);
    assert.equal(providerCalls, 2, "local retrieval must not add model calls");
    await evaluate("document.querySelector('[data-close=\"context-dialog\"]').click(); document.querySelector('#open-settings').click()");
    assert.equal(await evaluate("document.querySelector('#chat-remember').disabled"), true, "browser preview must not offer plaintext credential storage");
    await evaluate("document.querySelector('[data-close=\"settings-dialog\"]').click()");
    await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await screenshot("companion-narrow.png");
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(() => {
      window.__originalFetch = window.fetch;
      window.__avatarUploads = [];
      window.__avatarCompleted = 0;
      window.fetch = async (input, options) => {
        if (input === '/api/avatar') {
          window.__avatarUploads.push(JSON.parse(options.body));
          if (window.__avatarUploads.length === 1) await new Promise(resolve => { window.__releaseAvatar = resolve; });
        }
        const response = await window.__originalFetch(input, options);
        if (input === '/api/avatar') window.__avatarCompleted++;
        return response;
      };
      window.__selectPicture = color => {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 480;
        const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(30, 30, 260, 420);
        return new Promise(resolve => canvas.toBlob(blob => {
          const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'local-avatar.png', { type: 'image/png' }));
          const input = document.querySelector('#avatar-image'); input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true })); resolve(true);
        }, 'image/png'));
      };
    })()`);
    await evaluate("window.__selectPicture('#25446f')");
    await until("window.__avatarUploads.length === 1");
    await evaluate("window.__selectPicture('#2e9b78')");
    await delay(300);
    await evaluate("window.__releaseAvatar()");
    await until("window.__avatarCompleted === 2 && !document.querySelector('#avatar-canvas').hidden && document.querySelector('#avatar-canvas').getContext('2d').getImageData(512, 700, 1, 1).data[1] > 140");
    assert.equal(store.state.avatar.source, await evaluate("window.__avatarUploads[1].avatar.original"), "an older delayed save must not overwrite the newer import");
    await evaluate("window.fetch = window.__originalFetch; delete window.__originalFetch; delete window.__selectPicture; delete window.__releaseAvatar; delete window.__avatarUploads; delete window.__avatarCompleted");
    const fixture = await evaluate(`(() => {
      const frame = (color, left = 5) => {
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 96;
        const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(left, 5, 59 - left, 86);
        return canvas.toDataURL('image/png');
      };
      return { format: 'niria-avatar-prototype', version: 1, source: frame('#25446f'),
        actions: { blink: frame('#101010'), smile: frame('#d0667b', 15), curious: frame('#2e9b78'), shy: frame('#a47bcd', 15) } };
    })()`);
    store.settings({ autoMemory: false });
    store.mutate((data) => { data.avatar = fixture; });
    await until("!document.querySelector('#avatar-canvas').hidden && document.documentElement.dataset.liveUpdates === 'connected'");
    expressionReply = "听到这个消息我也很开心。\n[NIRIA_EXPRESSION:smile]";
    await evaluate("document.querySelector('#message-input').value = '今天完成了一个小目标'; document.querySelector('#composer').requestSubmit()");
    await until("document.querySelector('#avatar-canvas').dataset.expression === 'smile' && !document.querySelector('#send-message').disabled");
    await until("document.querySelector('#avatar-canvas').getContext('2d').getImageData(512, 700, 1, 1).data[0] > 180");
    await until("document.querySelector('#avatar-canvas').getContext('2d').getImageData(160, 700, 1, 1).data[3] === 0");
    assert.equal(providerCalls, 3, "expressions share the chat call and do not request another model");
    assert.equal(await evaluate("document.querySelector('#messages').textContent.includes('NIRIA_EXPRESSION')"), false);
    await screenshot("companion-expression.png");
    const widget = await cdp.call("Target.createTarget", { url: "about:blank" });
    const widgetSession = await cdp.call("Target.attachToTarget", { targetId: widget.targetId, flatten: true });
    const widgetCall = (method, params) => cdp.call(method, params, widgetSession.sessionId);
    const widgetEvaluate = async (expression) => {
      const result = await widgetCall("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const widgetUntil = async (expression) => {
      for (let i = 0; i < 100; i++) { if (await widgetEvaluate(expression)) return; await delay(100); }
      throw new Error(`小窗条件未满足：${expression}`);
    };
    await widgetCall("Runtime.enable");
    await widgetCall("Page.enable");
    await widgetCall("Page.navigate", { url: `${appUrl}/widget` });
    await widgetCall("Page.bringToFront");
    await widgetUntil("!document.querySelector('#widget-canvas')?.hidden && document.documentElement.dataset.liveUpdates === 'connected'");
    expressionReply = "记得给自己留一点休息时间。\n[NIRIA_EXPRESSION:shy]";
    store.settings({ care: { enabled: true, intervalMinutes: 30, quietStart: 0, quietEnd: 0 } });
    companion.lastInteraction = Date.now() - 31 * 60_000;
    assert.equal(await companion.tick(), true);
    store.settings({ care: { enabled: false } });
    await widgetUntil("document.querySelector('#widget-canvas').dataset.expression === 'shy' && document.querySelector('#widget-last').textContent.includes('休息时间')");
    await widgetUntil("document.querySelector('#widget-canvas').getContext('2d').getImageData(512, 700, 1, 1).data[2] > 180");
    await widgetUntil("document.querySelector('#widget-canvas').getContext('2d').getImageData(160, 700, 1, 1).data[3] === 0");
    assert.equal(providerCalls, 4, "care also carries its own expression without a classification call");
    await widgetCall("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await widgetEvaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const still = await widgetEvaluate("document.querySelector('#widget-canvas').toDataURL()");
    await delay(300);
    assert.equal(await widgetEvaluate("document.querySelector('#widget-canvas').toDataURL()") === still, true, "reduced motion must keep the current expression still");
    await widgetUntil("document.querySelector('#widget-canvas').dataset.expression === 'neutral'");
    assert.equal(await widgetEvaluate("document.querySelector('#widget-canvas').getContext('2d').getImageData(512, 700, 1, 1).data[2]"), 111);
    store.mutate((data) => { data.avatar = { ...data.avatar, actions: { ...data.avatar.actions, smile: fixture.actions.curious } }; });
    await widgetUntil("document.querySelector('#widget-canvas').dataset.expression === 'neutral' && !document.querySelector('#widget-canvas').hidden");
    const latest = store.state.messages.at(-1);
    store.deleteMessage(latest.id);
    await widgetUntil("!document.querySelector('#widget-last').textContent.includes('休息时间')");
    assert.equal(await widgetEvaluate("document.querySelector('#widget-canvas').dataset.expression"), "neutral");
    await widgetCall("Page.reload");
    await widgetUntil("!document.querySelector('#widget-canvas')?.hidden && document.querySelector('#widget-canvas').dataset.expression === 'neutral'");
    expressionReply = "换个方式说，我也为你开心。\n[NIRIA_EXPRESSION:smile]";
    const userCount = store.state.messages.filter((m) => m.role === "user" && !m.deleted).length;
    await companion.send({ retryId: store.state.messages.findLast((m) => m.role === "user" && !m.deleted).id });
    await widgetUntil("document.querySelector('#widget-canvas').dataset.expression === 'smile' && document.querySelector('#widget-last').textContent.includes('换个方式')");
    await widgetUntil("document.querySelector('#widget-canvas').getContext('2d').getImageData(512, 700, 1, 1).data[1] > 140");
    assert.equal(providerCalls, 5);
    assert.equal(store.state.messages.filter((m) => m.role === "user" && !m.deleted).length, userCount);
    await cdp.call("Target.closeTarget", { targetId: widget.targetId });
    await call("Page.bringToFront");
    await until("document.querySelector('#avatar-canvas').dataset.expression === 'smile'");
    const savedAvatar = structuredClone(store.state.avatar);
    await call("Page.navigate", { url: `${appUrl}/avatar` });
    await until("document.querySelector('#source-caption')?.textContent.includes('已载入') && document.querySelector('#asset-count').textContent === '4 / 4'");
    assert.equal(providerCalls, 5, "opening the avatar editor must restore local assets without calling a model");
    await evaluate("document.querySelector('#save-companion').click()");
    await until("document.querySelector('#notice').textContent.includes('已保存到伴侣')");
    assert.deepEqual(store.state.avatar, savedAvatar, "opening and saving must preserve already accepted image bytes");
    imageReply = null;
    const backgroundChecks = await verifyBackgroundEditor({ evaluate, save: true, generateBase: `${mockUrl}/v1` });
    const backgroundFailures = await verifyBackgroundFailures(evaluate);
    assert.equal(providerCalls, 6, "background processing and restore are local; explicitly confirmed generation adds one request");
    assert.deepEqual(cdp.errors, []);
    console.log(JSON.stringify({ passed: true, browser: path.basename(executable), mockRequests: providerCalls, contextSyntheticCalls: 4, regenerationSyntheticCalls: 3, careSyntheticCalls: 4,
      renderChecks, memoryBrowseChecks, contextChecks, regenerationChecks, careChecks, live2dChecks, backgroundChecks, backgroundFailures,
      memoryChecks: ["editable memory type and lifetime", "metadata edits retain sources and confirmation", "exact unchanged UTC deadline", "invalid dates rejected", "stale edits rejected", "manual correction retains readable associations", "superseded sources and derivatives excluded from context", "forgetting after correction includes former sources", "paginated forget impact list", "review cancellation without writes", "changed review disables commit and clears old text", "late closed review discarded", "derived memory erasure without model calls"],
      speechRequests: speechCalls,
      securityChecks: ["rotation preparation makes no WebDAV request", "prepared code survives page reload",
        "downloaded recovery file contains both codes", "explicit saved-file confirmation",
        "old peer key rejected and new code continues the same companion", "interrupted rotation pauses uploads",
        "rotation recovery uses GET only"],
      checks: ["compact state reads", "history paging in both directions", "local literal history search and safe text rendering", "late search results discarded", "open history refreshes after edit and deletion", "old memory sources fetched on demand", "history on narrow viewport", "configuration without paid request", "chat and automatic memory", "duplicate submit", "confirm memory", "independent speech and audio playback", "sync pairing and encrypted upload", "peer recovery", "conflict selection and convergence", "edit invalidates sources", "send range", "encrypted backup export", "restore identity and messages", "reload persistence", "old relevant memory retrieval without model calls", "browser disables persistent secrets", "narrow viewport", "same-call chat expressions and canvas pixels", "live widget care without page interaction", "reduced motion and expression expiry", "delete and reload do not replay old expressions", "retry uses updated action assets without adding a user message", "avatar editor restores and preserves accepted assets without a model call"] }, null, 2));
  } else {
  await until("document.readyState === 'complete' && !!document.querySelector('#source-image')");
  assert.equal(await evaluate("document.title"), "NIRIA 形象实验台");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await screenshot("prototype-desktop.png");
  await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 60;
    return new Promise(resolve => canvas.toBlob(blob => {
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'empty.png', { type: 'image/png' }));
      const input = document.querySelector('#source-image'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true })); resolve(true);
    }, 'image/png'));
  })()`);
  await until("document.querySelector('#notice').textContent.includes('几乎完全透明')");
  assert.equal(await evaluate("document.querySelector('#empty-stage').hidden"), false);
  assert.equal(providerCalls, 0);

  await evaluate(`(() => {
    const image = document.createElement('canvas');
    image.width = 400; image.height = 600;
    const context = image.getContext('2d');
    context.fillStyle = '#cbd5ec';
    context.fillRect(0, 0, 400, 600);
    context.fillStyle = '#7484b1';
    context.fillRect(125, 275, 150, 230);
    context.fillStyle = '#f0d9c9';
    context.beginPath(); context.arc(200, 210, 65, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#27384f';
    context.fillRect(174, 201, 9, 9); context.fillRect(217, 201, 9, 9);
    context.font = '18px sans-serif';
    context.fillText('Browser test fixture', 115, 560);
    return new Promise(resolve => image.toBlob(blob => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'test-reference.png', { type: 'image/png' }));
      const input = document.querySelector('#source-image');
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      resolve(true);
    }, 'image/png'));
  })()`);
  await until("document.querySelector('#empty-stage').hidden && !document.querySelector('#play-button').disabled");
  assert.equal(await evaluate("document.querySelector('#asset-count').textContent"), "0 / 4");
  await evaluate("document.querySelector('[data-generate=\"blink\"]').click()");
  assert.equal(await evaluate("document.querySelector('#settings-dialog').open"), true);
  await evaluate(`(() => {
    document.querySelector('#base-url').value = ${JSON.stringify(`${mockUrl}/v1`)};
    document.querySelector('#model').value = 'browser-test-model';
    document.querySelector('#api-key').value = 'fake-browser-test-key';
    document.querySelector('#settings-form').requestSubmit();
  })()`);
  await until("document.querySelector('#confirm-dialog').open");
  assert.equal(providerCalls, 0, "must not call service before explicit confirmation");
  await evaluate("document.querySelector('#confirm-generate').click(); document.querySelector('#confirm-generate').click()");
  await until("document.querySelector('#review-dialog').open && document.querySelector('#generated-preview').complete && !document.querySelector('#accept-result').disabled");
  assert.equal(providerCalls, 1);
  await evaluate("document.querySelector('#accept-result').click()");
  assert.equal(await evaluate("document.querySelector('#asset-count').textContent"), "1 / 4");
  assert.equal(await evaluate("document.querySelector('[data-action=\"blink\"] .asset-status').textContent"), "已采用");
  assert.match(await evaluate("document.querySelector('#request-log').textContent"), /已采用/);
  await screenshot("prototype-fixture.png");

  await evaluate("document.querySelector('#export-button').click()");
  let serialized;
  for (let i = 0; i < 60; i++) {
    try { serialized = await readFile(path.join(downloads, "niria-avatar.json"), "utf8"); break; } catch { await delay(100); }
  }
  assert.ok(serialized, "asset package should download");
  const bundle = JSON.parse(serialized);
  assert.equal(bundle.format, "niria-avatar-prototype");
  assert.ok(bundle.actions.blink);
  assert.equal(serialized.includes("fake-browser-test-key"), false);
  await evaluate(`(() => {
    window.confirm = () => true;
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(serialized)}], 'test-avatar.json', { type: 'application/json' }));
    const input = document.querySelector('#import-package');
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until("document.querySelector('#source-caption').textContent.includes('恢复')");
  assert.equal(await evaluate("document.querySelector('#asset-count').textContent"), "1 / 4");
  imageReply = await evaluate(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(bundle.original)}; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1536;
    const context = canvas.getContext('2d'); context.translate(512 + 28, 768 - 42); context.scale(1.03, 1.03); context.translate(-512, -768);
    context.drawImage(img, 0, 0); return canvas.toDataURL('image/png');
  })()`);
  await evaluate("document.querySelector('[data-generate=\"smile\"]').click()");
  await until("document.querySelector('#confirm-dialog').open");
  assert.equal(providerCalls, 1);
  await evaluate("document.querySelector('#confirm-generate').click()");
  await until("document.querySelector('#review-dialog').open && !document.querySelector('#accept-result').disabled");
  assert.equal(providerCalls, 2);
  assert.equal(await evaluate("document.querySelector('#align-result').checked && !document.querySelector('#align-result').disabled"), true, "shifted fixture must offer local position correction");
  const alignedData = await evaluate("document.querySelector('#generated-preview').src");
  await evaluate("document.querySelector('#align-result').click(); document.querySelector('#overlay-result').click()");
  assert.notEqual(await evaluate("document.querySelector('#generated-preview').src"), alignedData);
  assert.equal(providerCalls, 2, "local alignment and overlay must not call a provider");
  await evaluate("document.querySelector('#align-result').click()");
  await screenshot("prototype-alignment.png");
  await evaluate("document.querySelector('#accept-result').click(); document.querySelector('#export-button').click()");
  let corrected;
  for (let i = 0; i < 60; i++) {
    for (const name of await readdir(downloads)) if (name.endsWith(".json")) {
      try { const data = JSON.parse(await readFile(path.join(downloads, name), "utf8")); if (data.actions?.smile) corrected = data; } catch { /* still downloading */ }
    }
    if (corrected) break;
    await delay(100);
  }
  assert.ok(corrected);
  assert.equal(corrected.actions.smile, alignedData, "accept stores the chosen frame, never the comparison overlay");
  assert.equal(corrected.actions.blink, bundle.actions.blink);
  assert.equal(corrected.original, bundle.original);
  const aspect = await evaluate(`(async () => {
    const { normalized, imageFrom } = await import('/image-tools.js');
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40;
    canvas.getContext('2d').fillRect(0, 0, 80, 40);
    const image = await imageFrom(canvas.toDataURL('image/png'));
    const prepared = await imageFrom(normalized(image));
    const result = document.createElement('canvas'); result.width = 1024; result.height = 1536;
    const context = result.getContext('2d'); context.drawImage(prepared, 0, 0);
    return { top: context.getImageData(512, 100, 1, 1).data[3], middle: context.getImageData(512, 768, 1, 1).data[3] };
  })()`);
  assert.deepEqual(aspect, { top: 0, middle: 255 }, "wide images keep their proportions with transparent margins");
  await evaluate("document.querySelector('[data-generate=\"curious\"]').click()");
  await until("document.querySelector('#confirm-dialog').open");
  await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 48;
    return new Promise(resolve => canvas.toBlob(blob => {
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'bad-replacement.png', { type: 'image/png' }));
      const input = document.querySelector('#replace-image'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true })); resolve(true);
    }, 'image/png'));
  })()`);
  await until("document.querySelector('#notice').textContent.includes('几乎完全透明')");
  assert.equal(await evaluate("document.querySelector('#asset-count').textContent"), "2 / 4", "bad replacement preserves adopted frames");
  await evaluate(`(() => {
    const raw = atob(${JSON.stringify(bundle.original)}.split(',')[1]);
    const blob = new Blob([Uint8Array.from(raw, value => value.charCodeAt(0))], { type: 'image/png' });
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'replacement.png', { type: 'image/png' }));
    const input = document.querySelector('#replace-image'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until("document.querySelector('#source-caption').textContent.includes('replacement.png') && !document.querySelector('#confirm-dialog').open");
  await evaluate("document.querySelector('#confirm-generate').click()");
  assert.equal(providerCalls, 2, "replacing the reference invalidates an old generation confirmation");

  await evaluate(`(() => {
    const frame = (x, color) => {
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1536;
      const context = canvas.getContext('2d'); context.scale(1024 / 96, 1536 / 144);
      context.fillStyle = color; context.fillRect(x, 30, 45, 80);
      return canvas.toDataURL('image/png');
    };
    const bundle = { format: 'niria-avatar-prototype', version: 1, width: 1024, height: 1536, original: frame(10, '#e02020'),
      actions: { blink: frame(35, '#2040e0') } };
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(bundle)], 'isolated-transparent-frames.json', { type: 'application/json' }));
    const input = document.querySelector('#import-package'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until("document.querySelector('#source-caption').textContent.includes('恢复') && document.querySelector('#asset-count').textContent === '1 / 4'");
  await evaluate("document.querySelector('#breathing').checked = false; document.querySelector('#breathing').dispatchEvent(new Event('change')); document.querySelector('#blinking').checked = true; document.querySelector('#blinking').dispatchEvent(new Event('change'))");
  const previewBlink = await evaluate(`new Promise(resolve => {
    const context = document.querySelector('#portrait').getContext('2d');
    const deadline = performance.now() + 8000; let closed = false;
    const observe = () => {
      const oldAlpha = context.getImageData(213, 693, 1, 1).data[3], newAlpha = context.getImageData(747, 693, 1, 1).data[3];
      if (oldAlpha === 0 && newAlpha === 255) closed = true;
      if (closed && oldAlpha === 255 && newAlpha === 0) return resolve(true);
      if (performance.now() >= deadline) return resolve(false);
      requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  })`);
  assert.equal(previewBlink, true, "the actual avatar editor blink must replace the original silhouette and return");
  assert.equal(providerCalls, 2, "local playback makes no provider requests");
  await evaluate(`(() => {
    const context = document.querySelector('#portrait').getContext('2d'), clear = context.clearRect.bind(context);
    window.__previewDraws = 0;
    context.clearRect = (...args) => { window.__previewDraws++; return clear(...args); };
    window.__restorePreviewCounter = () => { delete context.clearRect; delete window.__previewDraws; delete window.__restorePreviewCounter; };
  })()`);
  const backgroundTarget = await cdp.call("Target.createTarget", { url: "about:blank" });
  await cdp.call("Target.activateTarget", { targetId: backgroundTarget.targetId });
  await until("document.hidden");
  await delay(100);
  const hiddenDraws = await evaluate("window.__previewDraws");
  await delay(300);
  assert.equal(await evaluate("window.__previewDraws"), hiddenDraws, "the hidden editor must stop drawing animation frames");
  await cdp.call("Target.closeTarget", { targetId: backgroundTarget.targetId });
  await call("Page.bringToFront");
  await until(`!document.hidden && window.__previewDraws > ${hiddenDraws}`);
  await evaluate("window.__restorePreviewCounter()");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await screenshot("prototype-narrow.png");
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
  imageReply = null;
  const backgroundChecks = await verifyBackgroundEditor({ evaluate, generateBase: `${mockUrl}/v1`, capture: async () => {
    assert.equal(await evaluate("document.querySelector('#background-dialog').scrollWidth <= document.querySelector('#background-dialog').clientWidth"), true);
    await screenshot("prototype-background-mobile.png");
  } });
  assert.equal(providerCalls, 3, "local background preview does not call a model; the explicit test generation calls once");
  const backgroundFailures = await verifyBackgroundFailures(evaluate);
  assert.deepEqual(cdp.errors, []);
  console.log(JSON.stringify({
    passed: true,
    browser: path.basename(executable),
    mockRequests: providerCalls,
    renderChecks,
    backgroundChecks,
    backgroundFailures,
    checks: ["empty image rejected locally", "single image import", "explicit cost confirmation", "duplicate click", "manual acceptance", "export without key", "package import", "local worker alignment and toggle", "overlay never saved as an action", "accepted actions preserved", "aspect ratio retained", "bad replacement preserves adopted frames", "reference change invalidates generation confirmation", "actual preview blink clears old silhouette and returns without model calls", "hidden editor pauses drawing and resumes when visible", "narrow viewport", "reduced motion"],
    screenshots: ["artifacts/prototype-desktop.png", "artifacts/prototype-fixture.png", "artifacts/prototype-narrow.png"]
  }, null, 2));
  }
  }
} finally {
  if (cdp) {
    try { await cdp.call("Browser.close"); } catch { /* browser may close before responding */ }
    cdp.close();
  }
  if (child && child.exitCode === null) child.kill();
  await Promise.all([closeServer(app), closeServer(mock)]);
  store?.close();
  peer?.close();
  await dav?.close();
}
