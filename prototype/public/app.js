import { imageFrom, normalized, inspectCharacterImage, prepareImageFile, compareFrames, overlayFrames, prepareAvatarFrame } from "./image-tools.js";
import { FrameBlender } from "./frame-blender.js";
import { checkBackground, backgroundReady, BACKGROUND_FALLBACK } from "./image-background.js";
import { backgroundEditor } from "./background-editor.js";

const $ = (selector) => document.querySelector(selector);
const labels = { blink: "闭眼", smile: "微笑", curious: "疑惑", shy: "害羞" };
const canvas = $("#portrait");
const ctx = canvas.getContext("2d");
const blender = new FrameBlender();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const state = {
  source: null,
  assets: {},
  background: undefined,
  backgroundFailed: false,
  draft: null,
  current: "original",
  playing: false,
  generating: false,
  frame: 0,
  nextBlink: performance.now() + 4500,
  blinkStart: null,
  token: "",
  pendingAction: null,
  confirmation: null,
  settings: null,
  preparing: false
};
let noticeTimer;
let sourceOperation = 0;
let sourceController;
const backgrounds = backgroundEditor({
  avatar: avatarPackage, unpack: unpackAvatar, apply: (prepared) => adoptAvatar(prepared, "已更新背景显示，原始素材仍保留。"),
  basis: () => [state.source, state.assets, state.background],
  busy: () => state.generating || state.preparing,
  setBusy: (value) => { state.preparing = value; updateControls(); },
  invalidate: invalidateDraft, notice
});

function notice(message, error = false) {
  const node = $("#notice");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { node.hidden = true; }, error ? 12000 : 6000);
}

function updateControls() {
  const hasSource = Boolean(state.source);
  const sourceBlocked = state.source?.quality?.issues.some((issue) => issue.blocking);
  $("#empty-stage").hidden = hasSource;
  $("#preview-label").hidden = !hasSource;
  $("#play-button").disabled = !hasSource;
  $("#play-button").textContent = state.playing ? "暂停预览" : "开始预览";
  $("#play-button").setAttribute("aria-pressed", String(state.playing));
  $("#show-original").disabled = !hasSource;
  $("#export-button").disabled = !hasSource || state.generating || state.preparing;
  $("#save-companion").disabled = !hasSource || state.generating || state.preparing;
  $("#background-button").disabled = !hasSource || state.generating || state.preparing;
  $("#background-button").textContent = state.background ? "恢复原背景" : "预览透明背景";
  $("#source-quality").hidden = !hasSource;
  if (hasSource) {
    const quality = state.source.quality;
    $("#source-quality").textContent = quality?.issues.length ? quality.issues.map((issue) => issue.message).join(" ") :
      "已检测到一张二次元人脸。人物数量、面部遮挡与身份一致性仍需在预览中确认。";
    if (state.backgroundFailed) $("#source-quality").textContent += ` ${BACKGROUND_FALLBACK}`;
  }
  $("#asset-count").textContent = `${Object.keys(state.assets).length} / 4`;
  $("#preview-label").textContent = state.current === "original" ? "原始形象" : labels[state.current];
  $("#playback-note").textContent = state.assets.blink
    ? "原始表情下可自然眨眼"
    : "生成并采用闭眼素材后，可预览眨眼";
  for (const action of Object.keys(labels)) {
    const item = $(`[data-action="${action}"]`);
    item.classList.toggle("accepted", Boolean(state.assets[action]));
    item.querySelector(".asset-status").textContent = state.assets[action] ? "已采用" : "待生成";
    const button = item.querySelector(".generate-button");
    button.disabled = !hasSource || state.generating || state.preparing || state.backgroundFailed || sourceBlocked;
    button.textContent = state.generating && state.pendingAction === action
      ? "生成中" : state.assets[action] ? "重做" : "生成";
    item.querySelector(".view-button").hidden = !state.assets[action];
  }
}

function draw(time = performance.now()) {
  state.frame = 0;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.source) return;
  const image = state.current === "original" ? state.source.img : state.assets[state.current]?.img;
  if (!image) return;
  const active = state.playing && !reducedMotion.matches;
  const breathing = active && $("#breathing").checked;
  const phase = Math.sin(time / 1150);
  const scale = breathing ? 1 + (phase + 1) * 0.003 : 1;
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(-canvas.width / 2, -canvas.height);
  let blink = null, weight = 0;

  if (active && state.current === "original" && $("#blinking").checked && state.assets.blink) {
    if (time >= state.nextBlink && state.blinkStart === null) state.blinkStart = time;
    if (state.blinkStart !== null) {
      const elapsed = time - state.blinkStart;
      if (elapsed > 180) {
        state.blinkStart = null;
        state.nextBlink = time + 3500 + Math.random() * 3500;
      } else {
        weight = Math.max(0, Math.min(1, elapsed / 55, (180 - elapsed) / 65));
        blink = state.assets.blink.img;
      }
    }
  }
  blender.draw(ctx, image, blink, weight, canvas.width, canvas.height);
  ctx.restore();
  if (active && !document.hidden) state.frame = requestAnimationFrame(draw);
}

function render() {
  if (state.frame) cancelAnimationFrame(state.frame);
  updateControls();
  draw();
}

function stopPlayback() {
  state.playing = false;
  state.blinkStart = null;
  render();
}

async function unpackAvatar(payload, { signal, previewBackground = false } = {}) {
  const data = payload.original || payload.source;
  if (payload.format !== "niria-avatar-prototype" || payload.version !== 1 || typeof data !== "string" ||
      !data.startsWith("data:image/png;base64,") || !payload.actions || typeof payload.actions !== "object" || Array.isArray(payload.actions)) {
    throw new Error("素材包格式无效。");
  }
  const background = checkBackground(payload.background);
  const source = await prepareAvatarFrame(data, background, { signal });
  const assets = {};
  for (const [name, value] of Object.entries(payload.actions)) {
    if (!Object.hasOwn(labels, name) || typeof value !== "string" || !value.startsWith("data:image/png;base64,")) throw new Error("素材格式无效。");
    assets[name] = await prepareAvatarFrame(value, background, { signal });
  }
  const frames = [source, ...Object.values(assets)];
  const backgroundFailed = !!background && !previewBackground && frames.some((frame) => !backgroundReady(frame.backgroundReport));
  if (backgroundFailed) for (const frame of frames) { frame.data = frame.raw; frame.img = frame.rawImg; }
  source.quality = await inspectCharacterImage(source.img, { signal });
  return { source, assets, background, backgroundFailed };
}
function adoptAvatar({ source, assets, background, backgroundFailed = false }, caption) {
  invalidateDraft();
  state.source = source;
  state.assets = assets;
  state.background = background;
  state.backgroundFailed = backgroundFailed;
  state.draft = null;
  state.current = "original";
  state.playing = !reducedMotion.matches;
  $("#source-caption").textContent = caption;
  render();
}

async function importImage(file) {
  if (!file) return;
  if (state.generating) return notice("请等待本次生成结束，再更换原图。", true);
  backgrounds.cancel();
  sourceController?.abort(); sourceController = new AbortController();
  const controller = sourceController;
  const operation = ++sourceOperation;
  state.preparing = true;
  updateControls();
  try {
    const prepared = await prepareImageFile(file, { signal: controller.signal });
    if (operation !== sourceOperation) return;
    if (Object.keys(state.assets).length && !window.confirm("更换图片将清除当前动作素材。需要的素材请先导出。继续更换吗？")) return;
    invalidateDraft();
    state.source = prepared;
    state.assets = {};
    state.background = undefined;
    state.backgroundFailed = false;
    state.draft = null;
    state.current = "original";
    state.playing = !reducedMotion.matches;
    $("#source-caption").textContent = `${file.name}，已准备好原始形象。`;
    notice(prepared.quality.issues.length ? "图片已导入，请留意画面检查提示。" : "图片已导入。生成动作前请配置图片编辑服务。");
  } catch (error) {
    if (operation === sourceOperation) notice(error.message || "无法读取这张图片，请检查文件是否完整，或换一张图片。", true);
  } finally {
    if (operation === sourceOperation) { state.preparing = false; render(); }
  }
}

function invalidateDraft() {
  backgrounds.cancel();
  $("#confirm-dialog").close();
  $("#review-dialog").close();
  state.confirmation = null;
  state.pendingAction = null;
}

function requestGeneration(action) {
  if (!state.source || state.generating || state.preparing) return;
  if (state.source.quality?.issues.some((issue) => issue.blocking)) return notice("请先更换不符合检查要求的原图，再生成动作。", true);
  if (state.backgroundFailed) return notice("请先恢复原背景，或重新打开形象重试本机处理，再生成动作。", true);
  if (!state.settings) {
    state.pendingAction = action;
    $("#settings-dialog").showModal();
    return;
  }
  state.pendingAction = action;
  state.confirmation = { action, source: state.source, connectionId: state.settings.connectionId };
  $("#confirm-title").textContent = `${state.assets[action] ? "重做" : "生成"}${labels[action]}素材`;
  $("#confirm-action").textContent = labels[action];
  $("#confirm-service").textContent = new URL(state.settings.baseUrl).host;
  $("#confirm-dialog").showModal();
}

function addLog(action) {
  $("#requests-empty").hidden = true;
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.textContent = `${time}　${labels[action]}：等待生成`;
  $("#request-log").prepend(item);
  return (message) => { item.textContent = `${time}　${labels[action]}：${message}`; };
}

async function review(action, data, existing = false, updateLog = null) {
  const reference = state.source;
  let img = await imageFrom(data);
  const quality = await inspectCharacterImage(img);
  const blocked = quality.issues.find((issue) => issue.blocking);
  if (blocked && !existing) throw new Error(`生成素材不可用：${blocked.message} 已有素材仍保留，没有自动重试。`);
  if (!existing) { data = normalized(img); img = await imageFrom(data); }
  const prepared = await prepareAvatarFrame(data, state.background && !state.backgroundFailed);
  data = prepared.data; img = prepared.img;
  if (reference !== state.source) return;
  const compatible = existing || !state.background || backgroundReady(prepared.backgroundReport);
  const draft = { action, ...prepared, existing, updateLog, reference, compatible };
  state.draft = draft;
  $("#reference-preview").src = reference.data;
  $("#generated-preview").src = data;
  $("#review-title").textContent = `检查${labels[action]}素材`;
  $("#result-caption").textContent = labels[action];
  $("#accept-result").textContent = existing ? "在主画面预览" : "采用这个动作";
  $("#discard-result").textContent = existing ? "关闭" : "暂不采用";
  $("#review-hint").textContent = !compatible ? "这张动作的背景无法在本机可靠处理，已有素材仍保留。可以暂不采用后单独重做，或先恢复原背景。"
    : quality.issues.map((issue) => issue.message).join(" ") || "重点查看脸型、发型、服装、人物比例与位置。";
  $("#align-result").disabled = true;
  $("#align-result").checked = false;
  $("#overlay-result").checked = false;
  $("#alignment-note").textContent = existing ? "正在查看已采用素材。" : "正在本机比较位置，不调用外部服务。";
  $("#accept-result").disabled = !existing;
  $("#review-dialog").showModal();
  if (existing) return;
  try {
    const alignment = await compareFrames(reference.img, img);
    if (state.draft !== draft || state.source !== reference) return;
    if (alignment.suggested) {
      const raw = normalized(await imageFrom(prepared.raw), alignment);
      draft.aligned = await prepareAvatarFrame(raw, state.background);
      if (state.draft !== draft || state.source !== reference) return;
      if (!state.background || backgroundReady(draft.aligned.backgroundReport)) {
        $("#align-result").disabled = false;
        $("#align-result").checked = true;
        $("#alignment-note").textContent = "检测到小幅位置差异，已对齐预览。可以取消对齐，比较服务返回的位置；对齐不能验证人物身份。";
      } else $("#alignment-note").textContent = "对齐后的背景无法可靠处理，保留服务返回的位置。";
    } else $("#alignment-note").textContent = alignment.baseline >= .88 ? "画面位置接近，未作位置修正。" : "未找到可靠的位置修正，请用叠加对照检查偏移，不合适时暂不采用。";
    renderReview();
  } catch (error) {
    if (state.draft === draft) $("#alignment-note").textContent = error.message;
  } finally {
    if (state.draft === draft) $("#accept-result").disabled = !compatible;
  }
}

function selectedDraft() { return $("#align-result").checked && state.draft?.aligned ? state.draft.aligned : state.draft; }
function renderReview() {
  if (!state.draft) return;
  const selected = selectedDraft();
  $("#generated-preview").src = $("#overlay-result").checked ? overlayFrames(state.draft.reference.img, selected.img) : selected.data;
}
$("#align-result").addEventListener("change", renderReview);
$("#overlay-result").addEventListener("change", renderReview);

async function generate() {
  $("#confirm-dialog").close();
  const confirmation = state.confirmation;
  state.confirmation = null;
  const action = confirmation?.action;
  if (!action || !state.source || !state.settings || state.generating || state.preparing) return;
  if (state.source !== confirmation.source || state.settings.connectionId !== confirmation.connectionId) return notice("参考图或服务配置已经改变，请重新确认本次生成。", true);
  state.generating = true;
  updateControls();
  const log = addLog(action);
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Niria-Token": state.token },
      body: JSON.stringify({ useConnection: true, connectionId: confirmation.connectionId, action, image: confirmation.source.data })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "生成未完成，请检查服务状态。");
    log("已返回，正在本机比较位置");
    await review(action, result.image, false, log);
    if (state.draft?.updateLog === log) log("已返回，等待外观确认");
  } catch (error) {
    log("未完成，没有自动重试");
    notice(error.message || "请求未完成，请先检查服务记录。", true);
  } finally {
    state.generating = false;
    state.pendingAction = null;
    updateControls();
  }
}

for (const id of ["source-image", "replace-image"]) {
  $(`#${id}`).addEventListener("change", (event) => {
    importImage(event.target.files[0]);
    event.target.value = "";
  });
}
for (const eventName of ["dragenter", "dragover"]) {
  $("#drop-zone").addEventListener(eventName, (event) => {
    event.preventDefault();
    $("#drop-zone").classList.add("dragging");
  });
}
$("#drop-zone").addEventListener("dragleave", () => $("#drop-zone").classList.remove("dragging"));
$("#drop-zone").addEventListener("drop", (event) => {
  event.preventDefault();
  $("#drop-zone").classList.remove("dragging");
  const files = event.dataTransfer.files;
  if (files.length !== 1) return notice("每次请选择一张单人图片。", true);
  importImage(files[0]);
});
$("#settings-button").addEventListener("click", () => $("#settings-dialog").showModal());
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => $(`#${button.dataset.close}`).close());
}
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const baseUrl = new URL($("#base-url").value.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
    if (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && local)) {
      return notice("远程服务请使用 HTTPS；本机服务可以使用 HTTP。", true);
    }
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      return notice("服务地址不能包含账号、查询参数或片段。", true);
    }
    const config = {
      baseUrl: baseUrl.href.replace(/\/+$/, ""),
      model: $("#model").value.trim(),
      apiKey: $("#api-key").value.trim(),
      highFidelity: $("#high-fidelity").checked,
      transparent: $("#transparent").checked
    };
    if (!config.model) return;
    const response = await fetch("/api/image/configure", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": state.token },
      body: JSON.stringify({ ...config, remember: $("#image-remember").checked, reuseSecret: $("#image-reuse").checked })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "图片服务配置未应用。");
    state.settings = result.image;
    $("#api-key").value = "";
    $("#image-reuse").checked = result.image.hasSecret;
    $("#settings-dialog").close();
    notice("设置已应用。只有确认生成时才会向服务发送图片。");
    if (state.pendingAction && state.source) requestGeneration(state.pendingAction);
  } catch (error) {
    notice(error.message || "请填写完整的 API 根地址。", true);
  }
});
$("#confirm-generate").addEventListener("click", generate);
for (const button of document.querySelectorAll("[data-generate]")) {
  button.addEventListener("click", () => requestGeneration(button.dataset.generate));
}
for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    const action = button.dataset.view;
    review(action, state.assets[action].raw || state.assets[action].data, true).catch(() => notice("无法读取素材，请重新生成。", true));
  });
}
$("#discard-result").addEventListener("click", () => {
  $("#review-dialog").close();
});
$("#review-dialog").addEventListener("close", () => {
  if ($("#review-dialog").open) return;
  if (state.draft && !state.draft.existing) state.draft.updateLog?.("未采用，已有素材保留");
  state.draft = null;
});
$("#accept-result").addEventListener("click", () => {
  if (!state.draft) return;
  const { action, updateLog } = state.draft;
  if (!state.draft.compatible) return;
  const { data, raw, img } = selectedDraft();
  state.assets[action] = { data, raw: raw || data, img };
  updateLog?.("已采用");
  state.current = action === "blink" ? "original" : action;
  state.blinkStart = null;
  state.nextBlink = performance.now() + 1000;
  state.draft = null;
  $("#review-dialog").close();
  render();
  notice(`${labels[action]}素材已采用，可以在主画面预览。`);
});
$("#show-original").addEventListener("click", () => {
  state.current = "original";
  state.blinkStart = null;
  render();
});
$("#play-button").addEventListener("click", () => {
  state.playing = !state.playing;
  render();
  if (reducedMotion.matches && state.playing) notice("系统启用了减少动态效果，当前保持静态预览。");
});
for (const id of ["breathing", "blinking"]) $(`#${id}`).addEventListener("change", render);
reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) stopPlayback(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.frame) {
    cancelAnimationFrame(state.frame);
    state.frame = 0;
  } else if (!document.hidden) render();
});
window.addEventListener("pagehide", () => {
  sourceController?.abort(); ++sourceOperation;
  cancelAnimationFrame(state.frame);
  blender.destroy();
}, { once: true });

function avatarPackage() {
  if (!state.source) return null;
  return {
    format: "niria-avatar-prototype",
    version: 1,
    width: 1024,
    height: 1536,
    original: state.source.raw || state.source.data,
    actions: Object.fromEntries(Object.entries(state.assets).map(([key, asset]) => [key, asset.raw || asset.data])),
    ...(state.background ? { background: state.background } : {})
  };
}
$("#export-button").addEventListener("click", () => {
  const payload = avatarPackage();
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "niria-avatar.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice("素材包已导出，包含原图与已采用动作，请自行保管。");
});
$("#save-companion").addEventListener("click", async () => {
  if (!state.source || state.generating || state.preparing) return;
  try {
    const response = await fetch("/api/avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Niria-Token": state.token },
      body: JSON.stringify(avatarPackage())
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    notice("形象与已采用动作已保存到伴侣，回到首页即可聊天。");
  } catch (error) { notice(error.message || "形象未保存，请重试。", true); }
});
$("#import-package").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (state.generating) return notice("请等待当前生成完成，再导入素材包。", true);
  backgrounds.cancel();
  if (file.size > 65 * 1024 * 1024) return notice("素材包超过 65 MB，无法导入。", true);
  sourceController?.abort(); sourceController = new AbortController();
  const controller = sourceController;
  const operation = ++sourceOperation;
  state.preparing = true;
  updateControls();
  try {
    const payload = JSON.parse(await file.text());
    controller.signal.throwIfAborted();
    if (operation !== sourceOperation) return;
    if (payload.width !== 1024 || payload.height !== 1536) throw new Error("素材包画布无效。");
    const prepared = await unpackAvatar(payload, { signal: controller.signal });
    if (operation !== sourceOperation) return;
    if (state.source && !window.confirm("导入素材包将替换当前图片和动作。继续吗？")) return;
    adoptAvatar(prepared, "已从素材包恢复形象与动作。");
    notice("素材包已导入；生成服务仍需在当前会话单独配置。");
  } catch {
    if (operation === sourceOperation) notice("素材包格式无效或图片损坏，请选择此原型导出的完整素材包。", true);
  } finally {
    if (operation === sourceOperation) { state.preparing = false; render(); }
  }
});

try {
  const response = await fetch("/api/session");
  if (!response.ok) throw new Error();
  const session = await response.json();
  state.token = session.token;
  const connections = await (await fetch("/api/connections", { headers: { "X-Niria-Token": state.token } })).json();
  $("#image-remember").disabled = !connections.storage?.available;
  $("#image-remember").checked = !!connections.image?.remember;
  if (connections.image?.configured) {
    state.settings = connections.image;
    $("#base-url").value = connections.image.baseUrl;
    $("#model").value = connections.image.model;
    $("#image-reuse").checked = connections.image.hasSecret;
    $("#high-fidelity").checked = connections.image.highFidelity;
    $("#transparent").checked = connections.image.transparent;
  }
  $("#save-companion").hidden = session.prototype;
  if (!session.prototype) {
    try {
      const snapshotResponse = await fetch("/api/state", { headers: { "X-Niria-Token": state.token } });
      if (!snapshotResponse.ok) throw new Error();
      const snapshot = await snapshotResponse.json();
      if (snapshot.avatar?.format === "niria-live2d-avatar") {
        notice("伴侣目前使用 Live2D。这里用于制作图片动作；选择新图片并保存后才会替换当前形象。");
      }
      if (snapshot.avatar && snapshot.avatar.format !== "niria-live2d-avatar" && sourceOperation === 0) {
        const prepared = await unpackAvatar(snapshot.avatar);
        if (sourceOperation === 0) adoptAvatar(prepared, "已载入伴侣保存的形象与动作，可以单独重做。");
      }
    } catch { notice("已保存形象暂时无法读取，请回到首页检查或重新导入；本机资料没有被修改。", true); }
  }
  if (session.busy) notice("本机仍有生成请求正在处理，请等候完成后再试。");
} catch {
  notice("无法连接本机实验台，请用 npm start 启动后打开显示的地址。", true);
}
render();
