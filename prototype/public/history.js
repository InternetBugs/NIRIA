export function chatHistory({ api, refresh, renderMessage }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#history-dialog"), results = $("#history-results"), status = $("#history-status");
  let page = null, revision = null, query = "", targetAnchor = "", controller = null, sequence = 0, loading = false;
  function controls() {
    $("#history-older").disabled = loading || !page?.olderCursor;
    $("#history-newer").disabled = loading || !page?.newerCursor;
    $("#history-latest").disabled = loading;
  }
  function visibleAnchor() {
    const top = results.getBoundingClientRect().top;
    return [...results.querySelectorAll(".message")].find((item) => item.getBoundingClientRect().bottom > top)?.dataset.id || "";
  }
  function draw(anchor = "", offset = 0) {
    const oldTop = results.scrollTop;
    results.replaceChildren();
    for (const message of page.messages) {
      const article = renderMessage(message, true);
      if (message.id === anchor) {
        article.classList.add("history-anchor");
        article.setAttribute("aria-current", "true");
      }
      results.append(article);
    }
    if (!page.messages.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = query ? "没有找到这些文字。试试聊天中出现过的词句。" : "还没有聊天记录。";
      results.append(empty);
    }
    const selected = [...results.querySelectorAll(".message")].find((item) => item.dataset.id === anchor);
    results.scrollTop = selected ? selected.getBoundingClientRect().top - results.getBoundingClientRect().top + results.scrollTop - offset : oldTop;
  }
  async function load({ nextQuery = query, cursor = "", anchor = "", offset = 0 } = {}) {
    controller?.abort();
    controller = new AbortController();
    const request = ++sequence;
    query = nextQuery;
    targetAnchor = anchor;
    page = null;
    loading = true;
    results.replaceChildren();
    status.textContent = "正在读取本机聊天记录…";
    controls();
    const parameters = new URLSearchParams({ q: query });
    if (cursor) parameters.set("cursor", cursor);
    if (anchor) parameters.set("anchor", anchor);
    try {
      const result = await api(`/api/messages?${parameters}`, undefined, { signal: controller.signal });
      if (request !== sequence || !dialog.open) return;
      if (result.revision !== revision) {
        await refresh();
        if (request === sequence && dialog.open) return load({ anchor, offset });
        return;
      }
      page = result;
      loading = false;
      targetAnchor = "";
      status.textContent = query
        ? `找到 ${page.totalMatches} 条，当前显示 ${page.messages.length} 条 · 按聊天顺序排列`
        : `共 ${page.total} 条，当前显示 ${page.messages.length} 条 · 按聊天顺序排列`;
      draw(anchor, offset);
      if (!anchor) results.scrollTop = cursor ? 0 : results.scrollHeight;
      controls();
    } catch (error) {
      if (request !== sequence || !dialog.open || error.name === "AbortError") return;
      if ((error.status === 404 && anchor) || error.status === 409) return load({ anchor: error.status === 404 ? "" : anchor, offset });
      loading = false;
      status.textContent = error.message || "暂时无法读取聊天，请点击「回到最近」重试。";
      controls();
    }
  }
  function open(anchor = "") {
    $("#history-query").value = "";
    query = "";
    if (!dialog.open) dialog.showModal();
    return load({ anchor });
  }
  $("#open-history").addEventListener("click", () => open());
  $("#history-search").addEventListener("submit", (event) => {
    event.preventDefault();
    load({ nextQuery: $("#history-query").value.trim() });
  });
  $("#history-clear").addEventListener("click", () => {
    $("#history-query").value = "";
    load({ nextQuery: "" });
    $("#history-query").focus();
  });
  $("#history-older").addEventListener("click", () => page?.olderCursor && load({ cursor: page.olderCursor }));
  $("#history-newer").addEventListener("click", () => page?.newerCursor && load({ cursor: page.newerCursor }));
  $("#history-latest").addEventListener("click", () => load());
  dialog.addEventListener("close", () => {
    ++sequence;
    controller?.abort();
    controller = null;
    page = null;
    query = targetAnchor = "";
    $("#history-query").value = "";
    results.replaceChildren();
    status.textContent = "";
  });
  return {
    open,
    update(summary) {
      const changed = summary?.revision !== revision;
      revision = summary?.revision || null;
      if (!dialog.open) return;
      if (changed) {
        const anchor = visibleAnchor() || targetAnchor;
        const node = [...results.querySelectorAll(".message")].find((item) => item.dataset.id === anchor);
        const offset = node ? node.getBoundingClientRect().top - results.getBoundingClientRect().top : 0;
        load({ anchor, offset });
      } else if (page) {
        const anchor = visibleAnchor();
        const node = [...results.querySelectorAll(".message")].find((item) => item.dataset.id === anchor);
        draw(anchor, node ? node.getBoundingClientRect().top - results.getBoundingClientRect().top : 0);
      }
    }
  };
}
