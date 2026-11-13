export function memoryBrowser({ api, refresh, renderMemory }) {
  const $ = (selector) => document.querySelector(selector);
  const list = $("#memory-list"), status = $("#memory-status");
  let summary = null, visible = false, page = null, controller = null, sequence = 0, loading = false, targetAnchor = "", expiry = null;
  const anchor = () => page?.memories[0]?.id || targetAnchor;
  function controls() {
    $("#memory-older").disabled = loading || !page?.olderCursor;
    $("#memory-newer").disabled = loading || !page?.newerCursor;
    $("#memory-latest").disabled = loading;
  }
  function clear() {
    ++sequence;
    controller?.abort();
    clearTimeout(expiry);
    page = null;
    list.replaceChildren();
    controls();
  }
  function scheduleExpiry(value) {
    clearTimeout(expiry);
    if (visible && value?.nextExpiry != null) expiry = setTimeout(() => refresh().catch(() => {}),
      Math.min(2_147_483_647, Math.max(1, value.nextExpiry - Date.now())));
  }
  async function load({ cursor = "", anchor: selected = "" } = {}) {
    clear();
    if (!visible || !summary) return;
    controller = new AbortController();
    const request = sequence;
    targetAnchor = selected;
    loading = true;
    controls();
    status.textContent = "正在读取本机记忆…";
    const parameters = new URLSearchParams({ q: $("#memory-filter").value.trim(), status: $("#memory-state").value, kind: $("#memory-kind").value });
    if (cursor) parameters.set("cursor", cursor);
    if (selected) parameters.set("anchor", selected);
    try {
      const result = await api(`/api/memories?${parameters}`, undefined, { signal: controller.signal });
      if (request !== sequence || !visible) return;
      if (result.revision !== summary.revision) {
        await refresh();
        if (request === sequence && visible) return load({ anchor: selected });
        return;
      }
      page = result;
      targetAnchor = "";
      loading = false;
      $("#memory-count").textContent = `${page.totalMatches}${page.totalMatches === page.total ? "" : ` / ${page.total}`} 条`;
      status.textContent = `当前显示 ${page.memories.length} 条 · 最近添加的记忆在前 · 搜索只在本机进行`;
      for (const memory of page.memories) list.append(renderMemory(memory, page.states[memory.id]));
      if (!page.memories.length) {
        const empty = document.createElement("div"); empty.className = "empty-chat";
        const title = document.createElement("h3"), text = document.createElement("p");
        title.textContent = page.total ? "这个范围里还没有找到" : "慢慢积累，不急着填满";
        text.textContent = page.total ? "试试其他文字、类型或状态，或者回到全部记忆。" : "聊天后整理的记忆会出现在这里，也可以直接添加希望被记住的事。";
        empty.append(title, text); list.append(empty);
      }
      list.scrollTop = 0;
      controls();
      scheduleExpiry(page);
    } catch (error) {
      if (request !== sequence || !visible || error.name === "AbortError") return;
      if ((error.status === 404 && selected) || error.status === 409) {
        await refresh();
        if (request === sequence && visible) return load();
        return;
      }
      loading = false;
      status.textContent = error.message || "记忆暂时无法读取，请点击回到最近重试。";
      controls();
    }
  }
  for (const [id, event] of [["memory-filter", "input"], ["memory-state", "change"], ["memory-kind", "change"]]) {
    $(`#${id}`).addEventListener(event, () => load());
  }
  $("#memory-clear").addEventListener("click", () => {
    $("#memory-filter").value = "";
    $("#memory-state").value = $("#memory-kind").value = "all";
    load();
  });
  $("#memory-older").addEventListener("click", () => page?.olderCursor && load({ cursor: page.olderCursor }));
  $("#memory-newer").addEventListener("click", () => page?.newerCursor && load({ cursor: page.newerCursor }));
  $("#memory-latest").addEventListener("click", () => load());
  return {
    latest() { return load(); },
    update(next, active) {
      const changed = next?.revision !== summary?.revision, wasVisible = visible,
        currentAnchor = page?.newerCursor === null ? "" : anchor();
      summary = next;
      visible = active;
      if (!active) {
        if (wasVisible) { clear(); targetAnchor = currentAnchor; loading = false; status.textContent = ""; }
        return;
      }
      if (!wasVisible || changed) load({ anchor: currentAnchor });
    }
  };
}
