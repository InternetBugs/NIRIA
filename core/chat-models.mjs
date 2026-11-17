import { chatEndpoint, validateChatAccess } from "./chat-service.mjs";
import { ServiceError } from "../prototype/image-service.mjs";

export async function listChatModels(input, { signal, fetchImpl = fetch } = {}) {
  const { baseUrl, apiKey } = validateChatAccess(input);
  const endpoint = new URL(chatEndpoint(baseUrl));
  endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions$/, "/models");
  try {
    const response = await fetchImpl(endpoint.href, {
      method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError(502, [401, 403].includes(response.status)
        ? "获取模型列表被拒绝，请检查密钥与访问权限。"
        : [404, 405, 501].includes(response.status) ? "服务不支持模型列表，请手动填写模型名称。"
          : response.status === 429 ? "获取模型列表受到限流，请稍后手动重试。"
            : "未能获取模型列表，请核对 API 根地址，或手动填写模型名称。");
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new ServiceError(502, "模型列表过大，请手动填写模型名称。");
      chunks.push(chunk);
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(payload?.data) || payload.data.length > 10000 ||
        payload.data.some((item) => typeof item?.id !== "string" || !item.id.trim() ||
          item.id.trim().length > 150 || /[\u0000-\u001f\u007f]/.test(item.id))) {
      throw new ServiceError(502, "服务返回的模型列表格式无效，请手动填写模型名称。");
    }
    return { models: [...new Set(payload.data.map((item) => item.id.trim()))].sort() };
  } catch (error) {
    if (signal?.aborted || ["AbortError", "TimeoutError"].includes(error?.name)) {
      throw new ServiceError(504, "获取模型列表已取消或超时，可以重新获取或手动填写模型名称。");
    }
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, "未能读取模型列表，请检查网络和接口兼容性，或手动填写模型名称。");
  }
}
