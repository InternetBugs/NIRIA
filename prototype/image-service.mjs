export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const ACTIONS = Object.freeze({
  blink: {
    label: "闭眼",
    instruction: "Close both eyes naturally for a blink. Keep the mouth and expression unchanged."
  },
  smile: {
    label: "微笑",
    instruction: "Give the character a small, warm smile, with eyes open."
  },
  curious: {
    label: "疑惑",
    instruction: "Give the character a subtle curious expression, with eyes open. Do not tilt the head."
  },
  shy: {
    label: "害羞",
    instruction: "Give the character a subtle shy expression and a light blush, with eyes open."
  }
});

export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export function imageEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceError(400, "请填写完整的生成服务地址。");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ServiceError(400, "远程服务请使用 HTTPS；本机服务可以使用 HTTP。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ServiceError(400, "服务地址不能包含账号、查询参数或片段，请单独填写密钥。");
  }
  const base = url.pathname.replace(/\/+$/, "");
  if (/\/images\/(?:edits|generations)$/.test(base)) {
    throw new ServiceError(400, "请填写 API 根地址，例如 https://api.openai.com/v1。");
  }
  url.pathname = `${base}/images/edits`;
  return url.href;
}

export function pngBytes(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
    throw new ServiceError(400, "请先导入图片，生成请求需要 PNG 素材。");
  }
  const encoded = dataUrl.slice("data:image/png;base64,".length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new ServiceError(400, "图片数据格式无效，请重新导入。");
  }
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new ServiceError(413, "图片超过 8 MB，请缩小后重试。");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new ServiceError(400, "素材不是有效的 PNG 图片。");
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 20_000_000) throw new ServiceError(413, "PNG 图片尺寸无效或超过 2000 万像素，请缩小后重新导入。");
  return bytes;
}

function upstreamFailure(status) {
  if (status === 401 || status === 403) {
    return "服务拒绝了请求，请检查密钥和图片模型的访问权限。";
  }
  if (status === 429) {
    return "服务当前限流或额度不足，请检查服务控制台后再决定是否重试。";
  }
  if (status === 400 || status === 404 || status === 422) {
    return "服务未接受图片编辑请求，请核对 API 根地址、模型和图片编辑能力。";
  }
  return "生成服务暂时不可用，请检查服务状态后再决定是否重试。";
}

export function validateImageConnection(input) {
  if (!input || typeof input !== "object") {
    throw new ServiceError(400, "请求内容无效。");
  }
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!model || model.length > 150) {
    throw new ServiceError(400, "请填写图片编辑模型的名称。");
  }
  if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) {
    throw new ServiceError(400, "密钥格式无效。");
  }
  imageEndpoint(input.baseUrl);
  return { baseUrl: input.baseUrl, model, apiKey, highFidelity: input.highFidelity === true, transparent: input.transparent === true };
}

export function validateImageRequest(input) {
  if (!input || typeof input !== "object") throw new ServiceError(400, "请求内容无效。");
  if (!Object.hasOwn(ACTIONS, input.action)) throw new ServiceError(400, "请选择一个支持的动作。");
  const connection = validateImageConnection(input);
  pngBytes(input.image);
  return { ...connection, action: input.action, image: input.image };
}

export async function generateAction(input, { fetchImpl = fetch, signal } = {}) {
  input = validateImageRequest(input);
  const action = ACTIONS[input.action];
  const { model, apiKey } = input;
  const endpoint = imageEndpoint(input.baseUrl);
  const bytes = pngBytes(input.image);
  const form = new FormData();
  form.set("model", model);
  form.set("n", "1");
  form.set("image", new File([bytes], "reference.png", { type: "image/png" }));
  form.set("prompt", [
    "Edit the attached reference image into ONE animation target frame.",
    action.instruction,
    "Preserve the exact identity, face shape, hairstyle, outfit, drawing style,",
    "body pose, camera framing, character scale, and background.",
    "Keep the character at exactly the same position. Make the smallest possible edit.",
    "Do not add text, watermarks, extra people, a contact sheet, or multiple panels.",
    "Return a single PNG image."
  ].join(" "));
  if (input.highFidelity === true) form.set("input_fidelity", "high");
  if (input.transparent === true) form.set("background", "transparent");

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal,
      redirect: "error"
    });
  } catch (error) {
    if (signal?.aborted || error.name === "AbortError" || error.name === "TimeoutError") {
      throw new ServiceError(504, "等待生成超时；服务可能已处理请求，请先查看服务记录，再决定是否重试。");
    }
    throw new ServiceError(502, "未能连接生成服务，请检查地址、网络及服务状态。");
  }
  if (!response.ok) {
    // Do not relay provider error bodies: gateways can echo credentials or requests.
    await response.body?.cancel();
    throw new ServiceError(502, upstreamFailure(response.status));
  }

  const responseLimit = 24 * 1024 * 1024;
  let chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > responseLimit) {
        throw new ServiceError(502, "服务返回的图片过大，请降低生成分辨率后重试。");
      }
      chunks.push(Buffer.from(chunk));
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    chunks = [];
    const encoded = result?.data?.[0]?.b64_json;
    if (typeof encoded !== "string") {
      throw new ServiceError(502, "服务没有返回 Base64 PNG 图片。此原型需要支持该输出格式的图片编辑接口。");
    }
    const image = `data:image/png;base64,${encoded}`;
    pngBytes(image);
    return { image, action: input.action, label: action.label };
  } catch (error) {
    if (signal?.aborted) {
      throw new ServiceError(504, "接收图片超时；请求可能已计费，请先检查服务记录。");
    }
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, "生成服务返回了无法读取的图片数据。");
  }
}
