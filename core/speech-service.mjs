import { randomUUID } from "node:crypto";
import { ServiceError } from "../prototype/image-service.mjs";
import { chatEndpoint } from "./chat-service.mjs";
import { text, now, messageHash } from "./store.mjs";

const stopped = () => new ServiceError(504, "朗读已停止或超时，结果未知，服务可能已处理并计费；没有自动重试，文字回复已保留。");
const recordingFailed = () => new ServiceError(503, "朗读请求可能已经处理，但本机未能保存结果状态；文字回复已保留，请先检查服务端记录，不要立即重试。");

export async function synthesize(connection, input, { signal, fetchImpl = fetch } = {}) {
  const url = new URL(chatEndpoint(connection.baseUrl));
  url.pathname = url.pathname.replace(/\/chat\/completions$/, "/audio/speech");
  const model = text(connection.model, "朗读模型", 150);
  const voice = text(connection.voice, "声音名称", 150);
  const apiKey = text(connection.apiKey || "", "朗读密钥", 4096, true);
  if (/[\r\n]/.test(apiKey)) throw new ServiceError(400, "朗读密钥格式无效。");
  text(input, "朗读文本", 4096);
  try {
    const response = await fetchImpl(url.href, {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, voice, input, response_format: "wav" })
    });
    if (!response.ok) { await response.body?.cancel(); throw new ServiceError(502, "朗读服务未接受请求，请检查模型、声音名称和权限。文字回复已保留。"); }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > 24 * 1024 * 1024) throw new ServiceError(502, "朗读音频超过 24 MB 上限，文字回复已保留。");
      chunks.push(Buffer.from(chunk));
    }
    const audio = Buffer.concat(chunks);
    if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") throw new ServiceError(502, "朗读服务没有返回 WAV 音频，请检查接口兼容性。");
    return { mime: "audio/wav", audio: audio.toString("base64") };
  } catch (error) {
    if (signal?.aborted) throw new ServiceError(504, "朗读已停止或超时，服务可能已处理；没有自动重试，文字回复已保留。");
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, "无法连接或读取朗读服务，文字回复已保留。");
  }
}

export function validateSpeechConnection(input) {
  chatEndpoint(input.baseUrl);
  const model = text(input.model, "朗读模型", 150), voice = text(input.voice, "声音名称", 150);
  const apiKey = text(input.apiKey || "", "朗读密钥", 4096, true);
  if (/[\r\n]/.test(apiKey) || typeof input.auto !== "boolean" || !Number.isInteger(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > 100) throw new ServiceError(400, "朗读设置无效，每日上限需要为 1 到 100 次。");
  return { baseUrl: input.baseUrl, model, voice, apiKey, auto: input.auto, dailyLimit: input.dailyLimit };
}

export class SpeechService {
  constructor(store, { synthesis = synthesize, timeoutMs = 60_000 } = {}) {
    this.store = store;
    this.synthesis = synthesis;
    this.timeoutMs = timeoutMs;
    this.connection = null;
    this.active = null;
    this.attempted = new Set();
  }
  configure(input) {
    if (this.active) throw new ServiceError(409, "请先停止正在进行的朗读。");
    this.connection = validateSpeechConnection(input);
    return this.status();
  }
  status() {
    const { baseUrl = "", model = "", voice = "", auto = false, dailyLimit = 20 } = this.connection || {};
    return { configured: !!this.connection, busy: !!this.active, baseUrl, model, voice, auto, dailyLimit, historyId: this.store.restoreVersion };
  }
  cancel() { this.active?.abort(); }
  async speak(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ServiceError(400, "朗读请求无效。");
    const { id, automatic = false, test = false } = input;
    if (typeof automatic !== "boolean" || typeof test !== "boolean" || (automatic && test)) throw new ServiceError(400, "朗读请求开关无效。");
    if (!this.connection) throw new ServiceError(400, "请先配置独立的朗读服务。");
    if (this.active) throw new ServiceError(409, "已有朗读请求正在处理。");
    if (automatic && !this.connection.auto) throw new ServiceError(400, "自动朗读未开启。");
    let message;
    if (!test) {
      message = this.store.findMessage(id);
      if (message.role !== "assistant" || message.status !== "completed" || message.conflicted) throw new ServiceError(400, "只能朗读已完成且没有冲突的伴侣回复。");
      if (automatic && this.attempted.has(id)) throw new ServiceError(409, "此回复已尝试自动朗读，不会自动重复调用。");
    }
    const content = test ? "你好，我在这里。很高兴和你慢慢相处。" : message.content;
    text(content, "朗读文本", 4096);
    const day = new Date().toLocaleDateString("en-CA");
    if ((this.store.state.usage?.[day]?.speech || 0) >= this.connection.dailyLimit) throw new ServiceError(429, "已达到今天的朗读请求上限，文字聊天不受影响。");
    const controller = new AbortController();
    this.active = controller;
    const identityId = this.store.state.identity.id;
    const historyId = this.store.restoreVersion;
    const sourceHash = message && messageHash(message);
    const call = { id: randomUUID(), kind: "speech", model: this.connection.model, endpoint: new URL(this.connection.baseUrl).origin, at: now(), day, status: "pending" };
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const finish = (status) => {
      if (this.store.state.identity.id !== identityId || this.store.restoreVersion !== historyId ||
          !this.store.state.calls.some((item) => item.id === call.id)) return;
      this.store.mutate((state) => { state.calls.find((item) => item.id === call.id).status = status; });
    };
    let recorded = false, recordingResult = false;
    try {
      this.store.mutate((state) => {
        state.calls.push(call); state.calls = state.calls.slice(-500);
        state.usage ||= {};
        state.usage[day] ||= {}; state.usage[day].speech = (state.usage[day].speech || 0) + 1;
        const days = Object.keys(state.usage).sort();
        for (const old of days.slice(0, Math.max(0, days.length - 40))) delete state.usage[old];
      });
      recorded = true;
      if (automatic) this.attempted.add(id);
      const result = await this.synthesis(this.connection, content, { signal: controller.signal });
      if (controller.signal.aborted) throw stopped();
      const current = message && this.store.state.messages.find((m) => m.id === id);
      if (this.store.state.identity.id !== identityId || this.store.restoreVersion !== historyId ||
          (message && (!current || current.deleted || current.conflicted || current.status !== "completed" || messageHash(current) !== sourceHash))) {
        throw new ServiceError(409, "伴侣或来源回复已经改变，旧音频未播放。");
      }
      recordingResult = true;
      finish("completed");
      return result;
    } catch (error) {
      if (!recorded) throw new ServiceError(503, "本机未能保存朗读调用记录，未向服务提交请求；文字回复已保留，请检查本机存储后再试。");
      const interrupted = controller.signal.aborted || error?.status === 504 || ["AbortError", "TimeoutError"].includes(error?.name);
      try { finish(interrupted || recordingResult ? "unknown" : "failed"); }
      catch { throw recordingFailed(); }
      if (recordingResult) throw recordingFailed();
      if (interrupted) throw stopped();
      throw error instanceof ServiceError ? error : new ServiceError(502, "朗读未完成，文字回复已保留。");
    } finally {
      clearTimeout(timer);
      if (this.active === controller) this.active = null;
    }
  }
}
