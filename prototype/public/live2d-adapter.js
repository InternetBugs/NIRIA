const shaderPath = new URL("./vendor/live2d/shaders/WebGL/", import.meta.url).href;
let coreReady, frameworkReady;
const contexts = new Set();

function loadCore() {
  if (!coreReady) {
    coreReady = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(() => { script.remove(); reject(new Error("Live2D 播放组件载入超时，请手动重新预览。")); }, 15000);
      const done = (error) => {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) { script.remove(); reject(error); } else resolve(globalThis.Live2DCubismCore);
      };
      script.onload = async () => {
        try {
          const deadline = performance.now() + 14000;
          for (;;) {
            try { if (globalThis.Live2DCubismCore?.Version.csmGetVersion()) break; } catch { /* Embedded WebAssembly is still compiling. */ }
            if (performance.now() > deadline) throw new Error();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          done();
        } catch { done(new Error("Live2D 播放组件未能初始化，请核对本机版本。")); }
      };
      script.onerror = () => done(new Error("Live2D 本机播放文件无法载入，请重新安装完整应用。"));
      script.src = new URL("./vendor/live2d/live2dcubismcore.min.js", import.meta.url).href;
      document.head.append(script);
    }).catch((error) => { coreReady = null; throw error; });
  }
  return coreReady;
}
async function loadFramework() {
  if (!frameworkReady) frameworkReady = (async () => {
    await loadCore();
    // Some SDK module constants read Core as the module is evaluated.
    const framework = await import("./vendor/live2d/cubism-framework.js");
    const option = new framework.Option();
    option.logFunction = () => {};
    option.loggingLevel = framework.LogLevel.LogLevel_Off;
    if (!framework.CubismFramework.startUp(option)) throw new Error("Live2D Framework 初始化失败。");
    framework.CubismFramework.initialize();
    return framework;
  })().catch((error) => { frameworkReady = null; throw error; });
  return frameworkReady;
}
const bufferOf = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const invalid = (message) => { throw new Error(message); };
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

// Bound counts before asking SDK parsers to allocate from model-supplied Meta.
function checkJson(value, kind) {
  if (kind === "motion") {
    const meta = value.Meta, curves = value.Curves;
    if (value.Version !== 3 || !meta || !finite(meta.Duration, .001, 3600) ||
        !finite(meta.Fps, .1, 240) || !Array.isArray(curves) || curves.length > 4096 ||
        meta.CurveCount !== curves.length || !finite(meta.TotalSegmentCount, 0, 100000) ||
        !finite(meta.TotalPointCount, 0, 300000) || !finite(meta.UserDataCount ?? 0, 0, 4096))
      invalid("模型动作的时长、曲线或数量无效，未采用该模型。");
    for (const curve of curves) {
      if (!["Model", "Parameter", "PartOpacity"].includes(curve.Target) ||
          typeof curve.Id !== "string" || !Array.isArray(curve.Segments) || curve.Segments.length < 2 ||
          curve.Segments.length > 300000 || curve.Segments.some((number) => !finite(number, -1e8, 1e8)))
        invalid("模型动作曲线无效，未采用该模型。");
    }
  }
  if (kind === "expression" && (!Array.isArray(value.Parameters) || value.Parameters.length > 4096 ||
      value.Parameters.some((entry) => typeof entry.Id !== "string" || !finite(entry.Value, -1e8, 1e8) ||
        entry.Blend && !["Add", "Multiply", "Overwrite"].includes(entry.Blend))))
    invalid("模型表情参数无效，未采用该模型。");
  if (kind === "physics") {
    if (value.Version !== 3 || !value.Meta || !Array.isArray(value.PhysicsSettings) ||
        value.PhysicsSettings.length > 512 || value.Meta.PhysicsSettingCount !== value.PhysicsSettings.length ||
        !finite(value.Meta.TotalInputCount, 0, 4096) || !finite(value.Meta.TotalOutputCount, 0, 4096) ||
        !finite(value.Meta.VertexCount, 0, 10000))
      invalid("模型物理参数或数量无效，未采用该模型。");
  }
  return value;
}

export async function createCubismRuntime({ canvas, assets, model: modelPath, bindings, signal }) {
  const check = () => signal?.throwIfAborted();
  check();
  const core = await loadCore();
  const { CubismUserModel, CubismModelSettingJson, CubismMatrix44,
    CubismEyeBlink, CubismBreath, BreathParameterData, CubismMotion,
    CubismExpressionMotion, CubismShaderManager_WebGL } = await loadFramework();
  check();
  const description = assets.json(modelPath), ref = description.FileReferences;
  const bytes = (path) => bufferOf(assets.read(path, modelPath));
  const json = (path, kind) => checkJson(assets.json(path, modelPath), kind);
  const moc = bytes(ref.Moc);
  if (core.Moc.prototype.hasMocConsistency(moc) !== 1)
    invalid("模型 .moc3 已损坏或超出当前 Cubism 运行库支持范围，原形象保留。");
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true }) ||
    canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true });
  if (!gl) invalid("本机无法启用 WebGL，不能预览 Live2D；可以继续使用图片形象。");
  contexts.add(gl);
  const user = new CubismUserModel(), textures = [], motions = [], expressions = new Map();
  let destroyed = false, lastExpression, idleIndex = 0, lastIdle, firstFrame = true, setting;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    setting?.release(); setting = null;
    user.release();
    for (const texture of textures) gl.deleteTexture(texture);
    for (const motion of motions) CubismMotion.delete(motion);
    for (const expression of expressions.values()) CubismExpressionMotion.delete(expression);
    const manager = CubismShaderManager_WebGL.getInstance();
    // This adapter is pinned to 5-r.5, whose manager has no remove-context API.
    // Remove only this context so another preview keeps its own shader programs.
    manager.getShader(gl)?.release();
    manager._shaderMap.delete(gl);
    contexts.delete(gl);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
  try {
    user.loadModel(moc, true);
    if (!user._model || !user._modelMatrix) invalid("模型无法创建可播放实例，原形象保留。");
    const settingBuffer = bufferOf(assets.read(modelPath));
    setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);
    const actual = user._model;
    if (![actual.getCanvasWidth(), actual.getCanvasHeight()].every((size) => finite(size, .0001, 1e6)))
      invalid("模型画布尺寸无效。");
    user._eyeBlink = CubismEyeBlink.create(setting);
    const breathId = Array.from({ length: actual.getParameterCount() }, (_, index) => actual.getParameterId(index))
      .find((id) => id.getString() === "ParamBreath");
    if (breathId) {
      user._breath = CubismBreath.create();
      user._breath.setParameters([new BreathParameterData(breathId, .5, .5, 3.2, 1)]);
    }
    for (const [key, kind, load] of [
      ["Physics", "physics", "loadPhysics"], ["Pose", "pose", "loadPose"]
    ]) if (ref[key]) {
      json(ref[key], kind);
      const data = bytes(ref[key]); user[load](data, data.byteLength);
    }
    for (const entry of ref.Expressions || []) {
      json(entry.File, "expression");
      const data = bytes(entry.File), expression = user.loadExpression(data, data.byteLength, entry.Name);
      if (!expression) invalid("模型包含无法播放的表情。");
      expressions.set(entry.Name, expression);
    }
    const groups = new Map();
    for (const [group, entries] of Object.entries(ref.Motions || {})) {
      const loaded = [];
      for (const [index, entry] of entries.entries()) {
        json(entry.File, "motion");
        const data = bytes(entry.File);
        const motion = user.loadMotion(data, data.byteLength, `${group}:${index}`, undefined, undefined, setting, group, index, true);
        if (!motion) invalid("模型包含无法播放的动作曲线。");
        motion.setEffectIds(user._eyeBlink.getParameterIds(), []);
        loaded.push(motion); motions.push(motion);
      }
      groups.set(group, loaded);
    }
    user.createRenderer(canvas.width, canvas.height);
    const renderer = user.getRenderer();
    renderer.startUp(gl);
    renderer.setIsPremultipliedAlpha(true);
    for (const [index, path] of ref.Textures.entries()) {
      check();
      const image = new Image();
      image.src = assets.url(path, modelPath);
      try { await image.decode(); }
      catch { invalid("模型 PNG 纹理无法完整解码，原形象保留。"); }
      check();
      if (image.naturalWidth > gl.getParameter(gl.MAX_TEXTURE_SIZE) || image.naturalHeight > gl.getParameter(gl.MAX_TEXTURE_SIZE))
        invalid("模型纹理超过本机显卡支持的尺寸。");
      const texture = gl.createTexture();
      if (!texture) invalid("本机无法分配模型纹理。");
      textures.push(texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (gl.getError() !== gl.NO_ERROR) invalid("模型纹理无法上传到本机显卡。");
      renderer.bindTexture(index, texture);
    }
    renderer.loadShaders(shaderPath);
    const shader = CubismShaderManager_WebGL.getInstance().getShader(gl), deadline = performance.now() + 20000;
    while (!shader._isShaderLoaded) {
      // Let the SDK's already-started local shader fetches settle before
      // disposal, so their callbacks cannot write into a released renderer.
      if (gl.isContextLost() || performance.now() > deadline) invalid("Live2D 着色器未能初始化，请手动重新预览。");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // R5 reserves three unused trailing slots for Normal/Over, which is served
    // by the compatible shaders. Check every registered program, not the holes.
    const usedShaders = [...Array.from({ length: 11 }, (_, index) => index),
      ...[...shader._blendShaderSetMap.values()].flatMap((index) => [index, index + 1, index + 2])];
    if (usedShaders.some((index) => !shader._shaderSets[index]?.shaderProgram ||
        !gl.getProgramParameter(shader._shaderSets[index].shaderProgram, gl.LINK_STATUS)))
      invalid("本机无法编译 Live2D 着色器。");
    check();
    setting.release(); setting = null;
    // Fit the model's authored canvas into the viewport with transparent margins.
    const projection = new CubismMatrix44();
    const aspect = canvas.width / canvas.height, modelAspect = actual.getCanvasWidth() / actual.getCanvasHeight();
    projection.scale(.94 * Math.min(1, 1 / (modelAspect / aspect)) / aspect, .94 * Math.min(1, aspect / modelAspect));
    projection.multiplyByMatrix(user._modelMatrix);
    return {
      render({ delta, expression, idleGroup, reducedMotion }) {
        if (destroyed || gl.isContextLost()) invalid("Live2D 显示上下文已释放。");
        const dt = reducedMotion ? 0 : delta;
        actual.loadParameters();
        if (lastIdle !== idleGroup) { user._motionManager.stopAllMotions(); lastIdle = idleGroup; idleIndex = 0; }
        const idle = groups.get(idleGroup) || [];
        if (!reducedMotion && idle.length && user._motionManager.isFinished())
          user._motionManager.startMotionPriority(idle[idleIndex++ % idle.length], false, 1);
        // Re-evaluating a partially faded motion at delta=0 repeatedly blends
        // into its last saved values, visibly drifting even with time frozen.
        const updated = dt > 0 ? user._motionManager.updateMotion(actual, dt) : false;
        if (dt > 0) actual.saveParameters();
        if (!updated && dt) user._eyeBlink.updateParameters(actual, dt);
        const expressionChanged = lastExpression !== expression;
        if (expressionChanged) {
          user._expressionManager.stopAllMotions(); lastExpression = expression;
          if (expression && expressions.has(expression))
            user._expressionManager.startMotion(expressions.get(expression), false);
        }
        if (expression) {
          // Reduced motion renders once. Settle expression fade-in during that
          // draw while leaving idle, blinking, breath and physics paused.
          if (reducedMotion && expressionChanged) user._expressionManager.updateMotion(actual, 0);
          const expressionDelta = reducedMotion && expressionChanged ?
            Math.min(60, Math.max(0, expressions.get(expression)?.getFadeInTime() || 0)) + .001 : dt;
          user._expressionManager.updateMotion(actual, expressionDelta);
        }
        if (dt) { user._breath?.updateParameters(actual, dt); user._physics?.evaluate(actual, dt); }
        user._pose?.updateParameters(actual, dt);
        actual.update();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        renderer.setMvpMatrix(projection);
        renderer.setRenderState(null, [0, 0, canvas.width, canvas.height]);
        renderer.drawModel();
        if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) invalid("Live2D 绘制失败。");
        if (firstFrame) {
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) invalid("模型首帧没有可见图像，请检查模型姿态或画布。");
          firstFrame = false;
        }
      },
      destroy
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
