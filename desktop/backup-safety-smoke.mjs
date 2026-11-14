import assert from "node:assert/strict";
import { once } from "node:events";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

// Shared by a real browser and Electron. All requests use the application HTTP
// API. Delays control local file reads/crypto/credential cleanup, never a model.
export async function verifyBackupSafety({ evaluate, navigate }) {
  // A separate :memory: database and no CredentialVault: browser/Electron checks
  // cannot write an application database, saved pairing code or real settings.
  const store = new CompanionStore();
  assert.equal(store.db.prepare("PRAGMA database_list").get().file, "");
  const companion = new CompanionService(store);
  const server = createPrototypeServer({ store, companion });
  const { backup, connections } = server, sync = connections.services.sync;
  assert.equal(connections.vault, undefined);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const saved = { encryptor: backup.encryptor, decryptor: backup.decryptor };
  const secret = "isolated-backup-smoke-passphrase", checks = {};
  const donor = new CompanionStore();
  let release;
  const wait = async (condition) => {
    for (let index = 0; index < 250; index++) {
      if (typeof condition === "function" ? await condition() : await evaluate(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Backup smoke condition failed: ${condition}`);
  };
  const open = async () => {
    await navigate(origin);
    await wait("document.readyState==='complete' && document.querySelector('#calls-list')?.children.length>0");
    await evaluate(`(() => {
      document.querySelector('#open-settings').click(); document.querySelector('[data-tab="backup"]').click();
      window.confirm=()=>true;
      window.__backupRestores=0;window.__backupDownloads=0;window.__backupReads=[];
      const originalFetch=window.fetch.bind(window), originalText=File.prototype.text;
      window.fetch=async (url,options)=>{
        if(url==='/api/backup/restore') { window.__backupRestores++; window.__backupBody=JSON.parse(options.body); }
        if(window.__backupFailRefresh && String(url).startsWith('/api/state')) throw new Error('isolated page refresh failure');
        return originalFetch(url,options);
      };
      File.prototype.text=function(){
        if(window.__backupHoldFile) return new Promise(resolve=>window.__backupReads.push(()=>originalText.call(this).then(resolve)));
        return originalText.call(this);
      };
      const originalURL=URL.createObjectURL.bind(URL);
      URL.createObjectURL=(blob)=>{if(blob.type==='application/json')window.__backupBlob=blob;return originalURL(blob);};
      const originalClick=HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click=function(){
        if(this.download.endsWith('.niria')) {window.__backupDownloads++;return;}
        return originalClick.call(this);
      };
    })()`);
  };
  const choose = async (held = false, password = secret) => {
    await evaluate(`(() => {
      window.__backupHoldFile=${held};
      document.querySelector('#backup-password').value=${JSON.stringify(password)};
      const transfer=new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(JSON.stringify(envelope))}],'isolated.niria',{type:'application/json'}));
      const input=document.querySelector('#restore-backup');input.files=transfer.files;input.dispatchEvent(new Event('change'));
    })()`);
  };
  let envelope;
  const idle = async () => {
    await wait(() => !backup.active);
    await wait("!document.querySelector('#export-backup').disabled && document.querySelector('#backup-stop').hidden");
  };
  const holdCrypto = (operation) => {
    const gate = new Promise((resolve) => { release = resolve; });
    if (operation === "restore") backup.decryptor = async (...args) => { await gate; return saved.decryptor(...args); };
    else backup.encryptor = async (...args) => { await gate; return saved.encryptor(...args); };
  };
  try {
    donor.identity({ name: "恢复后的隔离伙伴" });
    donor.addUser("备份里保存的一次共同经历");
    donor.addMemory({ content: "备份里的共同记忆" });
    envelope = await encryptBackup(donor.exportData(), secret);
    donor.close();
    store.settings({ autoMemory: false });
    connections.rememberPair = async () => {};
    const localId = store.state.identity.id;
    await open();
    await choose(true);
    await wait("window.__backupReads.length===1 && document.querySelector('#backup-status').textContent.includes('读取')");
    checks.backupWaitingDisablesDuplicateActions = await evaluate("document.querySelector('#export-backup').disabled && document.querySelector('#restore-backup').disabled");
    await evaluate("document.querySelector('#backup-stop').click();window.__backupReads[0]();void 0");
    await idle();
    checks.backupStopDuringFileReadPreventsSubmission = await evaluate("window.__backupRestores===0 && document.querySelector('#notice').textContent.includes('停止读取')");
    checks.backupStoppedFileReadKeepsLocalIdentity = store.state.identity.id === localId;

    await choose(true);
    await wait("window.__backupReads.length===2");
    await evaluate("document.querySelector('#settings-dialog').close()");
    await wait("!document.querySelector('#export-backup').disabled");
    await evaluate("window.__backupReads[1]();void 0");
    await idle();
    checks.backupClosingSettingsCancelsPendingFileRead = await evaluate("window.__backupRestores===0");

    await open(); await choose(true);
    await wait("window.__backupReads.length===1");
    await choose(true);
    await wait("window.__backupReads.length===2");
    await evaluate("window.__backupReads[0]();void 0");
    checks.backupSupersededReadCannotSubmitOrClearNewTask = await evaluate("window.__backupRestores===0 && document.querySelector('#export-backup').disabled");
    await evaluate("document.querySelector('#backup-stop').click();window.__backupReads[1]();void 0");
    await idle();

    await choose(true);
    await wait("window.__backupReads.length===3");
    store.addMemory({ content: "读取文件时另一窗口保存的新记忆" });
    await evaluate("window.__backupReads[2]();void 0");
    await wait("document.querySelector('#notice').textContent.includes('已经变化')");
    await idle();
    checks.backupFileReadChangeRejectsStaleConfirmation = store.state.memories.some((m) => m.content.includes("另一窗口")) &&
      store.state.identity.id === localId && await evaluate("window.__backupRestores===1");

    holdCrypto("restore"); await choose();
    await wait(() => backup.restoring);
    store.addMemory({ content: "解密期间另一窗口保存的新记忆" });
    release();
    await wait("document.querySelector('#notice').textContent.includes('已经变化')");
    await idle();
    checks.backupDecryptChangeKeepsNewLocalRecords = store.state.memories.length === 2 && store.state.identity.id === localId;

    holdCrypto("restore"); await choose();
    await wait(() => backup.restoring);
    await evaluate("document.querySelector('#backup-stop').click()");
    await wait(() => backup.active.controller.signal.aborted);
    checks.backupStopKeepsBusyUntilCryptoSettles = backup.status().busy &&
      await evaluate("document.querySelector('#export-backup').disabled && document.querySelector('#backup-status').textContent.includes('等待')");
    release();
    await wait("document.querySelector('#notice').textContent.includes('停止或超时')");
    await idle();
    checks.backupCancelledLateDecryptPreservesLocalData = store.state.memories.length === 2 && store.state.identity.id === localId;

    holdCrypto("export");
    await evaluate(`document.querySelector('#backup-password').value=${JSON.stringify(secret)};document.querySelector('#export-backup').click()`);
    await wait(() => backup.active?.operation === "export");
    await evaluate("document.querySelector('#backup-stop').click()");
    await wait(() => backup.active.controller.signal.aborted);
    release();
    await wait("document.querySelector('#notice').textContent.includes('停止或超时')");
    await idle();
    checks.backupCancelledLateExportNeverDownloads = await evaluate("window.__backupDownloads===0");

    backup.encryptor = saved.encryptor; backup.decryptor = saved.decryptor;
    await evaluate(`document.querySelector('#backup-password').value=${JSON.stringify(secret)};document.querySelector('#export-backup').click()`);
    await wait("window.__backupDownloads===1");
    await idle();
    const exported = JSON.parse(await evaluate("window.__backupBlob.text()"));
    checks.backupRealEncryptedExportPreservesSnapshot = (await decryptBackup(exported, secret)).memories.length === 2 &&
      !JSON.stringify(exported).includes("另一窗口");
    checks.backupSuccessfulExportClearsOnlyUsedPassword = await evaluate("document.querySelector('#backup-password').value===''");

    await choose(true);
    await wait("window.__backupReads.length===4");
    await evaluate("document.querySelector('#backup-password').value='new-unused-passphrase';window.__backupReads[3]();void 0");
    await wait("document.querySelector('#notice').textContent.includes('共同记忆已恢复')");
    await idle();
    checks.backupRestoreUsesPasswordCapturedAtSelection = store.state.identity.name === "恢复后的隔离伙伴" &&
      await evaluate(`window.__backupBody.password===${JSON.stringify(secret)}`);
    checks.backupRestorePreservesNewlyTypedPassword = await evaluate("document.querySelector('#backup-password').value==='new-unused-passphrase'");

    await open();
    connections.rememberPair = async () => { await new Promise((resolve) => { release = resolve; }); throw new Error("private cleanup detail"); };
    await choose();
    await wait(() => backup.status().committed);
    await wait("document.querySelector('#backup-stop').disabled && document.querySelector('#backup-status').textContent.includes('已恢复')");
    checks.backupCommittedCleanupIsVisibleAndCannotStop = backup.status().busy;
    await evaluate("window.__backupFailRefresh=true");
    release();
    await wait("document.querySelector('#notice').textContent.includes('配对码') && document.querySelector('#notice').textContent.includes('页面刷新')");
    checks.backupCleanupAndRefreshFaultsRemainRestoredSuccess = await evaluate("!document.querySelector('#settings-dialog').open && !document.querySelector('#notice').textContent.includes('private cleanup detail')") &&
      store.state.identity.name === "恢复后的隔离伙伴";
    await evaluate("window.__backupFailRefresh=false");
    await idle();

    await open(); await choose(true);
    await wait("window.__backupReads.length===1");
    await navigate(`${origin}/avatar`);
    await wait("document.readyState==='complete' && !!document.querySelector('#source-caption')");
    checks.backupNavigationDuringFileReadNeverSubmitsRestore = !backup.active && store.state.identity.name === "恢复后的隔离伙伴";
    await open();
    connections.rememberPair = async () => {};
    holdCrypto("restore"); await choose();
    await wait(() => backup.restoring);
    const navigationTask = backup.active;
    await navigate(`${origin}/avatar`);
    await wait(() => navigationTask.controller.signal.aborted);
    release(); await wait(() => !backup.active);
    checks.backupNavigationCancelsSubmittedRestore = store.state.identity.name === "恢复后的隔离伙伴";
    await open();
    holdCrypto("restore"); await choose();
    await wait(() => backup.restoring);
    await evaluate("document.querySelector('#settings-dialog').close()");
    await wait(() => backup.active.controller.signal.aborted);
    release();
    await wait("document.querySelector('#notice').textContent.includes('停止或超时')");
    await idle();
    checks.backupClosingSettingsCancelsSubmittedRestore = store.state.identity.name === "恢复后的隔离伙伴";
    checks.backupSafetyNeverCallsModel = store.state.calls.length === 0;
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    return checks;
  } finally {
    try {
      backup.cancel(); release?.(); await wait(() => !backup.active);
      await navigate("/");
      await wait("document.readyState==='complete' && document.querySelector('#calls-list')?.children.length>0");
    } finally {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      sync.lock(); store.close();
    }
  }
}
