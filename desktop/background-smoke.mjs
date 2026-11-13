import assert from "node:assert/strict";

const fixtureCode = `(() => {
  const make = (variant = 0, complex = false) => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 96;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fafafa'; context.fillRect(0, 0, 64, 96);
    if (complex) { context.fillStyle = '#285080'; context.fillRect(0, 0, 32, 96); }
    context.fillStyle = '#283c5a'; context.fillRect(20, 20, 24, 60);
    context.fillStyle = '#fafafa'; context.fillRect(27, 35, 10, 12);
    context.fillStyle = variant ? '#aa6378' : '#252030'; context.fillRect(22, 25, 20, variant ? 3 : 2);
    return canvas.toDataURL('image/png');
  };
  return { format: 'niria-avatar-prototype', version: 1, width: 1024, height: 1536,
    original: make(), actions: { blink: make(1), smile: make(2) }, complex: make(0, true) };
})()`;

function waiter(evaluate) {
  return async (code) => {
    for (let i = 0; i < 120; i++) {
      if (await evaluate(code)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Background condition failed: ${code}`);
  };
}

export async function verifyBackgroundEditor({ evaluate, save = false, generateBase = "", capture }) {
  const wait = waiter(evaluate), result = {};
  const fixture = await evaluate(fixtureCode);
  await evaluate(`(() => {
    window.__backgroundConfirm = window.confirm; window.confirm = () => true;
    window.__backgroundURL = URL.createObjectURL;
    window.__backgroundExports = [];
    URL.createObjectURL = function(blob) {
      if (blob.type === 'application/json') blob.text().then(text => window.__backgroundExports.push(JSON.parse(text)));
      return window.__backgroundURL.call(URL, blob);
    };
    window.__backgroundOriginalFetch = window.fetch;
    window.__backgroundRequests = [];
    window.fetch = (...args) => {
      if (new URL(String(args[0]), location.href).pathname === '/api/generate') window.__backgroundRequests.push(JSON.parse(args[1].body));
      return window.__backgroundOriginalFetch(...args);
    };
  })()`);
  const importPackage = async (payload) => {
    await evaluate(`(() => {
      const input = document.querySelector('#import-package'), transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(${JSON.stringify(payload)})], 'background-fixture.json', {type:'application/json'}));
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
    })()`);
    await wait("document.querySelector('#source-caption').textContent.includes('素材包') && !document.querySelector('#background-button').disabled");
  };
  const exported = async () => {
    const length = await evaluate("window.__backgroundExports.length");
    await evaluate("document.querySelector('#export-button').click()");
    await wait(`window.__backgroundExports.length > ${length}`);
    return evaluate("window.__backgroundExports.at(-1)");
  };
  const canvasAlpha = "document.querySelector('#portrait').getContext('2d').getImageData(100,100,1,1).data[3]";
  try {
    await importPackage(fixture);
    await evaluate("document.querySelector('#breathing').checked = false; document.querySelector('#blinking').checked = false; document.querySelector('#breathing').dispatchEvent(new Event('change'))");
    await evaluate("document.querySelector('#background-button').click()");
    await wait("!document.querySelector('#background-accept').disabled && document.querySelector('#background-frame').options.length === 3");
    const pixels = await evaluate(`(async () => {
      const { imageFrom } = await import('/image-tools.js');
      const read = async (selector, x, y) => {
        const image = await imageFrom(document.querySelector(selector).src), canvas = document.createElement('canvas');
        canvas.width = 1024; canvas.height = 1536;
        const context = canvas.getContext('2d'); context.drawImage(image,0,0,1024,1536);
        return [...context.getImageData(x,y,1,1).data];
      };
      return { raw: await read('#background-before',100,100), clear: await read('#background-after',100,100),
        detail: await read('#background-after',480,640) };
    })()`);
    result.backgroundWorkerPixels = pixels.raw[3] === 255 && pixels.clear[3] === 0 &&
      pixels.detail[3] === 255 && pixels.detail[0] >= 245;
    if (capture) await capture();
    await evaluate("document.querySelector('[data-close=\"background-dialog\"]').click()");
    await wait("document.querySelector('#background-frame').options.length === 0");
    result.backgroundCancelPreservesRaw = await evaluate(`${canvasAlpha} === 255 && document.querySelector('#background-button').textContent === '预览透明背景'`);
    await evaluate("document.querySelector('#background-button').click()");
    await wait("!document.querySelector('#background-accept').disabled");
    await evaluate("document.querySelector('#background-frame').value = 'smile'; document.querySelector('#background-frame').dispatchEvent(new Event('change')); document.querySelector('#background-accept').click()");
    await wait(`!document.querySelector('#background-dialog').open && ${canvasAlpha} === 0`);
    let payload = await exported();
    result.backgroundExportRetainsRaw = payload.original === fixture.original &&
      payload.actions.blink === fixture.actions.blink && payload.actions.smile === fixture.actions.smile &&
      payload.background?.mode === "edge-connected";
    if (generateBase) {
      await evaluate(`document.querySelector('#settings-button').click();
        document.querySelector('#base-url').value = ${JSON.stringify(generateBase)};
        document.querySelector('#model').value = 'browser-test-model';
        document.querySelector('#api-key').value = 'fake-browser-test-key';
        document.querySelector('#high-fidelity').checked = false; document.querySelector('#transparent').checked = false;
        document.querySelector('#settings-form').requestSubmit()`);
      await wait("!document.querySelector('#settings-dialog').open");
      await evaluate("document.querySelector('[data-generate=\"curious\"]').click()");
      result.backgroundGenerationStillConfirmed = await evaluate("document.querySelector('#confirm-dialog').open && window.__backgroundRequests.length === 0");
      await evaluate("document.querySelector('#confirm-generate').click()");
      await wait("document.querySelector('#review-dialog').open && !document.querySelector('#accept-result').disabled");
      result.backgroundGenerationUsesPreview = await evaluate(`(async () => {
        const { imageFrom } = await import('/image-tools.js');
        const image = await imageFrom(window.__backgroundRequests[0].image), canvas = document.createElement('canvas');
        canvas.width = 1024; canvas.height = 1536;
        const context = canvas.getContext('2d'); context.drawImage(image,0,0,1024,1536);
        return window.__backgroundRequests.length === 1 && context.getImageData(100,100,1,1).data[3] === 0;
      })()`);
      await evaluate("document.querySelector('#accept-result').click()");
      await wait("!document.querySelector('#review-dialog').open");
      payload = await exported();
      result.backgroundGeneratedActionPreservesOthers = !!payload.actions.curious && payload.original === fixture.original &&
        payload.actions.blink === fixture.actions.blink && payload.actions.smile === fixture.actions.smile;
    }
    if (save) {
      await evaluate("document.querySelector('#save-companion').click()");
      await wait("document.querySelector('#notice').textContent.includes('已保存到伴侣')");
      const saved = await evaluate(`(async () => {
        const {token} = await (await fetch('/api/session')).json();
        return (await (await fetch('/api/state', {headers:{'X-Niria-Token':token}})).json()).avatar;
      })()`);
      result.backgroundSaveRetainsRaw = saved.source === fixture.original && saved.actions.blink === fixture.actions.blink &&
        saved.background?.mode === "edge-connected";
    }
    await evaluate("document.querySelector('#background-button').click()");
    await wait(`${canvasAlpha} === 255 && document.querySelector('#background-button').textContent === '预览透明背景' && !document.querySelector('#background-button').disabled`);
    const restored = await exported();
    result.backgroundRestoreKeepsAssets = !Object.hasOwn(restored, "background") && restored.original === fixture.original &&
      restored.actions.blink === fixture.actions.blink && restored.actions.smile === fixture.actions.smile;
    await importPackage(payload);
    await wait(`${canvasAlpha} === 0`);
    result.backgroundPackageRoundTrip = await evaluate("document.querySelector('#background-button').textContent === '恢复原背景'");
    await evaluate("document.querySelector('#background-button').click()");
    await wait(`${canvasAlpha} === 255 && !document.querySelector('#background-button').disabled`);
    await importPackage({ ...fixture, actions: { blink: fixture.complex } });
    await evaluate("document.querySelector('#background-button').click()");
    await wait("document.querySelector('#background-status').textContent.includes('无法可靠处理')");
    result.backgroundComplexRetainsAll = await evaluate("document.querySelector('#background-accept').disabled");
    await evaluate("document.querySelector('[data-close=\"background-dialog\"]').click()");
    const unchanged = await exported();
    result.backgroundComplexRetainsAll &&= unchanged.original === fixture.original && unchanged.actions.blink === fixture.complex;
    await importPackage(fixture);
    await evaluate(`(() => {
      window.__backgroundWorker = window.Worker; window.__backgroundReleases = [];
      window.Worker = class extends window.__backgroundWorker {
        set onmessage(handler) {
          super.onmessage = (event) => event.data.result?.status
            ? window.__backgroundReleases.push(() => handler(event)) : handler(event);
        }
      };
      document.querySelector('#background-button').click();
    })()`);
    await wait("window.__backgroundReleases.length > 0");
    await evaluate("document.querySelector('[data-close=\"background-dialog\"]').click(); window.Worker = window.__backgroundWorker; window.__backgroundReleases.splice(0).forEach(release => release())");
    await wait("!document.querySelector('#background-dialog').open && !document.querySelector('#background-button').disabled && !document.querySelector('#background-after').hasAttribute('src')");
    result.backgroundCanceledWorkerCannotAdopt = await evaluate(`${canvasAlpha} === 255 && document.querySelector('#background-button').textContent === '预览透明背景'`);
    await evaluate(`(() => {
      window.__backgroundWorkerCount = 0;
      window.Worker = class extends window.__backgroundWorker {
        constructor(...args) { super(...args); this.testIndex = ++window.__backgroundWorkerCount; }
        postMessage(...args) {
          if (this.testIndex === 2) throw new Error('isolated postMessage failure');
          return super.postMessage(...args);
        }
      };
    })()`);
    await importPackage(payload);
    result.backgroundEditorFailureFallsBackTogether = await evaluate(`${canvasAlpha} === 255 &&
      document.querySelector('#source-quality').textContent.includes('整组原素材') &&
      [...document.querySelectorAll('[data-generate]')].every(button => button.disabled)`);
    const fallback = await exported();
    result.backgroundFailedExportRetainsRaw = fallback.original === fixture.original &&
      fallback.actions.blink === fixture.actions.blink && fallback.background?.mode === "edge-connected";
    await evaluate("window.Worker = window.__backgroundWorker; document.querySelector('#background-button').click()");
    await wait(`${canvasAlpha} === 255 && !document.querySelector('[data-generate="blink"]').disabled`);
    result.backgroundRestoreUnblocksGeneration = await evaluate("!document.querySelector('#source-quality').textContent.includes('整组原素材')");
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    await evaluate(`(() => {
      document.querySelector('#background-dialog').close();
      window.confirm = window.__backgroundConfirm; URL.createObjectURL = window.__backgroundURL;
      window.fetch = window.__backgroundOriginalFetch;
      if (window.__backgroundWorker) window.Worker = window.__backgroundWorker;
      window.__backgroundReleases?.splice(0).forEach(release => release());
    })()`);
  }
}

export async function verifyBackgroundWindows({ store, mainWindow, widget, createEditor }) {
  const original = store.snapshot(), calls = store.state.calls.length;
  const evaluate = (code) => mainWindow.webContents.executeJavaScript(code), wait = waiter(evaluate);
  const fixture = await evaluate(fixtureCode), result = {};
  let editor;
  try {
    store.mutate((state) => {
      state.avatar = { format: fixture.format, version: 1, source: fixture.original, actions: fixture.actions,
        background: { version: 1, mode: "edge-connected" } };
    });
    await wait("document.querySelector('#avatar-canvas').getContext('2d').getImageData(100,100,1,1).data[3] === 0 && !document.querySelector('#avatar-canvas').hidden");
    for (let i = 0; i < 120; i++) {
      if (await widget.webContents.executeJavaScript("document.querySelector('#widget-canvas').getContext('2d').getImageData(100,100,1,1).data[3] === 0 && !document.querySelector('#widget-canvas').hidden")) {
        result.backgroundBothNativeWindows = true; break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    result.backgroundMainDetailRetained = await evaluate("document.querySelector('#avatar-canvas').getContext('2d').getImageData(480,640,1,1).data[3] === 255");
    const expected = structuredClone(store.state.avatar);
    if (createEditor) {
      for (let open = 0; open < 2; open++) {
        editor = await createEditor();
        const edit = (code) => editor.webContents.executeJavaScript(code), ready = waiter(edit);
        await ready(`document.querySelector('#source-caption')?.textContent.includes('已载入') &&
          document.querySelector('#background-button').textContent === '恢复原背景' &&
          document.querySelector('#portrait').getContext('2d').getImageData(100,100,1,1).data[3] === 0`);
        await edit("document.querySelector('#save-companion').click()");
        await ready("document.querySelector('#notice').textContent.includes('已保存到伴侣')");
        assert.deepEqual(store.state.avatar, expected);
        if (!open) { editor.destroy(); editor = null; }
      }
      result.backgroundEditorReopensTransparent = true;
      const edit = (code) => editor.webContents.executeJavaScript(code), ready = waiter(edit);
      await edit("document.querySelector('#background-button').click()");
      await ready("document.querySelector('#background-button').textContent === '预览透明背景' && !document.querySelector('#save-companion').disabled");
      await edit("document.querySelector('#save-companion').click()");
      await ready("document.querySelector('#notice').textContent.includes('已保存到伴侣')");
      editor.destroy(); editor = null;
      editor = await createEditor();
      const reopened = (code) => editor.webContents.executeJavaScript(code);
      await waiter(reopened)(`document.querySelector('#source-caption')?.textContent.includes('已载入') &&
        document.querySelector('#background-button').textContent === '预览透明背景' &&
        document.querySelector('#portrait').getContext('2d').getImageData(100,100,1,1).data[3] === 255`);
      result.backgroundEditorRestoredOnReopen = true;
      result.backgroundReopenKeepsRaw = store.state.avatar.source === fixture.original &&
        store.state.avatar.actions.blink === fixture.actions.blink && !Object.hasOwn(store.state.avatar, "background");
    } else store.mutate((state) => { const { background, ...raw } = state.avatar; state.avatar = raw; });
    await wait("document.querySelector('#avatar-canvas').getContext('2d').getImageData(100,100,1,1).data[3] === 255");
    for (let i = 0; i < 120; i++) {
      if (await widget.webContents.executeJavaScript("document.querySelector('#widget-canvas').getContext('2d').getImageData(100,100,1,1).data[3] === 255")) {
        result.backgroundBothNativeRestore = true; break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    result.backgroundNativeNoModelCalls = store.state.calls.length === calls;
    assert.equal(result.backgroundBothNativeWindows, true);
    assert.equal(result.backgroundBothNativeRestore, true);
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally { editor?.destroy(); store.mutate(() => { store.state = original; }); }
}

export async function verifyBackgroundFailures(evaluate) {
  const wait = waiter(evaluate), fixture = await evaluate(fixtureCode);
  try {
    await evaluate(`(async () => {
      const { AvatarPlayer } = await import('/avatar-player.js');
      window.__failureWorker = window.Worker;
      window.__failureFixture = ${JSON.stringify(fixture)};
      window.__failureErrors = []; window.__failureCreated = 0; window.__failureTerminated = 0;
      window.Worker = class extends window.__failureWorker {
        constructor(...args) { super(...args); this.testIndex = ++window.__failureCreated; }
        postMessage(...args) {
          if (this.testIndex === 2) throw new Error('isolated worker post failure');
          return super.postMessage(...args);
        }
        terminate() { window.__failureTerminated++; return super.terminate(); }
      };
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1536;
      window.__failurePlayer = new AvatarPlayer(canvas, {error: message => window.__failureErrors.push(message)});
      window.__failureState = {avatarKey:'background-failure', messages:[], conflicts:[],
        avatar:{source:window.__failureFixture.original, actions:window.__failureFixture.actions,
          background:{version:1,mode:'edge-connected'}}};
      await window.__failurePlayer.update(window.__failureState);
      window.__failureAlpha = image => {
        const surface = document.createElement('canvas'); surface.width = 1024; surface.height = 1536;
        const context = surface.getContext('2d'); context.drawImage(image,0,0,1024,1536);
        return context.getImageData(100,100,1,1).data[3];
      };
      window.__failureFramesHaveAlpha = alpha => {
        const images = Object.values(window.__failurePlayer.images);
        return images.length === 3 && images.every(image => window.__failureAlpha(image) === alpha);
      };
    })()`);
    const result = await evaluate(`({
      backgroundFailureTerminatesWorkers: window.__failureCreated === 3 && window.__failureTerminated === 3,
      backgroundPlayerFallsBackTogether: window.__failureFramesHaveAlpha(255),
      backgroundPlayerExplainsFallback: window.__failureErrors.length === 1 && window.__failureErrors[0].includes('整组原素材')
    })`);
    await evaluate("window.__failurePlayer.update(window.__failureState)");
    result.backgroundFailureDoesNotRetry = await evaluate("window.__failureCreated === 3 && window.__failureErrors.length === 1");
    await evaluate(`(async () => {
      window.Worker = window.__failureWorker;
      await window.__failurePlayer.update({...window.__failureState, avatarKey:'background-recovered'});
    })()`);
    result.backgroundPlayerCanRecover = await evaluate("window.__failureFramesHaveAlpha(0)");
    await evaluate(`window.__failurePlayer.update({...window.__failureState, avatarKey:'background-complex',
      avatar:{...window.__failureState.avatar,actions:{...window.__failureFixture.actions,smile:window.__failureFixture.complex}}})`);
    result.backgroundComplexPlayerFallsBackTogether = await evaluate("window.__failureFramesHaveAlpha(255) && window.__failureErrors.length === 2");
    await evaluate(`(() => {
      window.__failureReleases = [];
      window.Worker = class extends window.__failureWorker {
        set onmessage(handler) {
          super.onmessage = event => window.__failureReleases.push(() => handler(event));
        }
      };
      window.__failureLate = window.__failurePlayer.update({...window.__failureState,avatarKey:'background-late'});
    })()`);
    await wait("window.__failureReleases.length > 0");
    await evaluate(`(async () => {
      await window.__failurePlayer.update({avatar:null,avatarKey:null,messages:[],conflicts:[]});
      window.__failureReleases.splice(0).forEach(release => release());
      await window.__failureLate;
    })()`);
    result.backgroundLateWorkerCannotRestoreAvatar = await evaluate("!window.__failurePlayer.images.source && window.__failureErrors.length === 2");
    await evaluate(`(async () => {
      window.Worker = undefined;
      await window.__failurePlayer.update({...window.__failureState,avatarKey:'background-no-worker'});
    })()`);
    result.backgroundWorksWithoutWorker = await evaluate("window.__failureFramesHaveAlpha(0) && window.__failureErrors.length === 2");
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    await evaluate(`(() => {
      window.__failurePlayer?.destroy();
      if (window.__failureWorker) window.Worker = window.__failureWorker;
      window.__failureReleases?.splice(0).forEach(release => release());
    })()`);
  }
}
