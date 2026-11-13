import { hasAvatarExpression } from "../prototype/public/avatar-expressions.js";

export const EXPRESSIONS = Object.freeze(["neutral", "smile", "curious", "shy"]);

export function expressionOptions(avatar) {
  return ["neutral", ...EXPRESSIONS.slice(1).filter((name) => hasAvatarExpression(avatar, name))];
}

export function expressionPrompt(avatar) {
  const names = expressionOptions(avatar);
  if (names.length === 1) return "";
  return [
    "应用会播放已经配置好的形象表情。根据你本次回复的语气选择表情，不判断用户的心理或关系等级。",
    `仅可选择：${names.join("、")}。平常或不合适时选择 neutral；不要为了表情改变回复内容。`,
    "正文仍为自然聊天，不写舞台动作；在正文之后另起最后一行输出 [NIRIA_EXPRESSION:所选名称]。",
    `例如正文之后的一行可以是 [NIRIA_EXPRESSION:${names[1]}]。这行是应用元数据，不属于正文。`
  ].join("\n");
}

export function parseExpressionReply(value, available = EXPRESSIONS) {
  const lines = value.trim().split(/\r?\n/);
  const tags = [];
  while (lines.length) {
    const match = /^\s*\[NIRIA_EXPRESSION:([^\]\r\n]{0,160})\]\s*$/.exec(lines.at(-1));
    if (!match) break;
    tags.unshift(match[1].trim());
    lines.pop();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
  }
  const name = tags.length === 1 && EXPRESSIONS.includes(tags[0]) && available.includes(tags[0]) ? tags[0] : "neutral";
  return { content: lines.join("\n").trim(), name };
}
