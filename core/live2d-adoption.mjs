import { ServiceError } from "../prototype/image-service.mjs";
import { validateAvatar } from "./store.mjs";

export function adoptLive2D(store, input, { runtimeReady = false, beforeApply = () => {} } = {}) {
  const { avatar, expectedAvatarKey, identityId } = input || {};
  if (avatar?.format !== "niria-live2d-avatar" ||
      !(expectedAvatarKey === null || typeof expectedAvatarKey === "string" && /^[a-f0-9]{64}$/.test(expectedAvatarKey)) ||
      typeof identityId !== "string") throw new ServiceError(400, "请先预览 Live2D 模型，再采用。");
  if (store.avatarKey !== expectedAvatarKey || store.state.identity.id !== identityId)
    throw new ServiceError(409, "伴侣或形象已经改变，请重新打开 Live2D 预览。");
  const accepted = validateAvatar(avatar);
  if (!runtimeReady) throw new ServiceError(503, "Live2D 播放组件尚未就绪，未替换当前形象。");
  beforeApply();
  store.mutate((state) => { state.avatar = accepted; });
  return { ok: true };
}
