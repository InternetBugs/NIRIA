import { randomUUID } from "node:crypto";
import { generateAction, validateImageRequest, ServiceError } from "../prototype/image-service.mjs";

const stopped = () => new ServiceError(504, "已停止等待图片结果或请求超时；服务可能已处理并计费，请先检查调用记录和服务端记录，没有自动重试。");
const recordingFailed = () => new ServiceError(503, "图片请求可能已经处理，但本机未能保存结果状态；已有形象仍保留，请先检查服务端记录，不要立即重试。");

export async function generateImage(store, input, { generator = generateAction, signal, clock = Date.now } = {}) {
  // Reject local input before recording an attempt or handing it to a provider.
  const request = validateImageRequest(input);
  if (signal?.aborted) throw stopped();
  const identityId = store?.state.identity.id;
  const date = new Date(clock()), day = date.toLocaleDateString("en-CA");
  const call = {
    id: randomUUID(), kind: "image", action: request.action, model: request.model,
    endpoint: new URL(request.baseUrl).origin, at: date.toISOString(), day, status: "pending"
  };
  store?.mutate((state) => {
    state.calls.push(call);
    state.calls = state.calls.slice(-500);
    state.usage ||= {};
    state.usage[day] ||= {};
    state.usage[day].image = (state.usage[day].image || 0) + 1;
    const days = Object.keys(state.usage).sort();
    for (const old of days.slice(0, Math.max(0, days.length - 40))) delete state.usage[old];
  });
  const finish = (status) => {
    // A direct restore/join may have replaced this companion or removed its
    // local call history. Never attach an old attempt to the new identity.
    if (!store || store.state.identity.id !== identityId || !store.state.calls.some((item) => item.id === call.id)) return;
    store.mutate((state) => { state.calls.find((item) => item.id === call.id).status = status; });
  };
  let recordingResult = false;
  try {
    const result = await generator(request, { signal });
    if (signal?.aborted) throw stopped();
    if (store && store.state.identity.id !== identityId) {
      throw new ServiceError(409, "伴侣已在图片请求期间改变，旧结果未交付；服务可能已经处理，请先检查服务端记录。");
    }
    recordingResult = true;
    finish("completed");
    return result;
  } catch (error) {
    const interrupted = signal?.aborted || error?.status === 504 || ["AbortError", "TimeoutError"].includes(error?.name);
    try { finish(interrupted || recordingResult ? "unknown" : "failed"); }
    catch { throw recordingFailed(); }
    if (interrupted) throw stopped();
    if (recordingResult) throw recordingFailed();
    throw error;
  }
}
