export function contextReviewBasis(data, draft = "") {
  return JSON.stringify([data?.identity, data?.memoryWindow?.revision, data?.messageWindow?.revision,
    data?.settings?.allowModel, data?.connections?.chat?.connectionId,
    data?.service?.connected, data?.service?.baseUrl, data?.service?.model, data?.avatarKey, draft]);
}

export function contextReview({ api, refresh, data, draft }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#context-dialog"), area = $("#context-content");
  let mode = null, controller = null, sequence = 0, basis = "", expiry = null, debounce = null;
  const element = (tag, content, className = "") => {
    const node = document.createElement(tag);
    node.textContent = content; node.className = className;
    return node;
  };
  const currentBasis = () => mode?.kind === "draft" ? contextReviewBasis(data(), draft()) :
    JSON.stringify([data()?.memoryWindow?.revision, data()?.messageWindow?.revision]);
  function invalidate(message = "") {
    ++sequence;
    controller?.abort();
    clearTimeout(expiry); clearTimeout(debounce);
    expiry = debounce = null; controller = null;
    area.replaceChildren();
    area.setAttribute("aria-busy", String(!!message));
    if (message) area.append(element("p", message, "hint"));
  }
  function scheduleExpiry() {
    const deadline = data()?.memoryWindow?.nextExpiry;
    if (deadline == null) return;
    expiry = setTimeout(async () => {
      invalidate("记忆期限已到，正在重新核对发送范围…");
      const request = sequence;
      try {
        await refresh();
        if (request === sequence && mode && dialog.open) await load();
      } catch {
        if (request === sequence && mode && dialog.open) {
          area.textContent = "暂时无法重新核对，旧内容已清空。请点击重新核对。";
          area.setAttribute("aria-busy", "false");
        }
      }
    }, Math.min(2_147_483_647, Math.max(1, deadline - Date.now())));
  }
  function renderMemories(memories, empty) {
    const list = document.createElement("ul");
    for (const memory of memories) {
      const item = element("li", memory.content);
      if (memory.reason) item.append(element("small",
        { related: "话题相关", confirmed: "已确认资料", recent: "近期线索" }[memory.reason] || "", "recall-reason"));
      list.append(item);
    }
    if (!memories.length) list.append(element("li", empty));
    area.append(list);
  }
  async function load() {
    if (!mode) return;
    invalidate(mode.kind === "draft" ? "正在本机核对下一次发送范围…" : "正在读取本机引用…");
    const request = sequence, selected = mode, capturedDraft = draft();
    basis = currentBasis();
    controller = new AbortController();
    const signal = controller.signal;
    dialog.querySelector("h2").textContent = selected.kind === "draft" ? "下一次发送范围" : "这条回复的引用";
    if (!dialog.open) dialog.showModal();
    try {
      const context = selected.kind === "draft"
        ? await api("/api/context/preview", { draft: capturedDraft }, { signal })
        : await api("/api/memories/references", { id: selected.message.id,
          revision: selected.message.revision, expected: selected.message.context }, { signal });
      if (request !== sequence || !dialog.open) return;
      if (basis !== currentBasis()) return load();
      if ((selected.kind === "draft" && context.previewBasis !== basis) ||
          (context.validUntil != null && Date.now() >= context.validUntil)) {
        // The server may have observed a change before this window received its
        // invalidation event. Refresh first; never briefly display the old body.
        await refresh();
        if (request === sequence && dialog.open) return load();
        return;
      }
      area.replaceChildren();
      if (selected.kind === "draft") {
        const service = data().service;
        area.append(element("p", service.connected
          ? `当前对话模型：${service.model} · ${new URL(service.baseUrl).host}`
          : "对话服务尚未配置，当前仅预览本机资料。"));
        area.append(element("p", `按当前输入的话题，下一次聊天会发送：伴侣核心设定、${context.refs.messageRefs.length} 条近期消息，以及 ${context.refs.memoryRefs.length} 条有效记忆。${context.draftIncluded
          ? "当前草稿会作为一条新消息发送给配置的对话服务。"
          : "尚未输入正文；输入后会重新选择发送范围。"}记忆检索在本地进行。`));
        area.append(element("h3", "会引用的记忆"));
        renderMemories(context.memoryPreview, "暂无可发送的长期记忆。");
        area.append(element("p", "开启自动记忆后，另一个请求只发送刚刚的用户消息，用于整理待确认记忆。连接测试只发送测试短句。", "hint"));
      } else {
        const refs = selected.message.context;
        area.append(element("p", `这条回复使用模型 ${refs.model}，角色设定版本 ${refs.personaRevision}，引用 ${refs.messageRefs.length} 条近期消息。`));
        area.append(element("h3", `实际引用的记忆（${refs.memoryRefs.length}）`));
        renderMemories(context.memories, "未引用长期记忆。");
      }
      area.setAttribute("aria-busy", "false");
      scheduleExpiry();
    } catch (error) {
      if (request !== sequence || !dialog.open || error.name === "AbortError") return;
      area.textContent = error.message || "发送范围暂时无法核对，请点击重新核对。";
      area.setAttribute("aria-busy", "false");
    }
  }
  function stop() { mode = null; basis = ""; invalidate(); }
  $("#context-refresh").addEventListener("click", load);
  dialog.querySelector('[data-close="context-dialog"]').addEventListener("click", stop);
  dialog.addEventListener("cancel", stop);
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    stop();
  });
  window.addEventListener("pagehide", stop, { once: true });
  return {
    draft() { mode = { kind: "draft" }; return load(); },
    used(message) { mode = { kind: "used", message: structuredClone(message) }; return load(); },
    update() { if (mode && dialog.open && basis !== currentBasis()) return load(); },
    draftChanged() {
      if (mode?.kind !== "draft" || !dialog.open) return;
      invalidate("输入已改变，正在重新核对发送范围…");
      debounce = setTimeout(() => { if (dialog.open && mode?.kind === "draft") load(); }, 160);
    }
  };
}
