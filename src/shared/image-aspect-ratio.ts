export const DEFAULT_WECHAT_COVER_ASPECT_RATIO = 2.35;

const STANDARD_ASPECT_RATIOS = [
  { label: "1:1", value: 1 },
  { label: "9:16", value: 9 / 16 },
  { label: "16:9", value: 16 / 9 },
  { label: "2:3", value: 2 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "3:4", value: 3 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "21:9", value: 21 / 9 },
  { label: "9:21", value: 9 / 21 }
] as const;

export function parsePromptAspectRatio(prompt: string, fallback = DEFAULT_WECHAT_COVER_ASPECT_RATIO): number {
  const match = /(?:宽高比|画幅比例|画面比例|图片比例|比例|aspect\s*ratio)?\s*(\d+(?:\.\d+)?)\s*[:：/／]\s*(\d+(?:\.\d+)?)/i.exec(prompt);
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / height;
  return Number.isFinite(ratio) && ratio >= 0.25 && ratio <= 4 ? ratio : fallback;
}

export function nearestStandardAspectRatio(value: number): typeof STANDARD_ASPECT_RATIOS[number] {
  return STANDARD_ASPECT_RATIOS.reduce((nearest, current) =>
    Math.abs(current.value - value) < Math.abs(nearest.value - value) ? current : nearest
  );
}
