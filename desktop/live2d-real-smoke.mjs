import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { prepareLive2DImport } from "../prototype/public/live2d-import.js";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { CompanionStore } from "../core/store.mjs";
import { SyncService } from "../core/sync-service.mjs";

// Official SDK sample, used only when the caller explicitly selects this test.
// No sample model or SDK archive is included in the application distribution.
export async function readRealLive2D(directory) {
  const files = [];
  async function visit(folder, path) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const full = join(folder, entry.name), relative = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(full, relative);
      else {
        const bytes = await readFile(full);
        files.push({ name: entry.name, webkitRelativePath: relative, size: bytes.length,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      }
    }
  }
  await visit(directory, basename(directory));
  return prepareLive2DImport(files);
}

export async function verifyRealLive2D({ store, evaluate, bundle, capture, reload, widgetEvaluate, setReduced, retainAvatar = false, davBaseUrl }) {
  const original = store.snapshot(), result = {};
  const wait = async (code) => {
    for (let index = 0; index < 600; index++) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Real Live2D condition failed: ${code}\n${await evaluate("document.querySelector('#live2d-status')?.textContent + ' / ' + document.querySelector('#avatar-canvas')?.dataset.live2dError")}`);
  };
  const choose = async (value) => evaluate(`(() => {
    const bundle = ${JSON.stringify(value)}, files = bundle.files.map(entry => {
      const file = new File([Uint8Array.from(atob(entry.data), char => char.charCodeAt(0))], entry.path.split('/').at(-1));
      Object.defineProperty(file,'webkitRelativePath',{value:entry.path}); return file;
    });
    Object.defineProperty(document.querySelector('#live2d-folder'),'files',{configurable:true,get:()=>files});
    document.querySelector('#live2d-folder').dispatchEvent(new Event('change'));
  })()`);
  const fingerprint = (selector) => `(() => {
    const canvas = document.querySelector('${selector}'), pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let opaque=0, transparent=0, hash=0;
    for(let i=0;i<pixels.length;i+=4) { if(pixels[i+3]) opaque++; else transparent++; hash=(Math.imul(hash,31)+pixels[i]+pixels[i+1]*3+pixels[i+2]*7+pixels[i+3])|0; }
    return {opaque,transparent,hash};
  })()`;
  try {
    await evaluate("document.querySelector('#open-live2d').click()");
    await choose(bundle);
    await wait("document.querySelector('#live2d-status').textContent.includes('文件检查通过')");
    await evaluate(`(() => {
      document.querySelector('#live2d-idle').value='Idle';
      const select=document.querySelector('#live2d-map-smile');
      select.value=[...select.options].some(option=>option.value==='F05') ? 'F05' : select.options[1]?.value || '';
      document.querySelector('#live2d-bindings').dispatchEvent(new Event('change'));
      document.querySelector('#live2d-preview').click();
    })()`);
    await wait("!document.querySelector('#live2d-adopt').disabled");
    const first = await evaluate(fingerprint("#live2d-preview-canvas"));
    result.realOfficialCoreDrawsVisibleTransparentFrame = first.opaque > 1000 && first.transparent > 1000;
    // Hidden native smoke windows can receive animation frames less often than
    // the old fixed 700 ms delay. Require an actual changed frame, with a bound.
    result.realIdleMotionChangesPixels = false;
    for (let index = 0; index < 60; index++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const later = await evaluate(fingerprint("#live2d-preview-canvas"));
      if (later.hash !== first.hash) { result.realIdleMotionChangesPixels = true; break; }
    }
    if (!result.realIdleMotionChangesPixels) {
      const state = await evaluate(`({hidden:document.hidden,visibility:document.visibilityState,
        reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
        error:document.querySelector('#live2d-preview-canvas').dataset.live2dError||null})`);
      throw new Error(`Real idle motion produced no changed frame within 6 seconds: ${JSON.stringify(state)}`);
    }
    await evaluate("document.querySelector('#live2d-preview-expression').value='smile'; document.querySelector('#live2d-preview-expression').dispatchEvent(new Event('change'))");
    await wait("document.querySelector('#live2d-preview-canvas').dataset.expression === 'smile'");
    result.realExpressionMappingApplied = true;
    if (setReduced) {
      await setReduced(true);
      await wait("matchMedia('(prefers-reduced-motion: reduce)').matches");
      await evaluate("document.querySelector('#live2d-preview-expression').value='neutral'; document.querySelector('#live2d-preview-expression').dispatchEvent(new Event('change'))");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const neutral = await evaluate(fingerprint("#live2d-preview-canvas"));
      await evaluate("document.querySelector('#live2d-preview-expression').value='smile'; document.querySelector('#live2d-preview-expression').dispatchEvent(new Event('change'))");
      const smiling = await evaluate(fingerprint("#live2d-preview-canvas"));
      result.realReducedMotionExpressionChangesPixels = smiling.hash !== neutral.hash;
      await evaluate("document.querySelector('#live2d-preview-expression').value='neutral'; document.querySelector('#live2d-preview-expression').dispatchEvent(new Event('change'))");
      result.realExpressionRestoresBaseAppearance = (await evaluate(fingerprint("#live2d-preview-canvas"))).hash === neutral.hash;
      await setReduced(false);
    }
    if (capture) await capture();
    await evaluate("document.querySelector('#live2d-adopt').click()");
    await wait("!document.querySelector('#live2d-dialog').open && !document.querySelector('#avatar-canvas').hidden");
    result.realAdoptionPreservesCompanion = store.state.identity.id === original.identity.id &&
      JSON.stringify(store.state.messages) === JSON.stringify(original.messages) &&
      JSON.stringify(store.state.memories) === JSON.stringify(original.memories);
    result.realAdoptedCanvasVisible = (await evaluate(fingerprint("#avatar-canvas"))).opaque > 1000;
    assert.equal(store.state.avatar.format, "niria-live2d-avatar");
    const accepted = structuredClone(store.state.avatar);
    const encrypted = await encryptBackup(store.exportData(), "real-live2d-test-only");
    store.mutate((state) => { state.avatar = null; });
    await wait("document.querySelector('#avatar-canvas').hidden");
    store.restore(await decryptBackup(encrypted, "real-live2d-test-only"));
    await wait("!document.querySelector('#avatar-canvas').hidden && !document.querySelector('#avatar-canvas').dataset.live2dError");
    result.realBackupRestoresModelBytes = JSON.stringify(store.state.avatar) === JSON.stringify(accepted);
    if (davBaseUrl) {
      const first = new CompanionStore(), second = new CompanionStore();
      try {
        first.restore(store.exportData());
        const a = new SyncService(first), b = new SyncService(second);
        a.configure({ baseUrl: davBaseUrl, auto: false }); b.configure({ baseUrl: davBaseUrl, auto: false });
        const { code } = a.createPair();
        await a.sync(); await b.join(code);
        result.realWebDAVRecoveryPreservesModel = JSON.stringify(second.state.avatar) === JSON.stringify(accepted) &&
          second.state.identity.id === store.state.identity.id;
        store.mutate((state) => { state.avatar = null; });
        await wait("document.querySelector('#avatar-canvas').hidden");
        store.mutate((state) => { state.avatar = structuredClone(second.state.avatar); });
        await wait("!document.querySelector('#avatar-canvas').hidden");
        result.realWebDAVRecoveredModelPlays = (await evaluate(fingerprint("#avatar-canvas"))).opaque > 1000;
      } finally { first.close(); second.close(); }
    }
    if (reload) {
      await reload();
      await wait("document.readyState === 'complete' && !document.querySelector('#avatar-canvas').hidden && !document.querySelector('#avatar-canvas').dataset.live2dError");
      result.realPageReloadPlaysSavedModel = (await evaluate(fingerprint("#avatar-canvas"))).opaque > 1000;
    }
    if (widgetEvaluate) {
      for (let index = 0; index < 600; index++) {
        if (await widgetEvaluate("!document.querySelector('#widget-canvas').hidden && !document.querySelector('#widget-canvas').dataset.live2dError")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      result.realWidgetDrawsSavedModel = (await widgetEvaluate(fingerprint("#widget-canvas"))).opaque > 1000;
    }
    await evaluate("document.querySelector('#open-live2d').click()");
    const broken = structuredClone(bundle);
    broken.files.find((entry) => entry.path.endsWith(".moc3")).data = Buffer.from("MOC3" + "\0".repeat(60)).toString("base64");
    await choose(broken);
    await wait("document.querySelector('#live2d-status').textContent.includes('文件检查通过')");
    await evaluate("document.querySelector('#live2d-preview').click()");
    await wait("document.querySelector('#live2d-status').textContent.includes('损坏')");
    result.realInvalidMocCannotReplaceCurrentAvatar = await evaluate("document.querySelector('#live2d-adopt').disabled") &&
      JSON.stringify(store.state.avatar) === JSON.stringify(accepted);
    result.realNoModelServiceCalls = store.state.calls.length === original.calls.length;
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    await evaluate("if(document.querySelector('#live2d-dialog').open) document.querySelector('#live2d-dialog').close()");
    if (setReduced) await setReduced(false);
    if (!retainAvatar) store.mutate(() => { store.state = original; });
  }
}
