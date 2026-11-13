export async function verifyFrameRendering(evaluate) {
  return evaluate(`(async () => {
    const { FrameBlender } = await import('/frame-blender.js');
    const { AvatarPlayer } = await import('/avatar-player.js');
    const width = 96, height = 144;
    const frame = (left, color, alpha = 1) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = color; context.globalAlpha = alpha; context.fillRect(left, 30, 45, 80);
      return canvas.toDataURL('image/png');
    };
    const source = frame(10, '#e02020'), target = frame(35, '#2040e0'), translucent = frame(35, '#2040e0', .25);
    const decode = async data => { const image = new Image(); image.src = data; await image.decode(); return image; };
    const [reference, action, transparentAction] = await Promise.all([source, target, translucent].map(decode));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true }), blender = new FrameBlender();
    const pixel = (x, y = 65) => [...context.getImageData(x, y, 1, 1).data];
    const sample = (image, weight) => {
      context.clearRect(0, 0, width, height);
      blender.draw(context, reference, image, weight, width, height);
      return [pixel(20), pixel(40), pixel(70), pixel(3)];
    };
    const end = sample(action, 1), half = sample(action, .5), semi = sample(transparentAction, 1);
    const original = sample(action, 0), noTarget = sample(null, 1), invalid = sample(action, NaN);
    const result = {
      expressionClearsOldSilhouette: end[0][3] === 0 && end[2][3] === 255,
      blendInterpolatesAlpha: Math.abs(half[0][3] - 128) <= 1 && Math.abs(half[2][3] - 128) <= 1 && half[1][3] === 255,
      blendInterpolatesColor: Math.abs(half[1][0] - 128) <= 2 && Math.abs(half[1][2] - 128) <= 2,
      transparentTargetRetained: semi[0][3] === 0 && Math.abs(semi[1][3] - 64) <= 1,
      outsideRemainsTransparent: end[3][3] === 0 && half[3][3] === 0 && semi[3][3] === 0,
      zeroAndMissingUseSource: JSON.stringify(original) === JSON.stringify(noTarget) && JSON.stringify(original) === JSON.stringify(invalid)
    };
    context.globalAlpha = .7; context.globalCompositeOperation = 'source-over'; context.translate(1, 2);
    blender.draw(context, reference, action, .5, width, height);
    result.drawingStatePreserved = context.globalAlpha > .69 && context.globalAlpha < .71 &&
      context.globalCompositeOperation === 'source-over' && context.getTransform().e === 1 && context.getTransform().f === 2;
    context.resetTransform(); context.globalAlpha = 1;
    const player = new AvatarPlayer(canvas);
    try {
      const at = new Date(Date.now() - 1000).toISOString();
      await player.update({ messages: [{ role: 'assistant', status: 'completed', expression: { name: 'smile', avatarKey: 'isolated-cutouts', at } }],
        avatarKey: 'isolated-cutouts', avatar: { source, actions: { smile: target, blink: target } } });
      player.draw();
      result.playerClearsOldSilhouette = pixel(20)[3] === 0 && pixel(70)[3] === 255;
      player.pose = { name: 'neutral', until: 0, at: 0 };
      player.blinkStart = 1000; player.nextBlink = 5000; player.draw(1090);
      if (player.reduced.matches) result.reducedMotionSkipsBlink = pixel(20)[3] === 255 && pixel(70)[3] === 0;
      else result.blinkClearsOldSilhouette = pixel(20)[3] === 0 && pixel(70)[3] === 255;
      player.blinkStart = 0; player.nextBlink = 5000; player.draw(1500);
      result.blinkReturnsToSource = pixel(20)[3] === 255 && pixel(70)[3] === 0;
    } finally { player.destroy(); blender.destroy(); }
    return result;
  })()`);
}
