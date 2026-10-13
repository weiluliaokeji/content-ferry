import type { ConfirmedAccountStyleProfile } from "./account-repository";

export function formatConfirmedAccountStylePrompt(profile: ConfirmedAccountStyleProfile | null): string {
  if (!profile) return "";
  const genreTraits = profile.genreTraits.map((item) => `${item.genre}：${item.traits}`).join("\n");
  return `\n\n账号已确认风格档案 v${profile.versionNumber}（仅作表达与结构参考，不是事实依据）：\n共同风格：${profile.commonVoice}${genreTraits ? `\n${genreTraits}` : ""}${profile.visualTraits ? `\n正文配图习惯：${profile.visualTraits}` : ""}\n结合本篇主题自然采用适用特点；主稿与本篇明确要求优先，不得改变事实边界。`;
}
