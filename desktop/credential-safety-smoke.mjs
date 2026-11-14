import assert from "node:assert/strict";
import { once } from "node:events";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { CredentialVault } from "../core/credential-vault.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const wait = async (evaluate, condition) => {
  for (let index = 0; index < 200; index++) {
    if (await evaluate(condition)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Credential fallback condition failed: ${condition}`);
};

// Called only on isolated smoke pages: a dedicated in-memory server for the
// browser, or a synthetic artifact directory for native corrupt-file startup.
export async function verifyCredentialFallback(evaluate) {
  const checks = {}, secret = "isolated-fallback-session-key";
  const state = () => evaluate(`(async()=>{
    const {token}=await(await fetch('/api/session')).json();
    return (await fetch('/api/state?messages=recent&memories=none',{headers:{'X-Niria-Token':token}})).json();
  })()`);
  const post = (path, body) => evaluate(`(async()=>{
    const {token}=await(await fetch('/api/session')).json();
    const response=await fetch(${JSON.stringify(path)},{method:'POST',headers:{'Content-Type':'application/json','X-Niria-Token':token},
      body:${JSON.stringify(JSON.stringify(body))}});
    return {status:response.status,body:await response.json()};
  })()`);
  await wait(evaluate, "document.querySelector('#calls-list')?.children.length>0 && document.querySelector('#notice').textContent.includes('凭据存储')");
  const before = await state();
  checks.credentialFaultDoesNotPreventLocalHistory = before.messages.some((message) => message.content === "损坏凭据时仍保留的共同经历");
  checks.credentialUnknownStorageIsExplicit = before.connections.storage.available === false && before.connections.storage.savedKnown === false;
  checks.credentialFaultStartsWithoutAutomaticConnections = !before.service.connected && !before.speech.configured &&
    !before.synchronization.configured && !before.connections.image.configured;
  await evaluate(`document.querySelector('#open-settings').click()`);
  checks.credentialFaultDisablesPersistentSecretOptions = await evaluate(`['chat','speech','sync'].every(kind=>document.querySelector('#'+kind+'-remember').disabled) &&
    document.querySelector('#pair-remember').disabled`);
  checks.credentialWarningDoesNotClaimAnEmptyVault = await evaluate("document.querySelector('#credential-status').textContent.includes('无法核对或清除')");
  await evaluate(`(() => {
    document.querySelector('#chat-base').value='http://127.0.0.1:9/v1';
    document.querySelector('#chat-model').value='fallback-chat';
    document.querySelector('#chat-key').value=${JSON.stringify(secret)};
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await wait(evaluate, "!document.querySelector('#settings-dialog').open && document.querySelector('#connection-status').textContent.includes('fallback-chat')");
  checks.credentialFaultAllowsSessionOnlyChatConfiguration = (await state()).service.model === "fallback-chat";
  checks.credentialSessionNoticeKeepsStorageWarning = await evaluate("document.querySelector('#notice').textContent.includes('本次会话') && document.querySelector('#notice').textContent.includes('原已存配置')");

  await evaluate(`(() => {
    document.querySelector('#open-settings').click();document.querySelector('[data-tab="speech"]').click();
    document.querySelector('#speech-base').value='http://127.0.0.1:9/v1';
    document.querySelector('#speech-model').value='fallback-speech';document.querySelector('#speech-voice').value='fixture-voice';
    document.querySelector('#speech-key').value=${JSON.stringify(secret)};document.querySelector('#speech-auto').checked=false;
    document.querySelector('#speech-limit').value='2';document.querySelector('#speech-form').requestSubmit();
  })()`);
  await wait(evaluate, "!document.querySelector('#settings-dialog').open && document.querySelector('#notice').textContent.includes('朗读服务已配置')");
  checks.credentialFaultAllowsIndependentSessionSpeech = (await state()).speech.model === "fallback-speech";
  const image = await post("/api/image/configure", { baseUrl: "http://127.0.0.1:9/v1", model: "fallback-image", apiKey: secret, remember: false });
  const sync = await post("/api/sync/configure", { baseUrl: "http://127.0.0.1:9/dav/", username: "fixture-user", password: secret, auto: false, remember: false });
  checks.credentialFaultAllowsSessionImageAndSync = image.status === 200 && sync.status === 200 &&
    image.body.image.model === "fallback-image" && sync.body.configured;
  const refused = await post("/api/connection", { baseUrl: "http://127.0.0.1:9/v1", model: "must-not-save", apiKey: secret, remember: true });
  checks.credentialRememberRefusalPreservesSessionConnection = refused.status === 503 && (await state()).service.model === "fallback-chat";
  const forgotten = await post("/api/credentials/forget", { slot: "all" });
  checks.credentialFaultNeverReportsSavedSecretsCleared = forgotten.status === 503 && /未能确认清除/.test(forgotten.body.error);
  const after = await state();
  checks.credentialFallbackKeepsCompanionAndMemory = after.identity.id === before.identity.id &&
    after.messageWindow.revision === before.messageWindow.revision && after.memoryWindow.revision === before.memoryWindow.revision;
  checks.credentialFallbackNeverExposesSessionSecrets = !JSON.stringify(after).includes(secret);
  checks.credentialFallbackNeverCallsModel = after.calls.length === 0;
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
  return checks;
}

export async function verifyCredentialSafety({ evaluate, navigate }) {
  const store = new CompanionStore(), vault = new CredentialVault(":memory:", {
    available: async () => true, encrypt: async () => { throw new Error("Protection must not run on unavailable storage"); },
    decrypt: async () => { throw new Error("Protection must not run on unavailable storage"); }
  });
  assert.equal(store.db.prepare("PRAGMA database_list").get().file, "");
  assert.equal(vault.db.prepare("PRAGMA database_list").get().file, "");
  await vault.initialize();
  store.addUser("损坏凭据时仍保留的共同经历");
  vault.db.exec("DROP TABLE credentials");
  const companion = new CompanionService(store), server = createPrototypeServer({ store, companion, vault });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await server.connections.restore();
    await navigate(`http://127.0.0.1:${server.address().port}`);
    return await verifyCredentialFallback(evaluate);
  } finally {
    try {
      await navigate("/");
      await wait(evaluate, "document.querySelector('#calls-list')?.children.length>0");
    } finally {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      server.connections.services.sync.lock(); store.close(); await vault.close();
    }
  }
}
