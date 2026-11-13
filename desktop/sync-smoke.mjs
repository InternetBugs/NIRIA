import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePairing } from "../core/sync-pairing.mjs";
import { unseal } from "../core/sync-model.mjs";

export async function verifySyncKeys({ phase, server, sync, store, vault, dataDirectory, baseUrl }) {
  const path = join(dataDirectory, "isolated-key-recovery.json");
  const result = { phase };
  if (!vault.available) throw new Error("Windows protected storage unavailable during key verification");
  if (phase === "rotation-write") {
    await server.connections.configure("sync", { baseUrl, auto: true, remember: true });
    const previous = sync.createPair();
    await server.connections.rememberPair(true);
    store.addUser("Windows 隔离换钥验证");
    await sync.sync();
    const plan = await server.connections.prepareSyncRotation();
    await writeFile(path, JSON.stringify({ original: previous.code, code: plan.code }));
    await server.connections.rotateSync({ id: plan.id, confirmed: true, rememberPair: true });
    const remote = await sync.connection.read(`${sync.folder()}state.niria`);
    const old = parsePairing(previous.code);
    try { unseal(remote.data.toString(), old.key, old.vaultId, old.identityId); result.oldKeyBlocked = false; }
    catch { result.oldKeyBlocked = true; }
    finally { old.key.fill(0); }
    result.savedNewPair = (await vault.read("pair"))?.code === plan.code;
    result.autoDisabled = !sync.auto && (await vault.read("sync"))?.auto === false;
    result.ok = result.oldKeyBlocked && result.savedNewPair && result.autoDisabled;
  } else {
    const expected = JSON.parse(await readFile(path, "utf8"));
    if (phase === "rotation-read" || phase === "rotation-restored") {
      result.pairRestored = sync.exportPair().code === expected.code;
      result.autoDisabled = !sync.auto;
      result.journalClear = !sync.meta.rotation;
      result.sameCompanion = store.state.messages.some((m) => m.content === "Windows 隔离换钥验证");
      let rejected = false;
      try { sync.unlock(expected.original); } catch { rejected = true; }
      result.oldCodeLocallyRetired = rejected;
      result.ok = result.pairRestored && result.autoDisabled && result.journalClear && result.sameCompanion && rejected;
    } else if (phase === "rotation-pending") {
      const plan = await server.connections.prepareSyncRotation();
      await writeFile(path, JSON.stringify({ ...expected, code: plan.code }));
      const write = sync.connection.write.bind(sync.connection);
      sync.connection.write = async (...args) => {
        const result = await write(...args);
        if (args[0].endsWith("state.niria")) throw new Error("isolated interrupted response");
        return result;
      };
      let interrupted = false;
      try { await server.connections.rotateSync({ id: plan.id, confirmed: true, rememberPair: true }); }
      catch (error) { interrupted = error.message.includes("尚未确认"); }
      result.pendingPreserved = interrupted && sync.status().rotation.pending;
      result.oldSavedPairCleared = !vault.status().saved.includes("pair");
      result.ok = result.pendingPreserved && result.oldSavedPairCleared;
    } else if (phase === "rotation-recover") {
      result.pendingRestored = !!sync.meta.rotation && !sync.pair;
      result.autoDisabled = !sync.auto;
      const resultRecovered = await server.connections.recoverSyncRotation({ code: expected.code, rememberPair: true });
      result.readOnlyRecovered = resultRecovered.readOnly && resultRecovered.keyChanged && !sync.meta.rotation;
      result.newPairSaved = (await vault.read("pair"))?.code === expected.code;
      result.ok = result.pendingRestored && result.autoDisabled && result.readOnlyRecovered && result.newPairSaved;
    } else throw new Error("Unknown synchronization test phase");
  }
  result.noModelCalls = store.state.calls.length === 0;
  result.ok &&= result.noModelCalls;
  return result;
}
