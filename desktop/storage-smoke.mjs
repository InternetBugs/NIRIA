import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptBackup } from "../core/backup.mjs";
import { STORAGE_VERSION } from "../core/sqlite-state.mjs";

export async function verifyStorageUpgrade({ phase, store, sync, mainWindow, dataDirectory }) {
  const result = { phase };
  if (phase === "storage-upgrade") {
    const fixture = JSON.parse(await readFile(join(dataDirectory, "upgrade-expected.json"), "utf8"));
    assert.ok(["0.7.0", "0.14.0"].includes(fixture.oldVersion));
    assert.equal(fixture.oldSchema, fixture.oldVersion === "0.14.0" ? 2 : 0);
    assert.deepEqual(store.snapshot(), fixture.expected);
    assert.deepEqual(sync.meta, fixture.syncMeta);
    result.legacyDataPreserved = true;
    result.oldVersion = fixture.oldVersion;
    const backup = JSON.parse(await readFile(join(dataDirectory, "legacy-backup.niria"), "utf8"));
    store.restore(await decryptBackup(backup, "isolated-old-version-backup"));
    assert.deepEqual(store.snapshot(), fixture.expected);
    result.oldEncryptedBackupRestores = true;
    store.addUser("升级后的新消息");
    await writeFile(join(dataDirectory, "upgraded-state.json"), JSON.stringify({ state: store.snapshot(), meta: sync.meta }));
    result.newWritesPersist = store.db.prepare("SELECT count(*) AS n FROM message_records").get().n === fixture.expected.messages.length + 1;
    result.ok = result.legacyDataPreserved && result.oldEncryptedBackupRestores && result.newWritesPersist;
  } else if (phase === "storage-restart") {
    const expected = JSON.parse(await readFile(join(dataDirectory, "upgraded-state.json"), "utf8"));
    assert.deepEqual(store.snapshot(), expected.state);
    assert.deepEqual(sync.meta, expected.meta);
    result.restartPreserved = true;
    result.deletedStillEmpty = store.state.messages.filter((m) => m.deleted).every((m) => m.content === "");
    result.permissionsPreserved = store.state.memories[0].allowModel === false && store.state.memories[0].allowSync === false;
    result.ok = result.restartPreserved && result.deletedStillEmpty && result.permissionsPreserved;
  } else throw new Error("Unknown storage test phase");
  result.schemaVersion = store.db.prepare("PRAGMA user_version").get().user_version;
  result.integrityOK = store.db.prepare("PRAGMA integrity_check").get().integrity_check === "ok";
  result.identityRendered = false;
  for (let i = 0; i < 80; i++) {
    if (await mainWindow.webContents.executeJavaScript("document.querySelector('#companion-name').textContent === '旧版升级验证'")) {
      result.identityRendered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  result.noModelCalls = store.state.calls.length === 0;
  result.ok &&= result.schemaVersion === STORAGE_VERSION && result.integrityOK && result.identityRendered && result.noModelCalls;
  return result;
}
