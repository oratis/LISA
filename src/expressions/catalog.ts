import { readFileSync } from "node:fs";

export type ExpressionFormat = "animated" | "static" | "emoji";
export interface Expression {
  version: 1;
  id: string;
  assetId: string;
  format: ExpressionFormat;
  alt: string;
  emoji: string;
  animation: string;
  poster: string;
  native: string;
  durationMs: number;
}
export interface ExpressionRecord {
  version: 1;
  id: string;
  assetId: string;
  format: ExpressionFormat;
}
const art = JSON.parse(
  readFileSync(
    new URL("../web/assets/visuals/soft-ink-motion-v1/manifest.json", import.meta.url),
    "utf8",
  ),
);
const labels: [string, string][] = [
  ["Hello · 你好", "👋"],
  ["Happy · 开心", "😊"],
  ["Laughing · 大笑", "😄"],
  ["Amused · 偷笑", "🤭"],
  ["Thinking · 思考", "🤔"],
  ["Confused · 疑惑", "😕"],
  ["Surprised · 惊讶", "😮"],
  ["Worried · 担心", "😟"],
  ["Sad · 难过", "😔"],
  ["Sorry · 抱歉", "🙏"],
  ["Thank you · 感谢", "💚"],
  ["Proud · 自豪", "😌"],
  ["Determined · 坚定", "💪"],
  ["Excited · 兴奋", "✨"],
  ["Cheering · 庆祝", "🎉"],
  ["Sleepy · 困倦", "🥱"],
  ["Focused · 专注", "💻"],
  ["Debugging · 排查", "🔧"],
  ["Researching · 研究", "🔎"],
  ["Writing · 写作", "✍️"],
  ["Reading · 阅读", "📖"],
  ["Tea · 喝茶", "🍵"],
  ["Stretching · 伸展", "🙆"],
  ["Resting · 小憩", "😴"],
  ["Hello · 你好", "👋"],
  ["Well done · 做得好", "🙌"],
  ["Let me think · 让我想想", "🤔"],
  ["Thank you · 谢谢", "💚"],
  ["Celebrate · 庆祝一下", "🎉"],
  ["Here for you · 我在这里", "🫶"],
  ["Make a plan · 写下计划", "📝"],
  ["Tea break · 喝杯茶", "🍵"],
];
export const expressionCatalog = [
  ...Object.values<string>(art.portraits),
  ...(art.stickers as string[]),
].map((id, i) => ({ id, alt: labels[i]![0], emoji: labels[i]![1] }));
export function resolveExpression(value: unknown): Expression | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as ExpressionRecord;
  if (
    r.version !== 1 ||
    typeof r.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(r.id) ||
    !["animated", "static", "emoji"].includes(r.format)
  )
    return;
  const item = expressionCatalog.find((item) => item.id === r.assetId);
  if (!item) return;
  const clip = art.clips[item.id];
  return {
    version: 1,
    id: r.id,
    assetId: item.id,
    format: r.format,
    alt: item.alt,
    emoji: item.emoji,
    animation: clip.src,
    poster: clip.poster,
    native: clip.native,
    durationMs: clip.durationMs,
  };
}
export function expressionText(e: Expression): string {
  return `${e.emoji} [LISA: ${e.alt}]`;
}
