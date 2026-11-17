import assert from "node:assert/strict";
import { once } from "node:events";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { readRealLive2D } from "./live2d-real-smoke.mjs";

const wait = async (evaluate, condition) => {
  for (let index = 0; index < 300; index++) {
    if (await evaluate(condition)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Profile condition failed: ${condition}\n${await evaluate("document.querySelector('#profile-status')?.textContent + ' / ' + document.querySelector('#notice')?.textContent")}`);
};
export async function verifyProfiles({ evaluate, navigate, capture = async () => {}, realModelDirectory }) {
  const store = new CompanionStore(), requests = [], checks = {};
  const originalName = store.state.identity.name;
  store.identity({ userName: "不应改掉的用户称呼" });
  store.addUser("不应发送的已有聊天");
  store.addMemory({ content: "不应发送的已有记忆" });
  let mode = "normal", release;
  const result = { name: "<b>月见</b>", persona: "根据描述整理的性格与背景。", style: "自然、简洁。", relationship: "正在彼此了解。" };
  const companion = new CompanionService(store, { completion: async (_, messages, { signal }) => {
    requests.push(structuredClone(messages));
    if (mode === "hold") return new Promise((resolve) => { release = (value = JSON.stringify(result)) => resolve(value); });
    if (mode === "bad") return "not a profile";
    if (signal.aborted) throw new Error("isolated abort");
    return JSON.stringify(result);
  } });
  companion.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "synthetic-profile-model" });
  const server = createPrototypeServer({ store, companion });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const open = async (source = "text") => {
    await evaluate(`document.querySelector('#open-settings').click();document.querySelector('[data-tab="identity"]').click();
      document.querySelector(${JSON.stringify(source === "text" ? "#profile-from-text" : "#profile-from-avatar")}).click()`);
    await wait(evaluate, "document.querySelector('#profile-dialog').open");
  };
  const describe = (value = "月见，喜欢观星，坦诚而有幽默感。".repeat(300)) => evaluate(`(() => {
    const input=document.querySelector('#profile-description');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input'));
  })()`);
  const generate = () => evaluate("document.querySelector('#profile-generate').click()");
  const ready = () => wait(evaluate, "!document.querySelector('#profile-result').hidden && !document.querySelector('#profile-apply').disabled");
  const close = () => evaluate("document.querySelector('#profile-dialog [data-close]').click()");
  try {
    await navigate(`http://127.0.0.1:${server.address().port}`);
    await wait(evaluate, "document.querySelector('#calls-list')?.children.length>0");
    await open();
    await evaluate("document.querySelector('#identity-user').value='尚未保存的用户称呼'");
    checks.profileImportEntryAvailableInSettings = await evaluate("document.querySelector('#identity-import-live2d').textContent.includes('Live2D') && document.querySelector('#identity-import-image').textContent.includes('图片')");
    await describe(); await generate(); await ready();
    checks.profileLongTextIsStructuredWithoutHistory = requests.length === 1 &&
      requests[0][1].content.length > 4000 && !JSON.stringify(requests[0]).includes("不应发送");
    checks.profileDraftDoesNotChangeIdentity = store.state.identity.name === originalName &&
      store.state.messages.length === 1 && store.state.memories.length === 1;
    checks.profileDraftIsSafelyEditable = await evaluate("document.querySelector('#profile-name').value==='<b>月见</b>' && !document.querySelector('#profile-result b')");
    await capture();
    await evaluate("document.querySelector('#profile-name').value='用户改名后的月见';document.querySelector('#profile-apply').click()");
    await wait(evaluate, "!document.querySelector('#profile-dialog').open && document.querySelector('#companion-name').textContent==='用户改名后的月见'");
    checks.profileConfirmedEditsAreApplied = store.state.identity.name === "用户改名后的月见";
    checks.profileApplyKeepsOtherUnsavedSettings = await evaluate("document.querySelector('#settings-dialog').open && document.querySelector('#identity-user').value==='尚未保存的用户称呼'");
    checks.profileApplyPreservesUsernameAndHistory = store.state.identity.userName === "不应改掉的用户称呼" &&
      store.state.messages.length === 1 && store.state.memories.length === 1;
    await evaluate("document.querySelector('[data-close=\"settings-dialog\"]').click()");
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const avatar = { format: "niria-avatar-prototype", version: 1, source: image, actions: {} };
    const beforeImport = requests.length;
    await evaluate(`(() => {
      const file=new File([JSON.stringify(${JSON.stringify(avatar)})],'profile-fixture.json',{type:'application/json'});
      const files=new DataTransfer();files.items.add(file);document.querySelector('#avatar-package').files=files.files;
      document.querySelector('#avatar-package').dispatchEvent(new Event('change'));
    })()`);
    await wait(evaluate, "!document.querySelector('#avatar-profile-offer').hidden && !document.querySelector('#avatar-canvas').hidden");
    checks.profileImportOffersGenerationWithoutAutomaticCharge = requests.length === beforeImport;
    await evaluate("document.querySelector('#avatar-profile-create').click()");
    await generate(); await ready();
    checks.profileImageUsesOnlyCurrentSnapshot = requests.at(-1)[1].content[1].image_url.url.startsWith("data:image/png;base64,") &&
      !JSON.stringify(requests.at(-1)).includes("不应发送");
    checks.profileImageDisclosureIsVisible = await evaluate("document.querySelector('#profile-source-note').textContent.includes('截图') && !document.querySelector('#profile-image').hidden");
    const importedKey = store.avatarKey;
    await close();
    checks.profileCanceledPreviewKeepsImportedAvatar = store.avatarKey === importedKey && store.state.identity.name === "用户改名后的月见";

    if (realModelDirectory) {
      const bundle = await readRealLive2D(realModelDirectory);
      store.mutate((state) => { state.avatar = { format: "niria-live2d-avatar", version: 1, package: bundle,
        bindings: { idleGroup: "Idle", expressions: {} } }; });
      await navigate(`http://127.0.0.1:${server.address().port}`);
      await wait(evaluate, "document.querySelector('#calls-list')?.children.length>0");
      await wait(evaluate, "document.querySelector('#avatar-canvas').dataset.expression==='neutral' && !document.querySelector('#avatar-canvas').hidden");
      await open("avatar"); await generate(); await ready();
      const request = JSON.stringify(requests.at(-1));
      checks.profileLive2DUsesRenderedImage = requests.at(-1)[1].content[1].image_url.url.length > 1000 &&
        !request.includes(".moc3") && !request.includes("FileReferences") && !request.includes(".model3.json");
      await close();
    }
    for (const reason of ["close", "stop", "description", "identity"]) {
      mode = "hold"; await open(); await describe("新的待整理描述"); await generate();
      await wait(evaluate, "!document.querySelector('#profile-stop').hidden");
      for (let index = 0; index < 200 && !release; index++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(typeof release, "function");
      if (reason === "close") await close();
      if (reason === "stop") await evaluate("document.querySelector('#profile-stop').click()");
      if (reason === "description") await describe("请求期间用户换了一份人物描述");
      if (reason === "identity") store.identity({ name: "另一窗口修改的资料" });
      release(); release = null;
      await wait(evaluate, "document.querySelector('#profile-result').hidden");
      // Wait for the uncancelable completion and refresh to finish.
      for (let index = 0; index < 200 && companion.active; index++) await new Promise((resolve) => setTimeout(resolve, 10));
      await evaluate("new Promise(resolve=>setTimeout(resolve,30))");
      checks[`profileLateDraftDiscardedAfter${reason}`] = await evaluate("document.querySelector('#profile-result').hidden && document.querySelector('#profile-apply').disabled");
      if (reason !== "close") await close();
    }
    mode = "bad"; await open(); await describe(); await generate();
    await wait(evaluate, "document.querySelector('#profile-status').textContent.includes('完整有效')");
    checks.profileInvalidModelOutputKeepsExistingProfile = store.state.identity.name === "另一窗口修改的资料";
    await close();
    mode = "normal"; await open(); await describe(); await generate(); await ready();
    await describe("编辑描述后，先前草稿不可直接采用");
    checks.profileInputChangesInvalidateReviewedDraft = await evaluate("document.querySelector('#profile-result').hidden && document.querySelector('#profile-apply').disabled");
    await close();
    checks.profileCallsAreLabeledAndNoChatAdded = await evaluate("document.querySelector('#calls-list').textContent.includes('资料生成')") &&
      store.state.messages.length === 1;
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    return checks;
  } finally {
    release?.();
    try {
      await navigate("/");
      await wait(evaluate, "document.querySelector('#calls-list')?.children.length>0");
    } finally {
      companion.cancel();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      server.connections.services.sync.lock(); store.close();
    }
  }
}
