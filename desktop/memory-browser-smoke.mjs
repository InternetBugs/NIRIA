import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildContext } from "../core/chat-service.mjs";

export async function verifyMemoryBrowsing({ store, evaluate, capture }) {
  const original = store.snapshot(), beforeCalls = store.state.calls.length, result = {};
  const wait = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(code)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Memory browser condition failed: ${code}`);
  };
  const at = new Date().toISOString();
  const records = Array.from({ length: 247 }, (_, index) => ({
    id: randomUUID(), content: index ? `隔离浏览：第 ${String(index).padStart(3, "0")} 件记忆` :
      "隔离浏览：早年的栗子生日 <img src=x onerror=window.__memoryXss=1>",
    kind: ["fact", "experience", "inference"][index % 3], sources: [], expiresAt: null,
    confirmed: index % 2 === 0, allowModel: null, allowSync: null, deleted: false, invalidated: index === 3,
    revision: 1, createdAt: at, updatedAt: at
  }));
  const filter = async (query, status = "all", kind = "all") => {
    await evaluate(`(() => {
      document.querySelector('#memory-filter').value = ${JSON.stringify(query)};
      document.querySelector('#memory-state').value = ${JSON.stringify(status)};
      document.querySelector('#memory-kind').value = ${JSON.stringify(kind)};
      document.querySelector('#memory-filter').dispatchEvent(new Event('input'));
    })()`);
  };
  const first = (index) => `document.querySelector('#memory-list .memory-card')?.dataset.id === ${JSON.stringify(records[index].id)}`;
  try {
    await evaluate(`(() => {
      window.__memoryOriginalFetch = window.fetch;
      window.__memoryReads = [];
      window.__memoryReleases = [];
      window.__memoryHoldRefs = false;
      window.fetch = async (...args) => {
        const url = new URL(String(args[0]), location.href), response = await window.__memoryOriginalFetch(...args);
        if (url.pathname === '/api/state') {
          const state = await response.clone().json();
          window.__memoryReads.push({ mode: url.searchParams.get('memories'), full: Object.hasOwn(state, 'memories') });
        }
        if ((url.pathname === '/api/memories' && url.searchParams.get('q') === '延迟记忆') ||
          (url.pathname === '/api/memories/references' && window.__memoryHoldRefs)) {
          await new Promise(resolve => window.__memoryReleases.push(resolve));
        }
        return response;
      };
    })()`);
    store.mutate((state) => { state.memories = records; });
    const context = { ...buildContext(store.state, { query: "早年的栗子生日" }).refs, model: "isolated-memory-browse" };
    const reply = { id: randomUUID(), role: "assistant", content: "隔离浏览：记得这件早年的小事", context,
      revision: 1, deleted: false, status: "completed", createdAt: at, updatedAt: at };
    store.mutate((state) => { state.messages = [reply]; });
    await evaluate("document.querySelector('[data-view=\"memories\"]').click()");
    await wait(`${first(246)} && document.querySelectorAll('#memory-list .memory-card').length === 60`);
    result.memoryPageLimited = true;
    await wait("window.__memoryReads.length > 0");
    result.memoryReadsCompact = await evaluate("window.__memoryReads.length > 0 && window.__memoryReads.every(read => read.mode === 'none' && !read.full)");
    await evaluate("document.querySelector('#memory-older').click()");
    await wait(first(186));
    await evaluate("document.querySelector('#memory-newer').click()");
    await wait(first(246));
    await evaluate("document.querySelector('#memory-older').click()");
    await wait(first(186));
    result.memoryBothDirections = true;
    await evaluate(`[...document.querySelectorAll('.memory-card[data-id="${records[186].id}"] button')].find(button => button.textContent === '编辑').click()`);
    await evaluate("document.querySelector('#edit-content').value = '隔离浏览：纠正后仍留在较早的一页'; document.querySelector('#edit-form').requestSubmit()");
    await wait(`!document.querySelector('#edit-dialog').open && ${first(186)} && document.querySelector('#memory-list').textContent.includes('纠正后仍留在')`);
    result.memoryOlderEditKeepsPage = true;
    store.deleteMemory(records[186].id);
    await wait(first(246));
    result.memoryDeletedAnchorReturnsLatest = true;
    await filter("栗子生日");
    await wait(`document.querySelectorAll('#memory-list .memory-card').length === 1 && ${first(0)}`);
    result.memoryLiteralTextSafe = await evaluate("!window.__memoryXss && !document.querySelector('#memory-list img')");
    await filter("", "pending", "experience");
    const expected = records.filter((memory) => !memory.confirmed && memory.kind === "experience" && !memory.invalidated).length;
    await wait(`document.querySelector('#memory-count').textContent.startsWith('${expected} /') && document.querySelectorAll('#memory-list .memory-card').length === ${expected}`);
    result.memoryCombinedFilters = true;
    await filter("", "inactive");
    await wait(`document.querySelectorAll('#memory-list .memory-card').length === 1 && ${first(3)}`);
    result.memoryInactiveFilter = true;
    await filter("延迟记忆");
    await wait("window.__memoryReleases.length === 1");
    await filter("第 021 件");
    await wait(`document.querySelectorAll('#memory-list .memory-card').length === 1 && ${first(21)}`);
    await evaluate("window.__memoryReleases.splice(0).forEach(resolve => resolve())");
    await evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    result.memoryLateSearchIgnored = await evaluate(first(21));
    if (capture) await capture();
    await filter("延迟记忆");
    await wait("window.__memoryReleases.length === 1");
    await evaluate("document.querySelector('[data-view=\"chat\"]').click(); window.__memoryReleases.splice(0).forEach(resolve => resolve())");
    await evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    result.memoryHiddenClearsResults = await evaluate("document.querySelector('#memory-list').children.length === 0");
    await wait(`!!document.querySelector('.message[data-id="${reply.id}"]')`);
    const openRefs = `[...document.querySelectorAll('.message[data-id="${reply.id}"] button')].find(button => button.textContent === '引用的记忆').click()`;
    await evaluate(`window.__memoryHoldRefs = true; ${openRefs}`);
    await wait("window.__memoryReleases.length === 1");
    await evaluate("document.querySelector('[data-close=\"context-dialog\"]').click(); window.__memoryHoldRefs = false; window.__memoryReleases.splice(0).forEach(resolve => resolve())");
    result.memoryClosedReferenceClears = await wait("document.querySelector('#context-content').children.length === 0");
    await evaluate(openRefs);
    await wait("document.querySelector('#context-content li')?.textContent.includes('栗子生日')");
    result.memoryOldReferenceReadable = await evaluate("!document.querySelector('#context-content img') && !window.__memoryXss");
    store.mutate((state) => { state.memories[0].content = "隔离浏览：同修订的新正文"; });
    await wait("document.querySelector('#context-content').textContent.includes('旧正文不再展示') && !document.querySelector('#context-content').textContent.includes('栗子生日')");
    result.memoryStaleReferenceWithheld = true;
    await evaluate("document.querySelector('[data-close=\"context-dialog\"]').click()");
    const expiresAt = new Date(Date.now() + 1400).toISOString();
    const expiring = store.addMemory({ content: "隔离浏览：即将到期的引用", expiresAt });
    const expiringReply = { ...reply, id: randomUUID(),
      context: { ...buildContext(store.state, { query: "即将到期的引用" }).refs, model: "isolated-memory-expiry" } };
    store.mutate((state) => { state.messages.push(expiringReply); });
    await wait(`!!document.querySelector('.message[data-id="${expiringReply.id}"]')`);
    await evaluate(`[...document.querySelectorAll('.message[data-id="${expiringReply.id}"] button')].find(button => button.textContent === '引用的记忆').click()`);
    await wait("document.querySelector('#context-content li')?.textContent.includes('即将到期的引用')");
    const writes = store.db.prepare("SELECT total_changes() AS n").get().n;
    await wait("document.querySelector('#context-content li')?.textContent.includes('旧正文不再展示')");
    result.memoryReferenceExpiryRefreshes = store.db.prepare("SELECT total_changes() AS n").get().n === writes;
    await evaluate("document.querySelector('[data-close=\"context-dialog\"]').click(); document.querySelector('[data-view=\"memories\"]').click()");
    await filter("即将到期的引用", "confirmed");
    await wait("document.querySelector('#memory-count').textContent.startsWith('0 /')");
    store.mutate((state) => { state.memories.find((memory) => memory.id === expiring).expiresAt = new Date(Date.now() + 1200).toISOString(); });
    await wait("document.querySelectorAll('#memory-list .memory-card').length === 1");
    await wait("document.querySelector('#memory-count').textContent.startsWith('0 /') && !document.querySelector('#memory-list .memory-card')");
    result.memoryFilterExpiryRefreshes = true;
    result.noBrowseModelCalls = store.state.calls.length === beforeCalls;
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    await evaluate(`(() => {
      window.__memoryReleases.splice(0).forEach(resolve => resolve());
      window.fetch = window.__memoryOriginalFetch;
      document.querySelector('#context-dialog').close();
      document.querySelector('#edit-dialog').close();
      document.querySelector('[data-view="chat"]').click();
      document.querySelector('#memory-clear').click();
    })()`);
    store.mutate(() => { store.state = original; });
  }
}
