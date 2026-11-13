export function hasAvatarExpression(avatar, name) {
  if (!["smile", "curious", "shy"].includes(name)) return false;
  return avatar?.format === "niria-live2d-avatar"
    ? typeof avatar.bindings?.expressions?.[name] === "string" && !!avatar.bindings.expressions[name]
    : typeof avatar?.actions?.[name] === "string";
}
