import assert from "node:assert/strict";

// Optional real-material cases are supplied from local artifacts, never shipped.
export async function verifyAnimeFace({ evaluate, examples }) {
  const results = [];
  for (const example of examples) {
    const report = await evaluate(`(async () => {
      const { inspectCharacterImage, imageFrom } = await import('/image-tools.js');
      const image = await imageFrom(${JSON.stringify(example.url)});
      return inspectCharacterImage(image);
    })()`);
    assert.equal(report.faceCheck.faces.length, example.count, example.name);
    assert.equal(report.issues.some(issue => issue.code === "multiple-faces" && issue.blocking), example.count > 1, example.name);
    if (!example.count) assert.equal(report.issues.some(issue => issue.code === "face-unconfirmed" && !issue.blocking), true);
    results.push({ name: example.name, status: report.faceCheck.status, faces: report.faceCheck.faces.length });
  }
  const checks = await evaluate(`(async () => {
    const { inspectCharacterImage, imageFrom, prepareImageFile } = await import('/image-tools.js');
    const image = await imageFrom(${JSON.stringify(examples[0].url)});
    const originalFetch = window.fetch, OriginalWorker = window.Worker;
    const result = {};
    try {
      window.Worker = undefined;
      const fallback = await inspectCharacterImage(image);
      result.noWorkerFallbackDetects = fallback.faceCheck.faces.length === 1;
      window.fetch = async () => new Response('', {status:503});
      const failed = await inspectCharacterImage(image);
      result.failureExplained = failed.faceCheck.status === 'unavailable' &&
        failed.issues.some(issue => issue.code === 'face-unavailable' && !issue.blocking);
      window.fetch = originalFetch;
      window.Worker = class { postMessage() {} terminate() { result.workerTerminated = true; } };
      const controller = new AbortController();
      const pending = inspectCharacterImage(image, {signal:controller.signal});
      controller.abort();
      try { await pending; } catch (error) { result.cancelled = error.name === 'AbortError'; }
      window.Worker = OriginalWorker;
      const two = await imageFrom(${JSON.stringify(examples.find(example => example.count === 2).url)});
      const canvas = document.createElement('canvas'); canvas.width = two.naturalWidth; canvas.height = two.naturalHeight;
      canvas.getContext('2d').drawImage(two,0,0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      try { await prepareImageFile(new File([blob], 'two.png', {type:'image/png'})); }
      catch (error) { result.multipleFacesRejected = error.message.includes('多张'); }
    } finally { window.fetch = originalFetch; window.Worker = OriginalWorker; }
    return result;
  })()`);
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
  assert.equal(Object.keys(checks).length, 5);
  // Actual image import UI preserves the last adopted frame on a rejected input.
  await evaluate(`(async () => {
    const select = async (url) => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image,0,0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve)), transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'face-check.png', {type:'image/png'}));
      const input = document.querySelector('#source-image');
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
    };
    window.__faceSelect = select;
    await select(${JSON.stringify(examples[0].url)});
  })()`);
  const wait = async (expression) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Face-check UI condition failed: ${expression}`);
  };
  await wait("!document.querySelector('#play-button').disabled && document.querySelector('#notice').textContent.includes('已导入')");
  await evaluate("document.querySelector('#play-button').click(); window.__faceOriginal = document.querySelector('#portrait').toDataURL()");
  await evaluate(`window.__faceSelect(${JSON.stringify(examples.find(example => example.count === 2).url)})`);
  await wait("document.querySelector('#notice').textContent.includes('多张')");
  assert.equal(await evaluate("document.querySelector('#portrait').toDataURL() === window.__faceOriginal"), true);
  // Hold an old File.text(), choose a new image, then release the stale package.
  await evaluate(`(() => {
    const file = new File(['{}'], 'old-package.json', {type:'application/json'});
    file.text = () => new Promise(resolve => window.__faceRelease = () => resolve('{}'));
    const input = document.querySelector('#import-package');
    Object.defineProperty(input, 'files', {configurable:true, get:() => [file]});
    input.dispatchEvent(new Event('change'));
  })()`);
  await evaluate(`window.__faceSelect(${JSON.stringify(examples[0].url)})`);
  await wait("!document.querySelector('#export-button').disabled && document.querySelector('#notice').textContent.includes('已导入')");
  await evaluate("window.__faceRelease()");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate("document.querySelector('#notice').textContent.includes('已导入') && !document.querySelector('#export-button').disabled"), true);
  await evaluate("delete window.__faceSelect; delete window.__faceOriginal; delete window.__faceRelease");
  return { results, checks, rejectionPreservesImage: true, stalePackageDiscarded: true };
}
