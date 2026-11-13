import { randomUUID } from "node:crypto";
import { buildContext } from "../core/chat-service.mjs";

export async function verifyMemoryLifecycle({ store, mainWindow }) {
  const original = store.snapshot(), beforeCalls = store.state.calls.length;
  const evaluate = (code) => mainWindow.webContents.executeJavaScript(code);
  const wait = async (code) => {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(code)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const result = {};
  try {
    store.settings({ autoMemory: true });
    const root = store.addUser("桌面遗忘测试：来源");
    const first = { ...root, id: randomUUID(), role: "assistant", content: "桌面遗忘测试：回复", replyTo: root.id };
    const second = { ...first, id: randomUUID(), content: "桌面遗忘测试：后续回复", replyTo: first.id };
    store.mutate((state) => { state.messages.push(second, first); });
    const id = store.addMemory({ content: "桌面遗忘测试：临时资料", expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      sources: [{ id: root.id, revision: 1 }] }, { automatic: true });
    store.addMemory({ content: "桌面遗忘测试：衍生资料甲", sources: [{ id: first.id, revision: 1 }] });
    store.addMemory({ content: "桌面遗忘测试：衍生资料乙", sources: [{ id: second.id, revision: 1 }] });
    const source = structuredClone(store.state.memories.find((item) => item.id === id).sources);
    await evaluate("document.querySelector('[data-view=\"memories\"]').click()");
    await wait(`!!document.querySelector('.memory-card[data-id="${id}"]')`);
    await evaluate(`[...document.querySelectorAll('.memory-card[data-id="${id}"] button')].find(button => button.textContent === '编辑').click()`);
    result.memoryEditFields = await evaluate("!document.querySelector('#edit-memory-fields').hidden && !document.querySelector('#edit-memory-permanent').checked");
    await evaluate("document.querySelector('#edit-memory-permanent').click(); document.querySelector('#edit-memory-kind').value = 'experience'; document.querySelector('#edit-form').requestSubmit()");
    result.memoryEditSaved = await wait(`!document.querySelector('#edit-dialog').open && !!document.querySelector('.memory-card[data-id="${id}"]')`);
    const memory = store.state.memories.find((item) => item.id === id);
    result.memoryMetadataPreservesSource = memory.expiresAt === null && memory.kind === "experience" &&
      !memory.confirmed && JSON.stringify(memory.sources) === JSON.stringify(source);
    await evaluate(`[...document.querySelectorAll('.memory-card[data-id="${id}"] button')].find(button => button.textContent === '编辑').click()`);
    await evaluate("document.querySelector('#edit-content').value = '桌面遗忘测试：手动纠正资料'; document.querySelector('#edit-form').requestSubmit()");
    result.memoryCorrectionSaved = await wait(`!document.querySelector('#edit-dialog').open && document.querySelector('.memory-card[data-id="${id}"] .memory-source summary')?.textContent.includes('原关联记录')`);
    const corrected = store.state.memories.find((item) => item.id === id);
    result.memoryCorrectionRetainsAssociation = corrected.sources.length === 0 && corrected.confirmed &&
      JSON.stringify(corrected.supersededSources) === JSON.stringify(source);
    result.memoryCorrectionExcludesOldContext = !buildContext(store.state).refs.messageRefs.some((item) => [root.id, first.id, second.id].includes(item.id));
    await evaluate(`document.querySelector('.memory-card[data-id="${id}"] .memory-source').open = true`);
    result.memoryCorrectionSourcesReadable = await wait(`document.querySelector('.memory-card[data-id="${id}"] .memory-source blockquote')?.textContent.includes('桌面遗忘测试：来源')`);
    await evaluate(`[...document.querySelectorAll('.memory-card[data-id="${id}"] button')].find(button => button.textContent === '忘记相关记录').click()`);
    result.forgetPreviewReady = await wait("document.querySelector('#forget-dialog').open && !document.querySelector('#forget-confirm').disabled");
    result.forgetCountsCorrect = await evaluate("document.querySelector('#forget-counts').textContent.includes('3 条记忆、1 条来源消息、2 条关联回复') && document.querySelector('#forget-list').children.length === 6");
    await evaluate("document.querySelector('[data-close=\"forget-dialog\"]').click()");
    result.forgetCancelPreserved = !store.state.memories.find((item) => item.id === id).deleted;
    await evaluate(`[...document.querySelectorAll('.memory-card[data-id="${id}"] button')].find(button => button.textContent === '忘记相关记录').click()`);
    await wait("!document.querySelector('#forget-confirm').disabled");
    await evaluate("document.querySelector('#forget-confirm').click()");
    result.forgetCommitted = await wait("!document.querySelector('#forget-dialog').open && !document.querySelector('#memory-list').textContent.includes('桌面遗忘测试')");
    result.forgetErasedDerivatives = !JSON.stringify(store.snapshot()).includes("桌面遗忘测试");
    result.noLifecycleModelCalls = store.state.calls.length === beforeCalls;
    return result;
  } finally {
    store.mutate(() => { store.state = original; });
    await evaluate("document.querySelector('#forget-dialog').close(); document.querySelector('#edit-dialog').close(); document.querySelector('[data-view=\"chat\"]').click()");
  }
}
