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
// Keyed by asset id, not by manifest position: reordering or extending the
// motion manifest must never silently give an asset another asset's label.
const labels: Record<string, [alt: string, emoji: string]> = {
  blink: ["Hello · 你好", "👋"],
  happy: ["Happy · 开心", "😊"],
  laughing: ["Laughing · 大笑", "😄"],
  giggling: ["Amused · 偷笑", "🤭"],
  thinking: ["Thinking · 思考", "🤔"],
  confused: ["Confused · 疑惑", "😕"],
  surprised: ["Surprised · 惊讶", "😮"],
  worried: ["Worried · 担心", "😟"],
  sad: ["Sad · 难过", "😔"],
  apologetic: ["Sorry · 抱歉", "🙏"],
  grateful: ["Thank you · 感谢", "💚"],
  proud: ["Proud · 自豪", "😌"],
  determined: ["Determined · 坚定", "💪"],
  excited: ["Excited · 兴奋", "✨"],
  cheering: ["Cheering · 庆祝", "🎉"],
  sleepy: ["Sleepy · 困倦", "🥱"],
  working: ["Focused · 专注", "💻"],
  debugging: ["Debugging · 排查", "🔧"],
  research: ["Researching · 研究", "🔎"],
  writing: ["Writing · 写作", "✍️"],
  "portrait-reading": ["Reading · 阅读", "📖"],
  "portrait-tea": ["Tea · 喝茶", "🍵"],
  "portrait-stretching": ["Stretching · 伸展", "🙆"],
  "portrait-napping": ["Resting · 小憩", "😴"],
  "sticker-hello": ["Hello · 你好", "👋"],
  "sticker-well-done": ["Well done · 做得好", "🙌"],
  "sticker-thinking": ["Let me think · 让我想想", "🤔"],
  "sticker-thank-you": ["Thank you · 谢谢", "💚"],
  "sticker-celebrate": ["Celebrate · 庆祝一下", "🎉"],
  "sticker-here-for-you": ["Here for you · 我在这里", "🫶"],
  "sticker-make-a-plan": ["Make a plan · 写下计划", "📝"],
  "sticker-tea-break": ["Tea break · 喝杯茶", "🍵"],
};
export const expressionCatalog = [
  ...Object.values<string>(art.portraits),
  ...(art.stickers as string[]),
].map((id) => {
  const label = labels[id];
  if (!label) throw new Error(`conversation expression ${id} has no label`);
  return { id, alt: label[0], emoji: label[1] };
});
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
