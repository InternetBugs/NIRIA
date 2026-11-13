import { randomUUID } from "node:crypto";

export async function verifyHistory({ store, mainWindow, widget }) {
  const evaluate = (code) => mainWindow.webContents.executeJavaScript(code);
  const wait = async (code) => {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(code)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const original = store.snapshot(), beforeCalls = store.state.calls.length;
  const messages = Array.from({ length: 241 }, (_, index) => {
    const at = new Date(Date.now() - (241 - index) * 1000).toISOString();
    return { id: randomUUID(), role: index % 2 ? "assistant" : "user",
      content: index === 0 ? "桌面历史测试：早年的散步" : `桌面历史测试 ${index}`,
      revision: 1, deleted: false, status: "completed", createdAt: at, updatedAt: at };
  });
  const result = {};
  try {
    await evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.__nativeHistoryReads = [];
      window.fetch = async (...args) => {
        const url = new URL(String(args[0]), location.href);
        const response = await original(...args);
        if (url.pathname === "/api/state") window.__nativeHistoryReads.push({
          messages: url.searchParams.get("messages"), memories: url.searchParams.get("memories"),
          full: Object.hasOwn(await response.clone().json(), "memories")
        });
        return response;
      };
    })()`);
    await widget.webContents.executeJavaScript(`(() => {
      const original = window.fetch.bind(window);
      window.__nativeHistoryReads = [];
      window.fetch = async (...args) => {
        const url = new URL(String(args[0]), location.href);
        const response = await original(...args);
        if (url.pathname === "/api/state") window.__nativeHistoryReads.push({
          messages: url.searchParams.get("messages"), memories: url.searchParams.get("memories"),
          full: Object.hasOwn(await response.clone().json(), "memories")
        });
        return response;
      };
    })()`);
    store.mutate((state) => { state.messages = messages; });
    const memory = store.addMemory({ content: "桌面测试的早期记忆", sources: [{ id: messages[0].id, revision: 1 }] });
    result.recentChat = await wait("document.querySelectorAll('#messages .message').length === 120 && !document.querySelector('#messages').textContent.includes('早年的散步')");
    await evaluate("document.querySelector('#open-history').click()");
    result.historyPage = await wait("document.querySelectorAll('#history-results .message').length === 60");
    await evaluate("document.querySelector('#history-older').click()");
    result.olderPage = await wait(`document.querySelector('#history-results .message')?.dataset.id === ${JSON.stringify(messages[121].id)}`);
    await evaluate("document.querySelector('#history-query').value = '早年的散步'; document.querySelector('#history-search').requestSubmit()");
    result.localSearch = await wait("document.querySelectorAll('#history-results .message').length === 1 && document.querySelector('#history-results').textContent.includes('早年的散步')");
    store.deleteMessage(messages[0].id);
    result.deletedSearchClears = await wait("document.querySelector('#history-status').textContent.includes('找到 0 条') && !document.querySelector('#history-results').textContent.includes('早年的散步')");
    await evaluate("document.querySelector('[data-close=\"history-dialog\"]').click(); document.querySelector('[data-view=\"memories\"]').click()");
    await wait(`!!document.querySelector('.memory-card[data-id="${memory}"] details')`);
    await evaluate(`document.querySelector('.memory-card[data-id="${memory}"] details').open = true`);
    result.withdrawnSource = await wait("document.querySelector('.memory-source blockquote')?.textContent.includes('来源已修改')");
    const validMemory = store.addMemory({ content: "另一条旧来源", sources: [{ id: messages[2].id, revision: 1 }] });
    await wait(`!!document.querySelector('.memory-card[data-id="${validMemory}"]')`);
    await evaluate(`document.querySelector('.memory-card[data-id="${validMemory}"] details').open = true`);
    result.olderSource = await wait(`document.querySelector('.memory-card[data-id="${validMemory}"] blockquote')?.textContent.includes('桌面历史测试 2')`);
    const compactReads = "window.__nativeHistoryReads.length > 0 && window.__nativeHistoryReads.every(value => value.messages === 'recent' && value.memories === 'none' && !value.full)";
    result.mainCompactReads = await evaluate(compactReads);
    result.widgetCompactReads = await widget.webContents.executeJavaScript(compactReads);
    result.noHistoryModelCalls = store.state.calls.length === beforeCalls;
    return result;
  } finally {
    store.mutate(() => { store.state = original; });
    await evaluate("document.querySelector('#history-dialog').close(); document.querySelector('[data-view=\"chat\"]').click()");
  }
}
