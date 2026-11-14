import { ServiceError } from "../prototype/image-service.mjs";
import { validateAvatar } from "./store.mjs";

export function adoptImageAvatar(store, input, { beforeApply = () => {} } = {}) {
  const { avatar, identityId, expectedAvatarKey } = input || {};
  if (avatar?.format !== "niria-avatar-prototype" || typeof identityId !== "string" ||
      !(expectedAvatarKey === null || typeof expectedAvatarKey === "string" && /^[a-f0-9]{64}$/.test(expectedAvatarKey))) {
    throw new ServiceError(400, "请重新打开形象页面，再确认保存图片形象；Live2D 请从模型预览中采用。");
  }
  const check = () => {
    if (store.state.identity.id !== identityId || store.avatarKey !== expectedAvatarKey) {
      throw new ServiceError(409, "伴侣或形象已在别处改变，本次图片未覆盖新资料。请先导出当前素材，再重新打开形象页面。");
    }
  };
  check();
  const accepted = validateAvatar(avatar);
  beforeApply();
  store.mutate((state) => {
    check();
    state.avatar = accepted;
  });
  return { ok: true, identityId: store.state.identity.id, avatarKey: store.avatarKey };
}
