import { AvatarPlayer } from "./avatar-player.js";
import { watchState } from "./state-events.js";
import { prepareImageFile } from "./image-tools.js";
import { syncSecurity } from "./sync-security.js";
import { chatHistory } from "./history.js";
import { forgetReview } from "./forget-review.js";
import { memoryBrowser } from "./memory-browser.js";
import { contextReview } from "./context-review.js";
import { chatActivity } from "./chat-activity.js";
import { live2DDialog } from "./live2d-dialog.js";

const $ = (selector) => document.querySelector(selector);
const state = { token: "", data: null, busy: false, view: "chat", edit: null };
let noticeTimer;
let audioURL = null;
let speechBusy = false;
let seenReplies = null;
let playingMessage = null;
let refreshing, refreshAgain = false, refreshAssets = false;
let avatarImport = 0;
let avatarController;
function beginAvatarImport() {
  avatarController?.abort(); avatarController = new AbortController();
  return ++avatarImport;
}
let avatarWrite = Promise.resolve();
let draftRevision = 0;
const activity = chatActivity({ api });
const interact = () => { if (state.token) activity.changed(); };
window.addEventListener("pagehide", () => { activity.stop(); avatarController?.abort(); ++avatarImport; }, { once: true });
const contexts = contextReview({ api, refresh, data: () => state.data, draft: () => $("#message-input").value });
const live2d = live2DDialog({ api, refresh, notice, data: () => state.data, beforeOpen: beginAvatarImport });
const renderSecurity = syncSecurity({ api, refresh, notice });
const history = chatHistory({ api, refresh, renderMessage });
const memories = memoryBrowser({ api, refresh, renderMemory });
const forgetting = forgetReview({ api, refresh, notice, stopAudio, openHistory: (id) => history.open(id), data: () => state.data });
const avatarPlayer = new AvatarPlayer($("#avatar-canvas"), {
  presence: (visible) => { $("#avatar-canvas").hidden = !visible; $("#avatar-empty").hidden = visible; },
  error: (message) => notice(message, true)
});
function notice(message, error = false) {
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", error);
  $("#notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $("#notice").hidden = true; }, error ? 12000 : 6500);
}
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function action(label, callback) {
  const button = element("button", "", label);
  button.type = "button";
  button.addEventListener("click", () => Promise.resolve().then(callback).catch((e) => notice(e.message, true)));
  return button;
}
async function api(path, body, { signal } = {}) {
  const response = await fetch(path, {
    signal,
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Niria-Token": state.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "本次操作未完成。"), { status: response.status });
  return result;
}
function dateLabel(value, year = false) {
  return new Date(value).toLocaleString("zh-CN", { ...(year ? { year: "numeric" } : {}), month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function refresh(assets = false) {
  refreshAssets ||= assets;
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      const full = refreshAssets;
      refreshAssets = false;
      let data = await api(`/api/state?messages=recent&memories=none${full ? "" : "&assets=0"}`);
      if (!Object.hasOwn(data, "avatar")) {
        if (data.avatarKey && data.avatarKey !== state.data?.avatarKey) data = await api("/api/state?messages=recent&memories=none");
        else data.avatar = data.avatarKey ? state.data?.avatar || null : null;
      }
      state.data = data;
      render();
    } while (refreshAgain || refreshAssets);
  })().finally(() => { refreshing = null; });
  return refreshing;
}
function setView(view) {
  state.view = view;
  $("#view-chat").hidden = view !== "chat";
  $("#view-memories").hidden = view !== "memories";
  for (const button of document.querySelectorAll("button[data-view]")) button.classList.toggle("selected", button.dataset.view === view);
  if (state.data) memories.update(state.data.memoryWindow, view === "memories");
}
function openSettings(tab = "connection") {
  const { identity, settings, service } = state.data;
  const connections = state.data.connections;
  for (const kind of ["chat", "speech", "sync"]) {
    const config = connections?.[kind];
    $(`#${kind}-reuse`).checked = !!config?.hasSecret;
    $(`#${kind}-reuse`).disabled = !config?.hasSecret;
    $(`#${kind}-remember`).checked = !!config?.remember;
    $(`#${kind}-remember`).disabled = !connections?.storage.available;
  }
  $("#pair-remember").checked = !!connections?.rememberPair;
  $("#pair-remember").disabled = !connections?.storage.available;
  $("#chat-base").value = service.baseUrl;
  $("#chat-model").value = service.model;
  $("#chat-key").value = "";
  for (const [id, key] of [["identity-name", "name"], ["identity-user", "userName"], ["identity-persona", "persona"], ["identity-style", "style"], ["identity-relationship", "relationship"]]) $(`#${id}`).value = identity[key];
  $("#allow-model").checked = settings.allowModel;
  $("#allow-sync").checked = settings.allowSync;
  $("#auto-memory").checked = settings.autoMemory;
  $("#memory-limit").value = settings.memoryDailyLimit;
  $("#care-enabled").checked = settings.care.enabled;
  $("#care-interval").value = settings.care.intervalMinutes;
  $("#care-limit").value = settings.care.dailyLimit;
  $("#quiet-start").value = settings.care.quietStart;
  $("#quiet-end").value = settings.care.quietEnd;
  $("#backup-password").value = "";
  const sync = state.data.synchronization;
  $("#sync-base").value = sync?.baseUrl || "";
  $("#sync-user").value = connections?.sync.username || "";
  $("#sync-password").value = "";
  $("#sync-auto").checked = sync?.auto || false;
  $("#sync-code").value = "";
  const speech = state.data.speech || {};
  for (const field of ["base", "model", "voice"]) $(`#speech-${field}`).value = speech[field === "base" ? "baseUrl" : field] || "";
  $("#speech-key").value = "";
  $("#speech-auto").checked = !!speech.auto;
  $("#speech-limit").value = speech.dailyLimit || 20;
  setTab(tab);
  if (!$("#settings-dialog").open) $("#settings-dialog").showModal();
}
function setTab(tab) {
  for (const button of document.querySelectorAll("[data-tab]")) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  for (const section of document.querySelectorAll("[data-settings]")) section.hidden = section.dataset.settings !== tab;
}
function edit(kind, id, content = "", original = null) {
  state.edit = { kind, id, original: original ? structuredClone(original) : null };
  $("#edit-title").textContent = kind === "message" ? "编辑最近一条消息" : id ? "编辑记忆" : "添加记忆";
  $("#edit-content").maxLength = kind === "message" ? 16000 : 2000;
  $("#edit-content").value = content;
  $("#edit-memory-fields").hidden = kind === "message";
  $("#edit-memory-kind").value = original?.kind || "fact";
  $("#edit-memory-permanent").checked = !original?.expiresAt;
  $("#edit-memory-expiry").value = localMinute(original?.expiresAt || new Date(Date.now() + 86_400_000));
  updateExpiryField();
  $("#edit-hint").textContent = kind === "message" ? "保存后旧回复将移除，相关旧记忆停止引用。你可以手动重新生成回复。" : "修改正文会成为你手动确认的资料。原来源版本及其回复、衍生记忆停止引用，仍可查看或一起遗忘；只改类型或期限保留来源与确认状态。";
  $("#edit-dialog").showModal();
}
function localMinute(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function updateExpiryField() {
  const permanent = $("#edit-memory-permanent").checked;
  $("#edit-memory-expiry").disabled = permanent || $("#edit-memory-fields").hidden;
  $("#edit-memory-expiry").required = !permanent && !$("#edit-memory-fields").hidden;
}
$("#edit-memory-permanent").addEventListener("change", updateExpiryField);
async function mutate(path, body) {
  stopAudio();
  await api(path, body);
  await refresh(path === "/api/avatar");
}
function renderMessage(message, inHistory = false) {
  const article = element("article", `message ${message.role} ${message.status}`);
  article.dataset.id = message.id;
  const label = message.role === "user" ? state.data.identity.userName || "你" : state.data.identity.name;
  const meta = element("div", "message-meta");
  meta.append(element("span", "", label), element("time", "", dateLabel(message.createdAt, inHistory)));
  if (message.proactive) meta.append(element("span", "tag", "主动问候"));
  if (message.conflicted) meta.append(element("span", "tag", "同步冲突"));
  const replacing = message.status === "pending" && message.replyTo && state.data.messages.some((other) =>
    other.id !== message.id && other.replyTo === message.replyTo && !other.deleted && other.status === "completed");
  const body = message.status === "pending" ? replacing ? "正在重新回复，成功后替换原回复…" : "正在想怎么回应你…"
    : message.content || message.error || "本次回复已停止。";
  article.append(meta, element("div", "message-body", body));
  const actions = element("div", "message-actions");
  const lastUserId = state.data.messageWindow?.lastUserId ?? state.data.messages.findLast((m) => m.role === "user" && !m.deleted)?.id;
  if (!message.conflicted && message.role === "user" && message.id === lastUserId) actions.append(
    action("编辑", () => edit("message", message.id, message.content)),
    action("重新回复", () => send({ retryId: message.id }))
  );
  if (!message.conflicted && message.context && message.status === "completed") actions.append(action("引用的记忆", () => contexts.used(message)));
  if (!message.conflicted && message.role === "assistant" && message.status === "completed" && state.data.speech?.configured) {
    actions.append(action("朗读（1 次请求）", () => speak({ id: message.id })));
  }
  if (inHistory) actions.append(action("查看前后聊天", () => history.open(message.id)));
  if (message.status !== "pending") actions.append(action("删除", async () => {
    if (confirm("删除这条消息？关联的旧记忆会停止引用；删除用户消息也会移除对应回复。")) await mutate("/api/messages/delete", { id: message.id });
  }));
  article.append(actions);
  return article;
}
function renderMessages() {
  const area = $("#messages");
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
  const messages = state.data.messages.filter((m) => !m.deleted);
  area.replaceChildren();
  if (!messages.length) {
    const empty = element("div", "empty-chat");
    empty.append(element("span", "", "✧"), element("h3", "", "从一句「今天过得怎么样」开始"), element("p", "", "名字、喜好、一起经历的小事，会慢慢成为你们的共同记忆。"));
    const button = action("连接我的对话服务", () => openSettings());
    button.className = "button quiet";
    empty.append(button);
    area.append(empty);
  }
  for (const message of messages.slice(-120)) area.append(renderMessage(message));
  if (nearBottom || state.busy) area.scrollTop = area.scrollHeight;
}
function permission(memory, key, label) {
  const wrapper = element("label", "", label);
  const select = element("select");
  select.setAttribute("aria-label", `${label}：${memory.content.slice(0, 20)}`);
  for (const [value, text] of [["default", "使用默认"], ["true", "允许"], ["false", "禁止"]]) {
    const option = element("option", "", text);
    option.value = value;
    select.append(option);
  }
  select.value = memory[key] === null ? "default" : String(memory[key]);
  select.addEventListener("change", () => mutate("/api/memories/edit", { id: memory.id, [key]: select.value === "default" ? null : select.value === "true" }).catch((e) => notice(e.message, true)));
  wrapper.append(select);
  return wrapper;
}
function renderMemory(memory, status) {
    const expired = memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now();
    const card = element("article", `memory-card${memory.invalidated || expired ? " invalid" : ""}`);
    card.dataset.id = memory.id;
    const tags = element("div", "memory-tags");
    tags.append(element("span", `tag${memory.confirmed ? " confirmed" : ""}`, memory.confirmed ? "已确认" : "待确认"),
      element("span", "", { fact: "明确资料", experience: "共同经历", inference: "未确认线索" }[memory.kind]),
      element("time", "", dateLabel(memory.createdAt)));
    if (memory.conflicted || memory.invalidated || expired) tags.append(element("span", "", memory.conflicted ? "同步冲突 · 暂停引用" : memory.invalidated ? "来源改变 · 已停用" : "已过期"));
    else if (status === "inactive") tags.append(element("span", "", "来源不可用 · 暂停引用"));
    card.append(tags, element("p", "", memory.content));
    card.append(element("p", "memory-lifetime", memory.expiresAt ? `到期：${dateLabel(memory.expiresAt, true)} · 本机时间` : "长期保留"));
    const source = element("details", "memory-source");
    const sourceCount = memory.sources.length + (memory.supersededSources?.length || 0);
    source.append(element("summary", "", memory.supersededSources?.length
      ? `手动纠正 · 查看 ${memory.supersededSources.length} 条原关联记录`
      : sourceCount ? `查看 ${sourceCount} 条来源` : "你手动确认的资料"));
    let loading = false, loaded = false;
    const contents = element("div");
    source.append(contents);
    source.addEventListener("toggle", async () => {
      if (!source.open || !sourceCount || loaded || loading) return;
      loading = true;
      contents.textContent = "正在读取本机来源…";
      try {
        const result = await api("/api/memories/sources", { id: memory.id, revision: memory.revision });
        if (!source.isConnected) return;
        contents.replaceChildren();
        for (const item of result.sources) {
          const quote = element("blockquote", "", item.content);
          if (item.available) quote.append(action("查看前后聊天", () => history.open(item.id)));
          contents.append(quote);
        }
        if (result.supersededSources?.length) {
          contents.append(element("p", "", "以下记录用于追溯、权限控制和遗忘，已被你的纠正替代，不再作为这条记忆的依据。"));
          for (const item of result.supersededSources) {
            const quote = element("blockquote", "", item.content);
            if (item.available) quote.append(action("查看前后聊天", () => history.open(item.id)));
            contents.append(quote);
          }
        }
        loaded = true;
      } catch (error) { if (source.isConnected) contents.textContent = error.message; }
      finally { loading = false; }
    });
    const controls = element("div", "memory-permissions");
    controls.append(permission(memory, "allowModel", "发送模型"), permission(memory, "allowSync", "参与同步"));
    const actions = element("div", "message-actions");
    if (!memory.confirmed && status !== "inactive") actions.append(action("确认", () => mutate("/api/memories/edit", { id: memory.id, confirmed: true })));
    actions.append(action("编辑", () => edit("memory", memory.id, memory.content, memory)), action("删除", async () => {
      if (confirm("删除这条记忆？原始聊天仍会保留，但不会再从同一来源自动整理出记忆。")) await mutate("/api/memories/delete", { id: memory.id });
    }));
    if (sourceCount || memory.conflicted) actions.append(action("忘记相关记录", () => forgetting.open(memory.id)));
    card.append(source, controls, actions);
    return card;
}
function renderCalls() {
  const area = $("#calls-list");
  area.replaceChildren();
  for (const call of state.data.calls.slice(-30).toReversed()) {
    const item = element("div", "call-item");
    const info = element("span", "", `${{ chat: "聊天", memory: "记忆整理", care: "主动关心", test: "连接测试", speech: "语音朗读" }[call.kind] || call.kind} · ${dateLabel(call.at)}`);
    info.append(element("small", "", `${call.model} · ${call.endpoint}`));
    item.append(info, element("span", "", { pending: "处理中", completed: "已返回", failed: "失败", unknown: "结果未知" }[call.status]));
    area.append(item);
  }
  if (!area.children.length) area.append(element("p", "hint", "尚未调用对话服务。"));
}
function render() {
  const { identity, settings, service } = state.data;
  $("#companion-name").textContent = identity.name;
  $("#chat-title").textContent = `和 ${identity.name} 聊聊`;
  $("#relationship-caption").textContent = identity.relationship;
  $("#connection-status").textContent = service.busy || state.busy ? "正在回复 · 可以停止本次请求" : service.connected ? `已连接 ${service.model}` : "配置对话服务，开始第一次聊天。";
  $("#care-status").textContent = settings.care.enabled ? `主动关心 · 间隔至少 ${settings.care.intervalMinutes} 分钟` : "主动关心已关闭";
  $("#request-hint").textContent = settings.autoMemory && settings.memoryDailyLimit ? `聊天 1 次 · 记忆整理每天最多 ${settings.memoryDailyLimit} 次` : "每次聊天 1 次模型请求";
  $("#send-message").disabled = state.busy || service.busy;
  $("#stop-chat").hidden = !(state.busy || service.busy);
  renderMessages();
  history.update(state.data.messageWindow);
  memories.update(state.data.memoryWindow, state.view === "memories");
  contexts.update();
  live2d.update();
  forgetting.update();
  renderCalls();
  renderSync();
  const credentials = state.data.connections;
  $("#credential-status").textContent = credentials?.storage.warning ||
    (credentials?.storage.available ? `Windows 安全存储可用。已保存：${credentials.storage.saved.map((s) => ({ chat: "对话", image: "图片", speech: "朗读", sync: "WebDAV", pair: "配对码" }[s])).join("、") || "暂无"}。` : "当前不支持安全保存，仅本次会话使用。");
  $("#forget-credentials").disabled = !credentials?.storage.saved.length;
  if (playingMessage && playingMessage.revision !== state.data.messageWindow?.revision) stopAudio();
  const replies = state.data.messages.filter((m) => m.role === "assistant" && !m.deleted && m.status === "completed");
  const newReply = seenReplies && replies.findLast((m) => !seenReplies.has(m.id));
  seenReplies ||= new Set();
  for (const reply of replies) seenReplies.add(reply.id);
  if (newReply && state.data.speech?.auto && !speechBusy) speak({ id: newReply.id, automatic: true }).catch((e) => notice(e.message, true));
  avatarPlayer.update(state.data).catch(() => notice("形象素材无法读取，请重新导入图片。", true));
}
async function send(input) {
  if (state.busy || state.data.service.busy) return;
  if (!state.data.service.connected) return openSettings();
  const submittedDraft = $("#message-input").value, revision = draftRevision;
  state.busy = true;
  render();
  const request = api("/api/chat", input);
  setTimeout(() => refresh().catch(() => {}), 150);
  try {
    await request;
    if (!input.retryId && draftRevision === revision && $("#message-input").value === submittedDraft) {
      $("#message-input").value = "";
      contexts.draftChanged();
    }
  } catch (error) { notice(error.message, true); }
  finally { state.busy = false; await refresh(); }
}
async function configure() {
  await api("/api/connection", { baseUrl: $("#chat-base").value, model: $("#chat-model").value, apiKey: $("#chat-key").value,
    reuseSecret: $("#chat-reuse").checked, remember: $("#chat-remember").checked });
  $("#chat-key").value = "";
  await refresh();
}
function download(payload, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
for (const button of document.querySelectorAll("button[data-view]")) button.addEventListener("click", () => setView(button.dataset.view));
for (const button of document.querySelectorAll("[data-tab]")) button.addEventListener("click", () => setTab(button.dataset.tab));
for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => $(`#${button.dataset.close}`).close());
$("#open-settings").addEventListener("click", () => openSettings());
$("#edit-identity").addEventListener("click", () => openSettings("identity"));
$("#add-memory").addEventListener("click", () => edit("memory", null));
$("#open-live2d").addEventListener("click", () => {
  try { live2d.open(); } catch (error) { notice(error.message, true); }
});
$("#message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("#composer").requestSubmit(); }
});
$("#message-input").addEventListener("focus", interact);
$("#message-input").addEventListener("input", () => { draftRevision++; contexts.draftChanged(); interact(); });
$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const content = $("#message-input").value.trim();
  if (content) send({ content }).catch((e) => notice(e.message, true));
});
$("#stop-chat").addEventListener("click", () => api("/api/cancel", {}).catch((e) => notice(e.message, true)));
$("#connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await configure(); $("#settings-dialog").close(); notice("对话连接已应用。下一条消息会使用这个模型。"); } catch (e) { notice(e.message, true); }
});
$("#test-connection").addEventListener("click", async () => {
  const button = $("#test-connection"); if (button.disabled) return; button.disabled = true;
  try {
    const current = state.data.service;
    if (!current.connected || $("#chat-key").value || current.baseUrl !== $("#chat-base").value || current.model !== $("#chat-model").value) await configure();
    await api("/api/connection/test", {}); await refresh(); notice("对话接口已返回有效文本。");
  } catch (e) { notice(e.message, true); }
  finally { button.disabled = false; }
});
$("#identity-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await mutate("/api/identity", { name: $("#identity-name").value, userName: $("#identity-user").value, persona: $("#identity-persona").value, style: $("#identity-style").value, relationship: $("#identity-relationship").value });
    $("#settings-dialog").close(); notice("伴侣资料已保存。");
  } catch (e) { notice(e.message, true); }
});
$("#privacy-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await mutate("/api/settings", { allowModel: $("#allow-model").checked, allowSync: $("#allow-sync").checked, autoMemory: $("#auto-memory").checked, memoryDailyLimit: Number($("#memory-limit").value),
      care: { enabled: $("#care-enabled").checked, intervalMinutes: Number($("#care-interval").value), dailyLimit: Number($("#care-limit").value), quietStart: Number($("#quiet-start").value), quietEnd: Number($("#quiet-end").value) } });
    $("#settings-dialog").close(); notice("记忆和关心设置已保存。");
  } catch (e) { notice(e.message, true); }
});
$("#edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const editState = state.edit;
  try {
    const path = editState.kind === "message" ? "/api/messages/edit" : editState.id ? "/api/memories/edit" : "/api/memories/add";
    const input = { id: editState.id }, content = $("#edit-content").value.trim(), original = editState.original;
    if (editState.kind === "message" || !original || content !== original.content) input.content = content;
    if (editState.kind === "memory") {
      if (!original || $("#edit-memory-kind").value !== original.kind) input.kind = $("#edit-memory-kind").value;
      const expiry = $("#edit-memory-permanent").checked ? null : $("#edit-memory-expiry").value;
      if (!original || (expiry === null ? original.expiresAt !== null : !original.expiresAt || expiry !== localMinute(original.expiresAt))) {
        if (expiry !== null && (!Number.isFinite(new Date(expiry).getTime()) || new Date(expiry).getTime() <= Date.now())) throw new Error("请选择未来的到期时间，或设为长期保留。");
        input.expiresAt = expiry === null ? null : new Date(expiry).toISOString();
      }
      if (original) input.expected = original;
    }
    const changed = Object.keys(input).some((key) => !["id", "expected"].includes(key));
    if (changed) await mutate(path, input);
    $("#edit-dialog").close(); notice("已保存。");
  } catch (e) { notice(e.message, true); }
});
$("#preview-context").addEventListener("click", () => contexts.draft());
$("#export-backup").addEventListener("click", async () => {
  const button = $("#export-backup"); if (button.disabled) return; button.disabled = true;
  try { download(await api("/api/backup/export", { password: $("#backup-password").value }), `niria-${new Date().toISOString().slice(0, 10)}.niria`); $("#backup-password").value = ""; notice("加密备份已导出，请单独保管口令。"); }
  catch (e) { notice(e.message, true); } finally { button.disabled = false; }
});
$("#restore-backup").addEventListener("change", async (event) => {
  const file = event.target.files[0]; event.target.value = ""; if (!file) return;
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error("备份超过当前 100 MB 上限。");
    if (!confirm("恢复将替换本机的伴侣、聊天、记忆和形象。请先导出当前资料。确定恢复吗？")) return;
    const backup = JSON.parse(await file.text());
    await api("/api/backup/restore", { backup, password: $("#backup-password").value });
    $("#backup-password").value = ""; $("#settings-dialog").close(); await refresh(true); notice("伴侣与共同记忆已恢复。");
  } catch (e) { notice(e.message, true); }
});
$("#avatar-package").addEventListener("change", async (event) => {
  const file = event.target.files[0]; event.target.value = ""; if (!file) return;
  const operation = beginAvatarImport();
  try {
    if (file.size > 65 * 1024 * 1024) throw new Error("素材包超过 65 MB。");
    const avatar = JSON.parse(await file.text());
    if (operation !== avatarImport) return;
    if (["niria-live2d", "niria-live2d-avatar"].includes(avatar?.format)) {
      live2d.openPackage(avatar);
      return;
    }
    if (state.data.avatar && !confirm("用这个素材包替换当前伴侣的形象？聊天和记忆会保留。")) return;
    if (await saveImportedAvatar(avatar, operation) && operation === avatarImport) notice("形象已保存到本机。");
  } catch (e) { if (operation === avatarImport) notice(e.message, true); }
});
function saveImportedAvatar(avatar, operation) {
  const task = avatarWrite.then(async () => {
    if (operation !== avatarImport) return false;
    await mutate("/api/avatar", avatar);
    return true;
  });
  avatarWrite = task.catch(() => {});
  return task;
}
$("#avatar-image").addEventListener("change", async (event) => {
  const file = event.target.files[0]; event.target.value = ""; if (!file) return;
  const operation = beginAvatarImport();
  try {
    const prepared = await prepareImageFile(file, { signal: avatarController.signal });
    if (operation !== avatarImport) return;
    const saved = await saveImportedAvatar({ format: "niria-avatar-prototype", original: prepared.data, actions: {} }, operation);
    if (!saved || operation !== avatarImport) return;
    notice(prepared.quality.issues.length ? `形象已保存。${prepared.quality.issues.map((issue) => issue.message).join(" ")}` : "形象已保存。可以在形象实验台生成更多表情。");
  } catch (e) { if (operation === avatarImport) notice(e.message, true); }
});
if (window.niriaDesktop) {
  const desktopState = (data) => {
    $("#desktop-warning").textContent = data.warning || "";
    $("#desktop-warning").hidden = !data.warning;
  };
  window.niriaDesktop.onDesktopState(desktopState);
  window.niriaDesktop.desktopState().then(desktopState).catch(() => {});
  $("#show-widget").hidden = false;
  $("#show-widget").addEventListener("click", () => window.niriaDesktop.showWidget());
}
function stopAudio() {
  $("#speech-audio").pause();
  $("#speech-audio").removeAttribute("src");
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = null;
  playingMessage = null;
  $("#speech-player").hidden = true;
}
async function speak(input) {
  if (speechBusy) return;
  stopAudio();
  speechBusy = true;
  try {
    const result = await api("/api/speech/speak", input);
    playingMessage = input.id ? { id: input.id, revision: state.data.messageWindow?.revision } : null;
    const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
    audioURL = URL.createObjectURL(new Blob([bytes], { type: result.mime }));
    $("#speech-audio").src = audioURL;
    $("#speech-player").hidden = false;
    try { await $("#speech-audio").play(); }
    catch { notice("音频已就绪，点击播放器开始播放。"); }
  } finally { speechBusy = false; await refresh(); }
}
async function configureSpeech() {
  await api("/api/speech/configure", {
    baseUrl: $("#speech-base").value, model: $("#speech-model").value, voice: $("#speech-voice").value,
    apiKey: $("#speech-key").value, auto: $("#speech-auto").checked, dailyLimit: Number($("#speech-limit").value),
    reuseSecret: $("#speech-reuse").checked, remember: $("#speech-remember").checked
  });
  $("#speech-key").value = "";
  await refresh();
}
$("#speech-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await configureSpeech(); $("#settings-dialog").close(); notice("朗读服务已配置，文字聊天继续使用独立的对话服务。"); }
  catch (e) { notice(e.message, true); }
});
$("#speech-test").addEventListener("click", async () => {
  const button = $("#speech-test"); if (button.disabled) return; button.disabled = true;
  try {
    const old = state.data.speech;
    if (!old.configured || $("#speech-key").value || old.baseUrl !== $("#speech-base").value || old.model !== $("#speech-model").value || old.voice !== $("#speech-voice").value) await configureSpeech();
    await speak({ test: true });
  } catch (e) { notice(e.message, true); }
  finally { button.disabled = false; }
});
$("#speech-stop").addEventListener("click", () => {
  stopAudio(); api("/api/speech/cancel", {}).catch((e) => notice(e.message, true));
});
function renderSync() {
  const sync = state.data.synchronization;
  if (!sync) return;
  renderSecurity(sync);
  $("#sync-alert").hidden = !sync.conflicts.length;
  $("#sync-alert").textContent = `处理 ${sync.conflicts.length} 个同步冲突`;
  $("#sync-status").textContent = sync.busy ? "正在处理同步任务，资料会先保存在本机。" :
    sync.rotation?.pending ? "换钥结果待核对，已暂停上传和自动同步。请使用下方只读核对。" :
    sync.error ? sync.error :
    !sync.configured ? "同步未配置。本地聊天和记忆照常保存。" :
    !sync.unlocked ? "连接已配置，创建空间或使用配对码解锁后开始同步。" :
    sync.lastSuccess ? `上次同步：${dateLabel(sync.lastSuccess)} · ${sync.conflicts.length} 个待处理冲突` : "同步空间已解锁，尚未成功同步。";
  for (const id of ["sync-run", "sync-probe", "sync-join", "sync-create", "sync-unlock", "sync-pairing"]) $(`#${id}`).disabled = sync.busy;
  $("#sync-run").disabled ||= !!(sync.rotation?.pending || sync.rotation?.prepared);
  const area = $("#sync-conflicts");
  area.replaceChildren();
  for (const conflict of sync.conflicts) {
    const card = element("article", "memory-card");
    card.append(element("h3", "", { identity: "伴侣资料有不同版本", memory: "记忆有不同版本", message: "消息有不同版本", avatar: "形象有不同版本" }[conflict.kind]),
      element("p", "hint", "选择一个版本后会保存在本机，下次同步传播到其他设备。"));
    for (const candidate of conflict.candidates) {
      const row = element("div", "sync-candidate");
      row.append(element("p", "", conflict.kind === "identity"
        ? `${candidate.value.name}\n${candidate.value.persona}\n${candidate.value.style}\n${candidate.value.relationship}`
        : conflict.kind === "avatar" ? "查看下方形象后选择" : candidate.value?.content || "已撤回同步"));
      if (conflict.kind === "avatar" && candidate.value?.source) {
        const img = element("img"); img.src = candidate.value.source; img.alt = "冲突的形象版本"; row.append(img);
      }
      const button = action(`采用此版本 · ${candidate.device.slice(0, 8)}`, async () => {
        await api("/api/sync/resolve", { key: conflict.key, headId: candidate.id }); await refresh(true);
      });
      button.className = "button quiet";
      row.append(button); card.append(row);
    }
    area.append(card);
  }
}
$("#sync-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/sync/configure", { baseUrl: $("#sync-base").value, username: $("#sync-user").value, password: $("#sync-password").value, auto: $("#sync-auto").checked,
      reuseSecret: $("#sync-reuse").checked, remember: $("#sync-remember").checked });
    $("#sync-password").value = ""; await refresh(); notice("同步连接已应用，尚未上传资料。");
  } catch (e) { notice(e.message, true); }
});
$("#sync-alert").addEventListener("click", () => {
  openSettings("sync");
  requestAnimationFrame(() => $("#sync-conflicts").scrollIntoView({ block: "start" }));
});
for (const [id, path, code] of [
  ["sync-create", "create"], ["sync-pairing", "pairing"], ["sync-unlock", "unlock", true],
  ["sync-join", "join", true], ["sync-probe", "probe"], ["sync-run", "run"], ["sync-stop", "cancel"], ["sync-lock", "lock"], ["sync-remember-pair", "remember"]
]) {
  $(`#${id}`).addEventListener("click", async () => {
    const button = $(`#${id}`); if (button.disabled) return; button.disabled = true;
    try {
      if (id === "sync-join" && !confirm("将从服务端恢复同一位伴侣。只有空白新设备可以加入，确定继续吗？")) return;
      const result = await api(`/api/sync/${path}`, { ...(code ? { code: $("#sync-code").value.trim() } : {}), rememberPair: $("#pair-remember").checked });
      if (result.code) { $("#sync-code").value = result.code; notice("配对码已显示，请单独安全保管，它可以解密此空间的资料。"); }
      else if (id === "sync-probe") notice("服务通过读写、强 ETag 与条件写入检查。");
      else if (id === "sync-run") notice("本次同步完成，请检查是否有待解决的冲突。");
      if (["sync-unlock", "sync-join", "sync-lock"].includes(id)) $("#sync-code").value = "";
      await refresh(true);
    } catch (e) { notice(e.message, true); await refresh().catch(() => {}); }
    finally { button.disabled = false; }
  });
}
$("#forget-credentials").addEventListener("click", async () => {
  try { await api("/api/credentials/forget", { slot: "all" }); await refresh(); notice("本机保存的服务配置已清除，当前会话连接可继续使用。"); }
  catch (e) { notice(e.message, true); }
});
try {
  const session = await (await fetch("/api/session")).json(); state.token = session.token;
  await refresh(true);
  const restored = state.data.connections;
  const warnings = [...(restored?.warnings || [])];
  if (restored?.storage.saved.length && restored.storage.warning) warnings.push(restored.storage.warning);
  if (warnings.length) notice(warnings.join(" "), true);
  watchState(state.token, refresh);
  setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 15_000);
} catch (e) { notice(e.message || "无法连接本机服务，请重新启动 NIRIA。", true); }
