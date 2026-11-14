import assert from "node:assert/strict";
import { validateAvatar } from "../core/store.mjs";

export async function verifyAvatarSafety({ store, evaluate, navigate }) {
  const original = store.snapshot(), initialCalls = store.state.calls.length, result = {};
  const wait = async (code) => {
    for (let index = 0; index < 150; index++) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Image safety condition failed: ${code}`);
  };
  const fixture = await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 480;
    const context = canvas.getContext('2d');
    context.fillStyle = '#2e5078'; context.fillRect(60,140,200,300);
    context.fillStyle = '#e7c8b0'; context.fillRect(110,45,100,110);
    context.fillStyle = '#332738'; context.fillRect(120,80,16,8); context.fillRect(183,80,16,8);
    const original = canvas.toDataURL('image/png');
    context.fillStyle = '#94586c'; context.fillRect(141,125,38,4);
    return { format:'niria-avatar-prototype',version:1,width:1024,height:1536,original,
      actions:{blink:canvas.toDataURL('image/png')} };
  })()`);
  try {
    store.mutate((state) => { state.avatar = validateAvatar(fixture); });
    await navigate("/avatar");
    await wait("document.querySelector('#source-caption')?.textContent.includes('已载入') && !document.querySelector('#save-companion').disabled");
    const initialKey = store.avatarKey;
    await evaluate(`(() => {
      window.__safetyConfirm = window.confirm; window.confirm = () => true;
      const payload = ${JSON.stringify({ ...fixture, actions: { ...fixture.actions, curious: fixture.original } })};
      const file = new File([JSON.stringify(payload)], 'image-safety-edit.json', {type:'application/json'});
      const transfer = new DataTransfer(); transfer.items.add(file);
      const input = document.querySelector('#import-package'); input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    await wait("document.querySelector('#asset-count').textContent === '2 / 4' && !document.querySelector('#save-companion').disabled");
    await evaluate(`(() => {
      window.__safetyFetch = window.fetch;
      window.__safetyUploads = 0;
      window.fetch = async (input, options) => {
        if(input === '/api/avatar') {
          window.__safetyUploads++;
          await new Promise(resolve => window.__safetyRelease = resolve);
        }
        return window.__safetyFetch(input, options);
      };
      document.querySelector('#save-companion').click();
      document.querySelector('#save-companion').click();
    })()`);
    await wait("window.__safetyUploads === 1 && document.querySelector('#save-companion').disabled");
    await evaluate("window.__safetyRelease(); window.fetch = window.__safetyFetch; void 0");
    await wait("document.querySelector('#notice').textContent.includes('已保存到伴侣') && !document.querySelector('#save-companion').disabled");
    const firstKey = store.avatarKey;
    result.imageDuplicateSaveBlocked = firstKey !== initialKey && await evaluate("window.__safetyUploads === 1");
    await evaluate("document.querySelector('#save-companion').click()");
    await wait("!document.querySelector('#save-companion').disabled");
    result.imageSuccessfulSaveAdvancesBasis = store.avatarKey === firstKey;

    store.mutate((state) => { state.avatar = validateAvatar({ ...fixture, actions: { curious: fixture.original } }); });
    const changed = structuredClone(store.state.avatar);
    await evaluate("document.querySelector('#save-companion').click()");
    await wait("document.querySelector('#save-status').textContent.includes('别处改变') && document.querySelector('#save-companion').disabled");
    result.imageStaleEditorPreservesNewAvatar = JSON.stringify(store.state.avatar) === JSON.stringify(changed);
    result.imageStaleEditorCanExport = await evaluate("!document.querySelector('#export-button').disabled");

    // Reopen on the new basis, then check cancellation before face inspection
    // finishes. The callback is deliberately delivered after termination.
    store.mutate((state) => { state.avatar = validateAvatar(fixture); });
    await navigate("/avatar");
    await wait("document.querySelector('#source-caption')?.textContent.includes('已载入') && !document.querySelector('#save-companion').disabled");
    await evaluate(`(() => {
      window.__safetyWorker = window.Worker;
      window.Worker = class {
        postMessage(data) { window.__safetyHeldFace = this; }
        terminate() { this.terminated = true; }
      };
      document.querySelector('[data-view="blink"]').click();
    })()`);
    await wait("document.querySelector('#review-dialog').open && !!window.__safetyHeldFace");
    await evaluate(`document.querySelector('#discard-result').click()`);
    await wait("!document.querySelector('#review-dialog').open && window.__safetyHeldFace.terminated");
    await evaluate(`window.__safetyHeldFace.onmessage({data:{result:{faces:[]}}}); window.Worker = window.__safetyWorker; void 0`);
    result.imageClosedFaceReviewStaysClosed = await evaluate("!document.querySelector('#review-dialog').open && document.querySelector('#asset-count').textContent === '1 / 4'");

    // Controlled UI substitute: no upstream generation is made. Hold only the
    // comparison Worker after returning a synthetic frame to the page.
    await evaluate(`(() => {
      window.__safetyFetch = window.fetch;
      window.__safetySyntheticRequests = 0;
      window.fetch = async (input, options) => {
        if(input === '/api/generate') {
          window.__safetySyntheticRequests++;
          return new Response(JSON.stringify({image:${JSON.stringify(fixture.original)},action:'smile'}),{headers:{'Content-Type':'application/json'}});
        }
        return window.__safetyFetch(input, options);
      };
      window.Worker = class {
        postMessage(data) {
          if(data.type === 'faces') queueMicrotask(() => this.onmessage?.({data:{result:{faces:[]}}}));
          else window.__safetyHeldAlignment = this;
        }
        terminate() { this.terminated = true; }
      };
      document.querySelector('#settings-button').click();
      document.querySelector('#base-url').value = 'http://127.0.0.1:9/v1';
      document.querySelector('#model').value = 'isolated-image-safety';
      document.querySelector('#image-remember').checked = false;
      document.querySelector('#image-reuse').checked = false;
      document.querySelector('#api-key').value = '';
      document.querySelector('#settings-form').requestSubmit();
    })()`);
    await wait("!document.querySelector('#settings-dialog').open");
    await evaluate("document.querySelector('[data-generate=\"smile\"]').click()");
    await wait("document.querySelector('#confirm-dialog').open");
    await evaluate("document.querySelector('#confirm-generate').click()");
    await wait("!!window.__safetyHeldAlignment && document.querySelector('#review-dialog').open");
    await evaluate("document.querySelector('#discard-result').click()");
    await wait("window.__safetyHeldAlignment.terminated && !document.querySelector('#review-dialog').open && !document.querySelector('[data-generate=\"smile\"]').disabled");
    await evaluate(`window.__safetyHeldAlignment.onmessage({data:{result:{suggested:true,x:20,y:20,scale:1,baseline:.2,score:.95}}})`);
    result.imageClosedAlignmentReviewStaysClosed = await evaluate("!document.querySelector('#review-dialog').open && document.querySelector('#asset-count').textContent === '1 / 4' && document.querySelector('[data-action=\"smile\"] .asset-status').textContent === '待生成'");
    result.imageReviewCancelMakesNoRetry = await evaluate("window.__safetySyntheticRequests === 1");
    await evaluate("window.Worker = window.__safetyWorker; window.fetch = window.__safetyFetch; void 0");

    const workerChecks = await evaluate(`(async () => {
      const {compareFrames,imageFrom} = await import('/image-tools.js'), image = await imageFrom(${JSON.stringify(fixture.original)});
      const OriginalWorker = window.Worker, checks = {};
      try {
        let worker;
        window.Worker = class { constructor(){worker=this;} postMessage(){} terminate(){this.terminated=true;} };
        const controller = new AbortController(), pending = compareFrames(image,image,{signal:controller.signal});
        controller.abort();
        try { await pending; } catch(error){ checks.alignmentAbortRejects = error.name === 'AbortError'; }
        checks.alignmentAbortTerminatesWorker = worker.terminated === true;
        window.Worker = class { postMessage(){throw new Error('isolated clone failure');} terminate(){checks.alignmentSendFailureTerminatesWorker=true;} };
        try { await compareFrames(image,image); } catch(error){checks.alignmentSendFailureExplained=error.message.includes('无法启动');}
        let constructed = false;
        window.Worker = class {constructor(){constructed=true;}};
        try { await compareFrames(image,image,{signal:controller.signal}); } catch(error){checks.alignmentAlreadyAbortedSkipsWorker=!constructed&&error.name==='AbortError';}
      } finally { window.Worker = OriginalWorker; }
      return checks;
    })()`);
    Object.assign(result, workerChecks);
    result.imageSafetyNoProviderCalls = store.state.calls.length === initialCalls;
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    await evaluate(`(() => {
      window.__safetyRelease?.();
      if(window.__safetyWorker) window.Worker=window.__safetyWorker;
      if(window.__safetyFetch) window.fetch=window.__safetyFetch;
      if(window.__safetyConfirm) window.confirm=window.__safetyConfirm;
      for(const key of Object.keys(window).filter(key=>key.startsWith('__safety'))) delete window[key];
    })()`);
    store.mutate(() => { store.state = original; });
  }
}
