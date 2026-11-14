import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, session, dialog, safeStorage, powerMonitor } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { writeFile, readFile } from "node:fs/promises";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { SpeechService } from "../core/speech-service.mjs";
import { CredentialVault } from "../core/credential-vault.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { DesktopPreferences } from "./window-state.mjs";
import { WindowLayout } from "./window-layout.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes("--smoke");
if (smoke) app.disableHardwareAcceleration();
let mainWindow, widget, widgetLoading, tray, server, store, companion, synchronization, speech, vault, timer, origin, layout, closing = false;
const smokeErrors = [];
if (process.env.NIRIA_DESKTOP_DATA_DIR) app.setPath("userData", process.env.NIRIA_DESKTOP_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => layout?.showMain());
  app.whenReady().then(start).catch(async (error) => {
    if (smoke) {
      await writeFile(process.env.NIRIA_SMOKE_RESULT, JSON.stringify({ ok: false, error: error.stack || String(error) }));
    } else await dialog.showMessageBox({ type: "error", title: "NIRIA 启动未完成", message: "无法打开本机资料或窗口。", detail: error.message });
    app.quit();
  });
}
function windowOptions(extra = {}) {
  return {
    backgroundColor: "#f6f5f2", show: false,
    webPreferences: {
      preload: join(root, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false
    },
    ...extra
  };
}
function protect(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, value) => { if (new URL(value).origin !== origin) event.preventDefault(); });
  window.webContents.on("render-process-gone", (_, details) => { smokeErrors.push(`renderer: ${details.reason}`); });
  window.webContents.on("console-message", (_, details) => {
    if (details.level === "error") smokeErrors.push(details.message);
  });
}
async function showWidget({ find = false, reveal = !smoke } = {}) {
  layout.shownWidget();
  if (!widgetLoading && (!widget || widget.isDestroyed())) {
    widgetLoading = (async () => {
      const placement = layout.widgetOptions();
      const window = new BrowserWindow(windowOptions({
        ...placement, transparent: true, backgroundColor: "#00000000", frame: false,
        skipTaskbar: true, resizable: false, hasShadow: false
      }));
      // Reapply outer bounds after native frame/minimum-size setup at fractional DPI.
      window.setBounds({ x: placement.x, y: placement.y, width: placement.width, height: placement.height });
      widget = window;
      layout.attachWidget(window);
      protect(window);
      window.once("closed", () => { if (widget === window) widget = null; });
      await window.loadURL(`${origin}/widget`);
    })().finally(() => { widgetLoading = null; });
  }
  await widgetLoading;
  if (closing || !layout.state().visible || !widget || widget.isDestroyed()) return;
  if (find) layout.findWidget();
  if (reveal) widget.showInactive();
  desktopChanged();
}
function desktopChanged() {
  for (const window of [mainWindow, widget]) {
    if (window && !window.isDestroyed()) window.webContents.send("niria:desktop-state", layout.state());
  }
  if (!tray || closing) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开聊天", click: () => layout.showMain() },
    { label: "显示伴侣", click: () => showWidget().catch(() => {}) },
    { label: "隐藏伴侣", click: () => layout.hideWidget() },
    { label: "找回伴侣小窗", click: () => showWidget({ find: true }).catch(() => {}) },
    { label: "伴侣始终置顶", type: "checkbox", checked: layout.state().alwaysOnTop, click: () => layout.toggleTopmost() },
    { type: "separator" }, { label: "退出 NIRIA", click: () => app.quit() }
  ]));
}
function registerIPC() {
  const handlers = {
    "niria:show-main": () => layout.showMain(),
    "niria:show-widget": () => showWidget(),
    "niria:hide-widget": () => layout.hideWidget(),
    "niria:collapse-widget": () => layout.collapseWidget(),
    "niria:desktop-state": () => layout.state(),
    "niria:toggle-topmost": () => layout.toggleTopmost()
  };
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.handle(channel, (event) => {
    if (![mainWindow?.webContents, widget?.webContents].includes(event.sender) ||
        new URL(event.senderFrame.url).origin !== origin) throw new Error("Unsupported IPC sender");
    return fn();
  });
}
function trayIcon() {
  const size = 32, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inside = (x - 16) ** 2 + (y - 16) ** 2 < 14 ** 2;
    const cutout = (x - 21) ** 2 + (y - 12) ** 2 < 12 ** 2;
    if (inside && !cutout) {
      const i = (y * size + x) * 4;
      pixels[i] = 159; pixels[i + 1] = 116; pixels[i + 2] = 123; pixels[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size }).resize({ width: 20, height: 20 });
}
async function start() {
  layout = new WindowLayout(new DesktopPreferences(join(app.getPath("userData"), "desktop.json")), screen, desktopChanged, powerMonitor);
  store = new CompanionStore(join(app.getPath("userData"), "companion.sqlite"));
  vault = new CredentialVault(join(app.getPath("userData"), "credentials.sqlite"), {
    available: () => process.platform === "win32" ? safeStorage.isAsyncEncryptionAvailable() : Promise.resolve(false),
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result
  });
  await vault.initialize();
  companion = new CompanionService(store);
  speech = new SpeechService(store);
  synchronization = new SyncService(store, { beforeApply: () => { companion.cancel(); speech.cancel(); } });
  server = createPrototypeServer({ store, companion, sync: synchronization, speech, vault });
  await server.connections.restore();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  // No renderer gets file, shell, arbitrary URL or Node access.
  session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const placement = layout.mainOptions();
  mainWindow = new BrowserWindow(windowOptions({ ...placement, title: "NIRIA" }));
  mainWindow.setBounds({ x: placement.x, y: placement.y, width: placement.width, height: placement.height });
  layout.attachMain(mainWindow);
  mainWindow.setMenuBarVisibility(false);
  protect(mainWindow);
  registerIPC();
  mainWindow.on("closed", () => { mainWindow = null; app.quit(); });
  await mainWindow.loadURL(origin);
  if (!smoke) mainWindow.show();
  if (layout.state().visible) await showWidget();
  tray = new Tray(trayIcon());
  tray.setToolTip("NIRIA · 陪你聊聊");
  desktopChanged();
  tray.on("double-click", () => layout.showMain());
  timer = setInterval(() => {
    if (server.connections.changing) return;
    companion.tick().catch(() => {});
    synchronization.tick().catch(() => {});
  }, 60_000);
  timer.unref();
  if (smoke) {
    const phase = process.env.NIRIA_SMOKE_PHASE || "windows";
    if (phase.startsWith("live2d-real-")) {
      const { readRealLive2D, verifyRealLive2D } = await import("./live2d-real-smoke.mjs");
      await showWidget();
      const evaluate = (code) => mainWindow.webContents.executeJavaScript(code);
      const widgetEvaluate = (code) => widget.webContents.executeJavaScript(code);
      let checks;
      if (phase === "live2d-real-write") {
        mainWindow.webContents.debugger.attach("1.3");
        checks = await verifyRealLive2D({ store, evaluate, widgetEvaluate,
          davBaseUrl: process.env.NIRIA_SMOKE_DAV,
          bundle: await readRealLive2D(process.env.NIRIA_LIVE2D_MODEL_DIR), retainAvatar: true,
          capture: async () => { const image = await mainWindow.capturePage(); await writeFile(process.env.NIRIA_SMOKE_SCREENSHOT, image.toPNG()); },
          setReduced: (reduce) => mainWindow.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }]
          })
        });
        mainWindow.webContents.debugger.detach();
        await writeFile(join(app.getPath("userData"), "expected-live2d.json"), JSON.stringify({ identity: store.state.identity.id, avatarKey: store.avatarKey }));
      } else {
        const expected = JSON.parse(await readFile(join(app.getPath("userData"), "expected-live2d.json"), "utf8"));
        for (let index = 0; index < 600; index++) {
          if (await evaluate("!document.querySelector('#avatar-canvas').hidden") &&
              await widgetEvaluate("!document.querySelector('#widget-canvas').hidden")) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const visible = (selector) => `(() => {
          const canvas=document.querySelector('${selector}'),data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
          return !canvas.hidden && !canvas.dataset.live2dError && data.some((v,i)=>i%4===3&&v>0);
        })()`;
        checks = {
          realSQLiteRestartKeepsSameCompanion: expected.identity === store.state.identity.id,
          realSQLiteRestartKeepsSameModel: expected.avatarKey === store.avatarKey,
          realRestartMainWindowDrawsModel: await evaluate(visible("#avatar-canvas")),
          realRestartWidgetDrawsModel: await widgetEvaluate(visible("#widget-canvas")),
          realRestartMakesNoServiceCalls: store.state.calls.length === 0
        };
      }
      await writeFile(process.env.NIRIA_SMOKE_RESULT, JSON.stringify({
        ok: Object.values(checks).every(Boolean) && !smokeErrors.length, phase, ...checks, errors: smokeErrors
      }, null, 2));
      app.quit();
      return;
    }
    if (phase.startsWith("storage-")) {
      const { verifyStorageUpgrade } = await import("./storage-smoke.mjs");
      const result = await verifyStorageUpgrade({ phase, store, sync: synchronization, mainWindow, dataDirectory: app.getPath("userData") });
      await writeFile(process.env.NIRIA_SMOKE_RESULT, JSON.stringify({ ...result, errors: smokeErrors, ok: result.ok && !smokeErrors.length }, null, 2));
      app.quit();
      return;
    }
    if (phase.startsWith("rotation-")) {
      const { verifySyncKeys } = await import("./sync-smoke.mjs");
      const result = await verifySyncKeys({ phase, server, sync: synchronization, store, vault,
        dataDirectory: app.getPath("userData"), baseUrl: process.env.NIRIA_SMOKE_DAV });
      await writeFile(process.env.NIRIA_SMOKE_RESULT, JSON.stringify({ ...result, errors: smokeErrors, ok: result.ok && !smokeErrors.length }, null, 2));
      app.quit();
      return;
    }
    if (phase.startsWith("layout-")) {
      const { verifyLayout } = await import("./window-smoke.mjs");
      const result = await verifyLayout({ phase, layout, mainWindow, widget, showWidget, store, app });
      await writeFile(process.env.NIRIA_SMOKE_RESULT, JSON.stringify({ ...result, errors: smokeErrors, ok: result.ok && !smokeErrors.length }, null, 2));
      app.quit();
      return;
    }
    if (phase.startsWith("credential-")) {
      if (phase.startsWith("credential-corrupt")) {
        const { verifyCredentialFallback } = await import("./credential-safety-smoke.mjs");
        const checks = await verifyCredentialFallback((code) => mainWindow.webContents.executeJavaScript(code));
        await writeFile(process.env.NIRIA_SMOKE_RESULT, JSON.stringify({
          ok: Object.values(checks).every(Boolean) && !smokeErrors.length, phase, ...checks,
          protectedStorage: vault.available, errors: smokeErrors
        }, null, 2));
        app.quit();
        return;
      }
      const key = "niria-isolated-vault-test-key";
      const codeIsSecret = (bytes) => !bytes.includes(Buffer.from(key));
      let ok = false;
      if (!vault.available) throw new Error("Windows protected storage unavailable during desktop verification");
      if (phase === "credential-write") {
        const config = { baseUrl: "http://127.0.0.1:9/v1", apiKey: key, model: "isolated-test", remember: true };
        await server.connections.configure("chat", config);
        await server.connections.configure("image", config);
        await server.connections.configure("speech", { ...config, voice: "isolated-voice", auto: false, dailyLimit: 2 });
        await server.connections.configure("sync", { baseUrl: "http://127.0.0.1:9/dav/", username: "isolated-user", password: key, auto: false, remember: true });
        synchronization.createPair();
        await server.connections.rememberPair(true);
        const rows = vault.db.prepare("SELECT ciphertext FROM credentials").all();
        ok = rows.length === 5 && rows.every((row) => codeIsSecret(Buffer.from(row.ciphertext))) &&
          !JSON.stringify(store.exportData()).includes(key) && store.state.calls.length === 0;
      } else if (phase === "credential-read") {
        const status = server.connections.status();
        ok = companion.connection?.apiKey === key && speech.connection?.apiKey === key &&
          server.connections.current.get("image")?.apiKey === key && status.sync.hasSecret &&
          synchronization.status().unlocked && status.storage.saved.length === 5 && store.state.calls.length === 0;
        await server.connections.forget("all");
        ok = ok && vault.status().saved.length === 0 && !!companion.connection;
      } else if (phase === "credential-empty") {
        ok = !companion.connection && !speech.connection && !synchronization.connection &&
          !synchronization.pair && vault.status().saved.length === 0;
      }
      await writeFile(process.env.NIRIA_SMOKE_RESULT, JSON.stringify({ ok, phase, protectedStorage: vault.available, errors: smokeErrors }, null, 2));
      app.quit();
      return;
    }
    await showWidget();
    const identity = await mainWindow.webContents.executeJavaScript("document.querySelector('#companion-name')?.textContent");
    const bridge = await widget.webContents.executeJavaScript("typeof window.niriaDesktop?.showMain");
    const nodeAbsent = await mainWindow.webContents.executeJavaScript("typeof window.require === 'undefined' && typeof window.process === 'undefined'");
    await mainWindow.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
    const picture = await mainWindow.webContents.capturePage();
    await writeFile(process.env.NIRIA_SMOKE_SCREENSHOT, picture.toPNG());
    await widget.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
    const portrait = await widget.webContents.capturePage();
    await writeFile(join(dirname(process.env.NIRIA_SMOKE_SCREENSHOT), "companion-widget.png"), portrait.toPNG());
    const transparentCorner = portrait.toBitmap()[3] === 0;
    const nativeWindow = widget.getNativeWindowHandle().length > 0;
    await widget.webContents.executeJavaScript("window.niriaDesktop.collapseWidget()");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const collapsedBounds = widget.getBounds();
    const collapseWorks = Math.abs(collapsedBounds.width - 92) <= 1 && Math.abs(collapsedBounds.height - 92) <= 1;
    await widget.webContents.executeJavaScript("window.niriaDesktop.collapseWidget()");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expandWorks = widget.getBounds().width === 280 && widget.getBounds().height === 430;
    const pictureFixture = await mainWindow.webContents.executeJavaScript(`(() => {
      const frame = (color, left = 5) => {
        const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 96;
        const context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(left, 5, 59 - left, 86);
        return canvas.toDataURL("image/png");
      };
      return { format: "niria-avatar-prototype", version: 1, source: frame("#25446f"), actions: { smile: frame("#d0667b", 15) } };
    })()`);
    store.settings({ autoMemory: false });
    store.mutate((state) => { state.avatar = pictureFixture; });
    companion.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "isolated-expression" });
    companion.completion = async () => "隔离测试回复。\n[NIRIA_EXPRESSION:smile]";
    await companion.send({ content: "隔离测试消息" });
    const waitForExpression = async (name) => {
      for (let i = 0; i < 80; i++) {
        const results = await Promise.all([
          mainWindow.webContents.executeJavaScript(`document.querySelector("#avatar-canvas").dataset.expression === "${name}"`),
          widget.webContents.executeJavaScript(`document.querySelector("#widget-canvas").dataset.expression === "${name}"`)
        ]);
        if (results.every(Boolean)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };
    const expressionDisplays = await waitForExpression("smile");
    let nativeExpressionClearsSilhouette = false;
    for (let i = 0; i < 80; i++) {
      const pixels = await Promise.all([mainWindow.webContents, widget.webContents].map((contents, index) =>
        contents.executeJavaScript(`document.querySelector("${index ? "#widget-canvas" : "#avatar-canvas"}").getContext("2d").getImageData(160, 700, 1, 1).data[3]`)));
      if (pixels.every((alpha) => alpha === 0)) { nativeExpressionClearsSilhouette = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const cleanReply = await widget.webContents.executeJavaScript(`document.querySelector("#widget-last").textContent === "隔离测试回复。"`);
    const oneChatCall = store.state.calls.filter((call) => call.kind === "chat").length === 1;
    store.deleteMessage(store.state.messages.find((message) => message.role === "user").id);
    const expressionClears = await waitForExpression("neutral");
    const nativeOriginalRestored = (await Promise.all([mainWindow.webContents, widget.webContents].map((contents, index) =>
      contents.executeJavaScript(`document.querySelector("${index ? "#widget-canvas" : "#avatar-canvas"}").getContext("2d").getImageData(160, 700, 1, 1).data[3]`)))).every((alpha) => alpha === 255);
    const { verifyHistory } = await import("./history-smoke.mjs");
    const historyChecks = await verifyHistory({ store, mainWindow, widget });
    const { verifyMemoryLifecycle } = await import("./memory-smoke.mjs");
    const memoryChecks = await verifyMemoryLifecycle({ store, mainWindow });
    const { verifyMemoryBrowsing } = await import("./memory-browser-smoke.mjs");
    const memoryBrowseChecks = await verifyMemoryBrowsing({ store, evaluate: (code) => mainWindow.webContents.executeJavaScript(code) });
    const { verifyContextReview } = await import("./context-smoke.mjs");
    const contextChecks = await verifyContextReview({ store, companion, evaluate: (code) => mainWindow.webContents.executeJavaScript(code) });
    const { verifyRegeneration } = await import("./regeneration-smoke.mjs");
    const regenerationChecks = await verifyRegeneration({ store, companion, evaluate: (code) => mainWindow.webContents.executeJavaScript(code) });
    const { verifyCare } = await import("./care-smoke.mjs");
    const careChecks = await verifyCare({ store, companion, evaluate: (code) => mainWindow.webContents.executeJavaScript(code) });
    const { verifyChatFaults } = await import("./chat-fault-smoke.mjs");
    const chatFaultChecks = await verifyChatFaults({ store, companion,
      evaluate: (code) => mainWindow.webContents.executeJavaScript(code),
      navigate: (path) => mainWindow.loadURL(new URL(path, origin).href) });
    const { verifySyncSafety } = await import("./sync-safety-smoke.mjs");
    const syncSafetyChecks = await verifySyncSafety({ store, sync: synchronization, connections: server.connections,
      evaluate: (code) => mainWindow.webContents.executeJavaScript(code),
      navigate: (path) => mainWindow.loadURL(new URL(path, origin).href), davBaseUrl: process.env.NIRIA_SMOKE_DAV });
    const { verifyBackupSafety } = await import("./backup-safety-smoke.mjs");
    const backupSafetyChecks = await verifyBackupSafety({
      evaluate: (code) => mainWindow.webContents.executeJavaScript(code),
      navigate: (path) => mainWindow.loadURL(new URL(path, origin).href) });
    const { verifyLive2D } = await import("./live2d-smoke.mjs");
    const live2dChecks = await verifyLive2D({ store, evaluate: (code) => mainWindow.webContents.executeJavaScript(code),
      widgetEvaluate: (code) => widget.webContents.executeJavaScript(code) });
    const { verifyBackgroundWindows, verifyBackgroundFailures } = await import("./background-smoke.mjs");
    const backgroundChecks = await verifyBackgroundWindows({ store, mainWindow, widget, createEditor: async () => {
      const editor = new BrowserWindow({ show: false, width: 1000, height: 900,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
      await editor.loadURL(new URL("/avatar", mainWindow.webContents.getURL()).href);
      return editor;
    } });
    const backgroundFailures = await verifyBackgroundFailures((code) => mainWindow.webContents.executeJavaScript(code));
    const { verifyAvatarSafety } = await import("./avatar-safety-smoke.mjs");
    const avatarSafetyChecks = await verifyAvatarSafety({ store,
      evaluate: (code) => mainWindow.webContents.executeJavaScript(code),
      navigate: (path) => mainWindow.loadURL(new URL(path, origin).href) });
    const { verifyImageGeneration } = await import("./image-generation-smoke.mjs");
    const imageCallChecks = await verifyImageGeneration({ store,
      evaluate: (code) => mainWindow.webContents.executeJavaScript(code),
      navigate: (path) => mainWindow.loadURL(new URL(path, origin).href) });
    const { verifySpeechSafety } = await import("./speech-safety-smoke.mjs");
    const speechSafetyChecks = await verifySpeechSafety({ store,
      evaluate: (code) => mainWindow.webContents.executeJavaScript(code),
      navigate: (path) => mainWindow.loadURL(new URL(path, origin).href),
      capture: async () => { await writeFile(join(dirname(process.env.NIRIA_SMOKE_SCREENSHOT), "speech-waiting-desktop.png"), (await mainWindow.webContents.capturePage()).toPNG()); } });
    const { verifyFrameRendering } = await import("./render-smoke.mjs");
    const renderChecks = await verifyFrameRendering((code) => mainWindow.webContents.executeJavaScript(code));
    const imageTools = await mainWindow.webContents.executeJavaScript(`(async () => {
      const { imageFrom, compareFrames, normalized } = await import("/image-tools.js");
      const source = await imageFrom(${JSON.stringify(pictureFixture.source)});
      const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 96;
      const context = canvas.getContext("2d"); context.translate(2, -2); context.drawImage(source, 0, 0);
      const target = await imageFrom(canvas.toDataURL("image/png"));
      const alignment = await compareFrames(source, target);
      const wide = document.createElement("canvas"); wide.width = 80; wide.height = 40;
      wide.getContext("2d").fillRect(0, 0, 80, 40);
      const prepared = await imageFrom(normalized(await imageFrom(wide.toDataURL("image/png"))));
      const output = document.createElement("canvas"); output.width = 1024; output.height = 1536;
      const pixels = output.getContext("2d"); pixels.drawImage(prepared, 0, 0);
      return { alignmentWorker: alignment.suggested && alignment.x < 0 && alignment.y > 0,
        imageProportions: pixels.getImageData(512, 100, 1, 1).data[3] === 0 && pixels.getImageData(512, 768, 1, 1).data[3] === 255 };
    })()`);
    const result = { ok: !!identity && bridge === "function" && nodeAbsent && nativeWindow &&
      transparentCorner && collapseWorks && expandWorks && expressionDisplays && expressionClears && cleanReply && oneChatCall &&
      nativeExpressionClearsSilhouette && nativeOriginalRestored &&
      imageTools.alignmentWorker && imageTools.imageProportions && Object.values(historyChecks).every(Boolean) &&
      Object.values(memoryChecks).every(Boolean) && Object.values(memoryBrowseChecks).every(Boolean) &&
      Object.values(contextChecks).every(Boolean) &&
      Object.values(regenerationChecks).every(Boolean) &&
      Object.values(careChecks).every(Boolean) &&
      Object.values(chatFaultChecks).every(Boolean) &&
      Object.values(syncSafetyChecks).every(Boolean) &&
      Object.values(backupSafetyChecks).every(Boolean) &&
      Object.values(live2dChecks).every(Boolean) &&
      Object.values(backgroundChecks).every(Boolean) &&
      Object.values(backgroundFailures).every(Boolean) &&
      Object.values(avatarSafetyChecks).every(Boolean) &&
      Object.values(imageCallChecks).every(Boolean) &&
      Object.values(speechSafetyChecks).every(Boolean) &&
      Object.values(renderChecks).every(Boolean) && !smokeErrors.length,
      identity, bridge, nodeAbsent, nativeWindow, transparentCorner, collapseWorks, collapsedBounds, expandWorks,
      expressionDisplays, expressionClears, nativeExpressionClearsSilhouette, nativeOriginalRestored, cleanReply, oneChatCall,
      ...imageTools, ...historyChecks, ...memoryChecks, ...memoryBrowseChecks, ...contextChecks, ...regenerationChecks, ...careChecks, ...chatFaultChecks, ...syncSafetyChecks, ...backupSafetyChecks, ...live2dChecks,
      ...backgroundChecks, ...backgroundFailures, ...avatarSafetyChecks, ...imageCallChecks, ...speechSafetyChecks, ...renderChecks,
      contextSyntheticCalls: 4, regenerationSyntheticCalls: 3, careSyntheticCalls: 4, chatFaultSyntheticCalls: 7, imageLocalRequests: 3, speechLocalRequests: 6, errors: smokeErrors };
    await writeFile(process.env.NIRIA_SMOKE_RESULT, JSON.stringify(result, null, 2));
    app.quit();
  }
}
app.on("before-quit", () => {
  if (closing) return; closing = true;
  layout?.stop();
  clearInterval(timer);
  companion?.cancel();
  speech?.cancel();
  synchronization?.lock();
  tray?.destroy();
  server?.close();
  server?.closeAllConnections();
  store?.close();
  vault?.close().catch(() => {});
});
app.on("window-all-closed", () => app.quit());
