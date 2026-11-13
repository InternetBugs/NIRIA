import assert from "node:assert/strict";
import { live2DFixture, live2DAvatarFixture } from "./live2d-fixture.mjs";
import { live2DRuntimeInfo } from "../prototype/public/live2d-runtime.js";

export async function verifyLive2D({ store, evaluate, widgetEvaluate, capture }) {
  const original = store.snapshot(), result = {}, initialCalls = store.state.calls.length;
  const runtimeReady = live2DRuntimeInfo.available;
  const bundle = live2DFixture("检查 A"), second = live2DFixture("检查 B");
  const image = { format: "niria-avatar-prototype", version: 1, actions: {},
    source: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
  const wait = async (code) => {
    for (let index = 0; index < 150; index++) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Live2D condition failed: ${code}`);
  };
  const choose = async (bundles, { hold = false } = {}) => {
    await evaluate(`(() => {
      const values = ${JSON.stringify(bundles)}, files = values.flatMap(bundle => bundle.files.map(entry => {
        const bytes = Uint8Array.from(atob(entry.data), char => char.charCodeAt(0));
        const file = new File([bytes], entry.path.split('/').at(-1));
        Object.defineProperty(file, 'webkitRelativePath', {value: entry.path});
        return file;
      }));
      if (${hold}) {
        const file = files.find(file => file.name.endsWith('.model3.json')), read = file.arrayBuffer.bind(file);
        file.arrayBuffer = async () => { await new Promise(resolve => window.__releaseLive2D = resolve); return read(); };
      }
      Object.defineProperty(document.querySelector('#live2d-folder'), 'files', {configurable:true,get:() => files});
      document.querySelector('#live2d-folder').dispatchEvent(new Event('change'));
    })()`);
  };
  const open = () => evaluate("document.querySelector('#open-live2d').click()");
  const close = () => evaluate("document.querySelector('#live2d-dialog [data-close]').click()");
  const ready = () => wait("document.querySelector('#live2d-status').textContent.includes('文件检查通过')");
  try {
    await open();
    await wait("document.querySelector('#live2d-dialog').open");
    result.live2dLocalRuntimeExplicit = await evaluate(`document.querySelector('#live2d-runtime-status').textContent.includes(${JSON.stringify(runtimeReady ? "本机预览" : "尚未配置")}) && document.querySelector('#live2d-adopt').disabled`);
    await choose([bundle, second]);
    result.live2dMultipleModelsRequireChoice = await evaluate("document.querySelector('#live2d-model').options.length === 3 && !document.querySelector('#live2d-model').value && !document.querySelector('#live2d-summary').textContent");
    await evaluate(`document.querySelector('#live2d-model').value = ${JSON.stringify(bundle.model)}; document.querySelector('#live2d-model').dispatchEvent(new Event('change'))`);
    await ready();
    result.live2dLocalFileSummary = await evaluate("document.querySelector('#live2d-summary').textContent.includes('6 个文件') && document.querySelector('#live2d-summary').textContent.includes('2 个表情') && document.querySelector('#live2d-summary').textContent.includes('音频引用未导入')");
    result.live2dMappingsListed = await evaluate("document.querySelector('#live2d-map-smile').options.length === 3 && document.querySelector('#live2d-idle').options.length === 2");
    result.live2dCannotAdoptWithoutPlayback = await evaluate(`document.querySelector('#live2d-preview').disabled === ${!runtimeReady} && document.querySelector('#live2d-adopt').disabled`);
    assert.deepEqual(store.snapshot(), original);
    if (capture) await capture();

    const invalid = structuredClone(bundle);
    const model = JSON.parse(Buffer.from(invalid.files[0].data, "base64"));
    model.FileReferences.Moc = "https://example.invalid/external.moc3";
    invalid.files[0].data = Buffer.from(JSON.stringify(model)).toString("base64");
    await choose([invalid]);
    await wait("document.querySelector('#live2d-status').textContent.includes('相对路径')");
    result.live2dBadPathsNeverAdopted = await evaluate("document.querySelector('#live2d-adopt').disabled && !document.querySelector('#live2d-summary').textContent");

    await choose([bundle], { hold: true });
    await wait("typeof window.__releaseLive2D === 'function'");
    await close();
    await evaluate("window.__releaseLive2D(); delete window.__releaseLive2D");
    await open();
    result.live2dLateClosedImportDiscarded = await evaluate("!document.querySelector('#live2d-summary').textContent && document.querySelector('#live2d-adopt').disabled");

    await choose([bundle], { hold: true });
    await wait("typeof window.__releaseLive2D === 'function'");
    await choose([second]);
    await ready();
    await evaluate("window.__releaseLive2D(); delete window.__releaseLive2D");
    await new Promise((resolve) => setTimeout(resolve, 80));
    result.live2dNewSelectionWins = await evaluate(`document.querySelector('#live2d-model').value === ${JSON.stringify(second.model)} && document.querySelector('#live2d-summary').textContent.includes('6 个文件')`);

    store.mutate((state) => { state.avatar = image; });
    await wait("document.querySelector('#live2d-status').textContent.includes('已经改变')");
    result.live2dOtherWindowPreventsOverwrite = await evaluate("document.querySelector('#live2d-adopt').disabled");
    await close();
    store.mutate((state) => { state.avatar = live2DAvatarFixture("不可播放的结构夹具"); });
    const failure = JSON.stringify(runtimeReady ? "损坏" : "尚未配置");
    await wait(`document.querySelector('#avatar-canvas').dataset.live2dError?.includes(${failure})`);
    result.live2dUnplayableKeepsStoredData = store.state.avatar.format === "niria-live2d-avatar" &&
      await evaluate("document.querySelector('#avatar-canvas').hidden");
    if (widgetEvaluate) {
      for (let index = 0; index < 150; index++) {
        if (await widgetEvaluate(`document.querySelector('#widget-last').textContent.includes(${failure})`)) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      result.live2dWidgetExplainsInvalidModel = await widgetEvaluate(`document.querySelector('#widget-last').textContent.includes(${failure}) && document.querySelector('#widget-canvas').hidden`);
    }
    store.mutate((state) => { state.avatar = image; });
    await wait("!document.querySelector('#avatar-canvas').hidden && !document.querySelector('#avatar-canvas').dataset.live2dError");
    result.live2dImageFallbackRecovers = true;

    const lifecycle = await evaluate(`(async () => {
      const { AvatarPlayer } = await import('/avatar-player.js');
      const { Live2DPlayer } = await import('/live2d-player.js');
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 96;
      const avatar = ${JSON.stringify(live2DAvatarFixture())}, image = ${JSON.stringify(image)};
      const errors = [], frames = [], disposed = [];
      let late, entered, loseContext, runtimeIndex = 0, throwRender = false;
      const factory = async ({canvas:surface, assets, model, signal}) => {
        const index = ++runtimeIndex, bytes = assets.read('model.moc3', model);
        if (index === 2) { entered(); await new Promise(resolve => late = resolve); }
        loseContext = () => surface.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));
        return {
          render(frame) {
            if (throwRender) throw new Error('isolated render failure');
            frames.push(frame);
            const context = surface.getContext('2d'); context.clearRect(0,0,64,96);
            context.fillStyle = frame.expression === '微笑' ? '#ff0000' : '#0000ff';
            context.fillRect(20,20,20,20);
          },
          destroy() { disposed.push(index); }
        };
      };
      const player = new AvatarPlayer(canvas, {live2dRuntime:factory,error:message => errors.push(message)});
      const data = (key, expression = null) => ({ avatar, avatarKey:key, messages: expression ?
        [{role:'assistant',status:'completed',expression:{name:expression,avatarKey:key,at:new Date().toISOString()}}] : [] });
      const pixel = (x,y) => [...canvas.getContext('2d').getImageData(x,y,1,1).data];
      const result = {};
      try {
        await player.update(data('a'.repeat(64),'smile'));
        result.live2dSharedPlayerUsesMappedExpression = pixel(25,25)[0] === 255 && pixel(2,2)[3] === 0 && frames.at(-1).expression === '微笑';
        player.live2d.pose.until = Date.now()-1; player.draw();
        result.live2dExpressionReturnsToNeutral = pixel(25,25)[2] === 255 && canvas.dataset.expression === 'neutral';
        const secondEntered = new Promise(resolve => entered = resolve), pending = player.update(data('b'.repeat(64)));
        await secondEntered;
        await player.update({avatar:image,avatarKey:'image',messages:[]});
        late(); await pending;
        result.live2dLateLoaderCannotReplaceImage = !player.live2d && !canvas.dataset.live2dError && disposed.includes(2);
        await player.update(data('c'.repeat(64)));
        loseContext();
        result.live2dContextLossReleasesRuntime = disposed.includes(3) && canvas.dataset.live2dError.includes('显示已中断');
        const count = runtimeIndex;
        await player.update(data('c'.repeat(64)));
        result.live2dContextLossDoesNotLoop = runtimeIndex === count;
        await player.update(data('d'.repeat(64)));
        throwRender = true; player.draw(); throwRender = false;
        result.live2dRenderFailureKeepsChatAlive = canvas.dataset.live2dError.includes('无法继续播放') && disposed.includes(4);
        await player.update({avatar:image,avatarKey:'new-image',messages:[]});
        result.live2dFailedRuntimeCanReturnToImage = !player.live2d && !canvas.dataset.live2dError && pixel(25,25)[3] > 0;
        const direct = new Live2DPlayer(canvas, { runtime:async () => ({render(){throw new Error('first frame fails');},destroy(){disposed.push('first-frame');}}) });
        try {
          let rejected = false;
          try { await direct.update(data('e'.repeat(64))); } catch { rejected = true; }
          result.live2dFirstFrameFailureRejectsPreview = rejected && disposed.filter(value => value === 'first-frame').length === 1;
        } finally { direct.destroy(); }
      } finally { player.destroy(); }
      result.live2dRuntimeDisposedOnce = [1,2,3,4].every(index => disposed.filter(value => value === index).length === 1);
      return result;
    })()`);
    Object.assign(result, lifecycle);
    result.live2dNoPaidCalls = store.state.calls.length === initialCalls;
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    await evaluate(`(() => {
      if (window.__releaseLive2D) window.__releaseLive2D();
      delete window.__releaseLive2D;
      const dialog = document.querySelector('#live2d-dialog');
      if (dialog.open) dialog.close();
      delete document.querySelector('#live2d-folder').files;
    })()`);
    store.mutate(() => { store.state = original; });
  }
}
