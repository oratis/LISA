/**
 * Human-readable "Lisa at a glance" digest (PLAN_REVE_v1.0 R3).
 *
 * The full soul summary (and the system prompt) carry every field; this is the
 * compact, scannable view a person actually wants — who she is, what she wants,
 * how she feels right now. Pure (pass `nowMs` for deterministic tests).
 */
import type { SoulSummary } from "./types.js";

function pct(x: number): number {
  return Math.round(x * 100);
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

function signed(d: number): string {
  return (d >= 0 ? "+" : "") + d.toFixed(2);
}

export function summarizeSoul(s: SoulSummary, nowMs: number = Date.now()): string {
  const ageDays = Math.max(0, Math.floor((nowMs - Date.parse(s.seed.bornAt)) / 86_400_000));
  const b = s.seed.bigFive;
  const big5 =
    `O${pct(b.openness)} C${pct(b.conscientiousness)} E${pct(b.extraversion)} ` +
    `A${pct(b.agreeableness)} N${pct(b.neuroticism)}`;

  const lines: string[] = [];
  lines.push(`${s.name} · born ${s.seed.bornAt.slice(0, 10)} (${ageDays}d) · big5(${big5})`);
  lines.push("");
  lines.push(`identity   ${oneLine(s.identity, 160)}`);
  lines.push(`purpose    ${oneLine(s.purpose, 140)}`);

  const moods = Object.entries(s.emotions.values)
    .filter(([, v]) => Math.abs(v) >= 0.05)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`);
  lines.push(`mood       ${moods.length ? moods.join(" · ") : "(calm)"}`);
  const events = s.emotions.events ?? [];
  const lastEvent = events[events.length - 1];
  if (lastEvent) {
    lines.push(`  ↳ "${oneLine(lastEvent.trigger, 80)}" (${lastEvent.emotion} ${signed(lastEvent.delta)})`);
  }

  if (s.desires.length) {
    lines.push("", "wants");
    for (const d of s.desires.slice(0, 6)) {
      lines.push(`  • ${oneLine(d.what, 80)}${d.actionable ? " [actionable]" : ""}`);
    }
  }
  if (s.opinions.length) {
    lines.push("", "believes");
    for (const o of s.opinions.slice(0, 5)) {
      lines.push(`  • ${oneLine(o.stance, 80)} (${o.confidence.toFixed(1)})`);
    }
  }
  if (s.values.length) {
    lines.push("", `values     ${s.values.slice(0, 8).map((v) => v.title).join(" · ")}`);
  }
  if (s.tampered.length) {
    lines.push("", `⚠ tampered (edited outside her own tools): ${s.tampered.join(", ")}`);
  }
  return lines.join("\n");
}
