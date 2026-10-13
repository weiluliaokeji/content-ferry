const blockedChannelPromotionPatterns = [
  /https?:\/\/mp\.weixin\.qq\.com\//iu,
  /关注(?:我的|本)?公众号/iu,
  /(?:扫描|识别|扫码)(?:下方|文末)?二维码.{0,24}(?:关注|查看|获取|加入|领取)/u,
  /(?:点击|查看|阅读|获取).{0,12}公众号原文/iu,
  /\[[^\]]{0,24}公众号原文[^\]]*\]\(https?:\/\/[^)]+\)/iu
];

/** Returns the exact cross-promotion text that should be removed, if any. */
export function findChannelCrossPromotion(markdown: string): string | null {
  for (const pattern of blockedChannelPromotionPatterns) {
    const match = pattern.exec(markdown);
    if (match) return match[0];
  }
  return null;
}
