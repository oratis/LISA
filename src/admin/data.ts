import * as quota from "../billing/quota.js";
import fs from "node:fs/promises";
import path from "node:path";
import { loadAccounts } from "../web/accounts.js";
import { homeForUid, homeScope } from "../paths.js";
import {
  readBalance,
  tierFor,
  WINDOW_MS,
  FREE_WINDOW_FULL,
  FREE_WINDOW_UNVERIFIED,
  TIER1_WINDOW,
  TIER2_WINDOW,
} from "../billing/quota.js";
import { listPaymentTransactions } from "../billing/iap.js";
import { readAdminState, roleFor } from "./store.js";
import { PRICES_VERSION, explicitPriceForModel, normalizeModelId } from "../billing/prices.js";
import { firestoreEnabled } from "../cloud/firestore.js";

async function lines(
  file: string,
  warnings: string[],
  label: string,
): Promise<Record<string, unknown>[]> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 16 * 1024 * 1024) {
      warnings.push(`${label}: 日志超过读取上限`);
      return [];
    }
    const raw = await fs.readFile(file, "utf8");
    const out: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r: unknown = JSON.parse(line);
        if (r && typeof r === "object" && !Array.isArray(r)) out.push(r as Record<string, unknown>);
        else warnings.push(`${label}: 无效记录`);
      } catch {
        warnings.push(`${label}: 日志存在损坏记录`);
      }
    }
    return out;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    warnings.push(`${label}: 数据暂不可读`);
    return [];
  }
}
async function countFiles(
  dir: string,
  warnings: string[],
  label: string,
  suffix = ".jsonl",
): Promise<number> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(suffix)).length;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    warnings.push(`${label}: 数量暂不可读`);
    return 0;
  }
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
export function paymentChannel(id: string): string {
  if (id.startsWith("admin:")) return "grant";
  if (id.startsWith("sandbox:")) return "sandbox";
  if (id.startsWith("stripe-")) return "stripe";
  return /^\d+$/.test(id) ? "apple" : "other";
}
export async function consoleSnapshot(days: number, now = Date.now()) {
  if (![7, 30, 90].includes(days)) throw new RangeError("Unsupported console range");
  const [accounts, state, paymentPage] = await Promise.all([
    loadAccounts(),
    readAdminState(),
    listPaymentTransactions(),
  ]);
  const warnings: string[] = paymentPage.truncated
    ? ["交易列表已达上限；当前总额为已读取记录合计"]
    : [];
  const dayMs = 86400000,
    since = Math.floor(now / dayMs) * dayMs - (days - 1) * dayMs;
  const today = Math.floor(now / dayMs) * dayMs;
  // Compare matching UTC calendar windows, including the same partial final day.
  const previousSince = since - days * dayMs,
    previousUntil = now - days * dayMs;
  const previousActive = new Set<string>(),
    previousPayers = new Set<string>();
  const activeToday = new Set<string>(),
    active7 = new Set<string>(),
    active30 = new Set<string>();
  const userActiveDays = new Map<string, Set<string>>();
  const previous = {
    registrations: 0,
    active: 0,
    turns: 0,
    tokens: 0,
    faceMicroUSD: 0,
    creditMicroUSD: 0,
    paidUsers: 0,
  };
  const tokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const autonomyTotals = { runs: 0, done: 0, noUpdate: 0, blocked: 0, error: 0, unknown: 0 };
  let mediaDurationMs = 0,
    mediaOperations = 0;
  const daily = Array.from({ length: days }, (_, i) => ({
    day: new Date(since + i * dayMs).toISOString().slice(0, 10),
    registrations: 0,
    active: 0,
    turns: 0,
    tokens: 0,
    faceMicroUSD: 0,
    creditMicroUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    paidUsers: 0,
    creditedTransactions: 0,
    autonomyRuns: 0,
    autonomyErrors: 0,
  }));
  const dayMap = new Map(daily.map((d) => [d.day, d]));
  const activeDays = new Map<string, Set<string>>();
  const activeUsers = new Set<string>();
  const dailyPayers = new Map<string, Set<string>>();
  let totalUsage = 0;
  const models = new Map<
    string,
    { model: string; turns: number; tokens: number; faceMicroUSD: number }
  >();
  const sources = new Map<string, { source: string; turns: number; faceMicroUSD: number }>();
  const usage: {
    uid: string;
    at: string;
    model: string;
    source: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    faceMicroUSD: number;
    durationMs: number;
  }[] = [];
  const autonomy: { uid: string; at: string; kind: string; outcome: string; durationMs: number }[] =
    [];
  const users = [];
  // Bounded concurrency avoids hundreds of simultaneous GCS reads.
  const limit = 2000;
  if (accounts.length > limit) warnings.push("用户读取上限为 2000；当前汇总不完整");
  for (let start = 0; start < Math.min(accounts.length, limit); start += 8) {
    const batch = await Promise.all(
      accounts.slice(start, Math.min(start + 8, limit)).map(async (acct) => {
        const home = homeForUid(acct.uid);
        const [balance, tokenRows, mediaRows, runs, sessions, knowledge, tasks] = await Promise.all(
          [
            homeScope
              .run(home, () => readBalance())
              .catch(() => {
                warnings.push(`${acct.uid}: 余额不可读`);
                return null;
              }),
            lines(path.join(home, "billing", "usage.jsonl"), warnings, `${acct.uid} 用量`),
            lines(path.join(home, "billing", "media-usage.jsonl"), warnings, `${acct.uid} 语音`),
            lines(path.join(home, "autonomy", "runs.jsonl"), warnings, `${acct.uid} 自治`),
            countFiles(path.join(home, "sessions"), warnings, "会话"),
            countFiles(path.join(home, "kb", "sources"), warnings, "知识库", ".md"),
            countFiles(path.join(home, "tasks"), warnings, "任务", ".json"),
          ],
        );
        if (tokenRows.length >= 5000 || mediaRows.length >= 5000)
          warnings.push(`${acct.uid}: 用量日志仅保留最近 5000 条`);
        if (runs.length >= 2000) warnings.push(`${acct.uid}: 自治日志仅保留最近 2000 条`);
        let lastActiveAt = 0,
          userTurns = 0,
          faceMicroUSD = 0,
          tokens = 0;
        for (const row of [...tokenRows, ...mediaRows]) {
          const at = str(row.at),
            timestamp = Date.parse(at);
          if (
            !Number.isFinite(timestamp) ||
            typeof row.model !== "string" ||
            typeof row.microUSD !== "number" ||
            !Number.isSafeInteger(row.microUSD) ||
            row.microUSD < 0
          ) {
            warnings.push(`${acct.uid}: 无效计量记录已跳过`);
            continue;
          }
          if (timestamp > now) continue;
          lastActiveAt = Math.max(lastActiveAt, timestamp);
          const tokenCount =
            num(row.inputTokens) +
            num(row.outputTokens) +
            num(row.cacheReadTokens) +
            num(row.cacheWriteTokens);
          if (timestamp >= today) activeToday.add(acct.uid);
          if (timestamp >= today - 6 * dayMs) active7.add(acct.uid);
          if (timestamp >= today - 29 * dayMs) active30.add(acct.uid);
          if (timestamp >= previousSince && timestamp <= previousUntil) {
            previousActive.add(acct.uid);
            previous.turns++;
            previous.tokens += tokenCount;
            previous.faceMicroUSD += num(row.microUSD);
          }
          if (timestamp < since) continue;
          const record = {
            uid: acct.uid,
            at: new Date(timestamp).toISOString(),
            model: str(row.model),
            source: str(row.source),
            inputTokens: num(row.inputTokens),
            outputTokens: num(row.outputTokens),
            cacheReadTokens: num(row.cacheReadTokens),
            cacheWriteTokens: num(row.cacheWriteTokens),
            faceMicroUSD: num(row.microUSD),
            durationMs: num(row.durationMs),
          };
          totalUsage++;
          tokenTotals.input += record.inputTokens;
          tokenTotals.output += record.outputTokens;
          tokenTotals.cacheRead += record.cacheReadTokens;
          tokenTotals.cacheWrite += record.cacheWriteTokens;
          if (row.source === "voice_transcribe" || row.source === "voice_dictation") {
            mediaOperations++;
            mediaDurationMs += record.durationMs;
          }
          activeUsers.add(acct.uid);
          usage.push(record);
          if (usage.length >= 2000) {
            usage.sort((a, b) => b.at.localeCompare(a.at));
            usage.splice(1000);
          }
          userTurns++;
          faceMicroUSD += record.faceMicroUSD;
          tokens += tokenCount;
          const day = record.at.slice(0, 10),
            point = dayMap.get(day);
          const userDays = userActiveDays.get(acct.uid) ?? new Set<string>();
          userDays.add(day);
          userActiveDays.set(acct.uid, userDays);
          if (point) {
            point.turns++;
            point.tokens += tokenCount;
            point.faceMicroUSD += record.faceMicroUSD;
            point.inputTokens += record.inputTokens;
            point.outputTokens += record.outputTokens;
            point.cacheReadTokens += record.cacheReadTokens;
            point.cacheWriteTokens += record.cacheWriteTokens;
          }
          const active = activeDays.get(day) ?? new Set<string>();
          active.add(acct.uid);
          activeDays.set(day, active);
          const model = models.get(record.model) ?? {
            model: record.model,
            turns: 0,
            tokens: 0,
            faceMicroUSD: 0,
          };
          model.turns++;
          model.tokens += tokenCount;
          model.faceMicroUSD += record.faceMicroUSD;
          models.set(record.model, model);
          const source = sources.get(record.source) ?? {
            source: record.source,
            turns: 0,
            faceMicroUSD: 0,
          };
          source.turns++;
          source.faceMicroUSD += record.faceMicroUSD;
          sources.set(record.source, source);
        }
        for (const run of runs) {
          const timestamp = Date.parse(str(run.startedAt));
          if (!Number.isFinite(timestamp)) {
            warnings.push(`${acct.uid}: 无效自治记录已跳过`);
            continue;
          }
          if (timestamp >= since && timestamp <= now) {
            const at = new Date(timestamp).toISOString();
            const outcome = str(run.outcome);
            autonomyTotals.runs++;
            if (outcome === "no-update") autonomyTotals.noUpdate++;
            else if (outcome === "done" || outcome === "blocked" || outcome === "error")
              autonomyTotals[outcome]++;
            else autonomyTotals.unknown++;
            const point = dayMap.get(at.slice(0, 10));
            if (point) {
              point.autonomyRuns++;
              if (outcome === "error") point.autonomyErrors++;
            }
            autonomy.push({
              uid: acct.uid,
              at,
              kind: str(run.kind),
              outcome,
              durationMs: num(run.durationMs),
            });
            if (autonomy.length >= 2000) {
              autonomy.sort((a, b) => b.at.localeCompare(a.at));
              autonomy.splice(1000);
            }
          }
        }
        if (acct.createdAt >= previousSince && acct.createdAt <= previousUntil)
          previous.registrations++;
        const registrationDay = dayMap.get(new Date(acct.createdAt).toISOString().slice(0, 10));
        if (registrationDay && acct.createdAt <= now) registrationDay.registrations++;
        return {
          uid: acct.uid,
          email: acct.email ?? "",
          kind: acct.kind,
          verified: acct.verified,
          createdAt: acct.createdAt,
          lastLoginAt: acct.lastLoginAt,
          lastActiveAt: lastActiveAt || null,
          role: roleFor(acct, state),
          suspended: state.users[acct.uid]?.suspended ?? false,
          note: state.users[acct.uid]?.note ?? "",
          tier: balance ? tierFor(acct, balance, now) : null,
          paidMicroUSD: balance?.paidMicroUSD ?? null,
          turns: userTurns,
          faceMicroUSD,
          tokens,
          sessions,
          knowledge,
          tasks,
          activeDays: userActiveDays.get(acct.uid)?.size ?? 0,
        };
      }),
    );
    users.push(...batch);
  }
  for (const d of daily) d.active = activeDays.get(d.day)?.size ?? 0;
  const payments = paymentPage.rows
    .filter((p) => p.at >= since && p.at <= now)
    .map((p) => ({ ...p, channel: paymentChannel(p.transactionId) }));
  for (const p of payments) {
    if (p.status !== "credited" || !["apple", "stripe"].includes(p.channel)) continue;
    const day = dayMap.get(new Date(p.at).toISOString().slice(0, 10));
    if (day) {
      day.creditMicroUSD += p.microUSD;
      day.creditedTransactions++;
      const payers = dailyPayers.get(day.day) ?? new Set<string>();
      payers.add(p.uid);
      dailyPayers.set(day.day, payers);
      day.paidUsers = payers.size;
    }
  }
  for (const p of paymentPage.rows) {
    if (
      p.at >= previousSince &&
      p.at <= previousUntil &&
      p.status === "credited" &&
      ["apple", "stripe"].includes(paymentChannel(p.transactionId))
    ) {
      previous.creditMicroUSD += p.microUSD;
      previousPayers.add(p.uid);
    }
  }
  previous.active = previousActive.size;
  previous.paidUsers = previousPayers.size;
  const formalPayments = payments.filter((p) => ["apple", "stripe"].includes(p.channel));
  const credited = formalPayments.filter((p) => p.status === "credited");
  const creditTotal = credited.reduce((s, p) => s + p.microUSD, 0);
  const payerCount = new Set(credited.map((p) => p.uid)).size;
  const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
  const returningActive = users.filter((u) => u.activeDays >= 2).length;
  const accountKinds = new Map<string, number>();
  for (const user of users) accountKinds.set(user.kind, (accountKinds.get(user.kind) ?? 0) + 1);
  usage.sort((a, b) => b.at.localeCompare(a.at));
  autonomy.sort((a, b) => b.at.localeCompare(a.at));
  payments.sort((a, b) => b.at - a.at);
  const currentModel = process.env.LISA_MODEL ?? "default";
  const modelList = [
    ...new Set([currentModel, ...models.keys(), ...state.settings.disabledModels]),
  ].map((model) => ({
    ...(models.get(model) ?? { turns: 0, tokens: 0, faceMicroUSD: 0 }),
    model,
    price: explicitPriceForModel(model),
    disabled: state.settings.disabledModels.some(
      (m) => normalizeModelId(m) === normalizeModelId(model),
    ),
    current: model === currentModel,
  }));
  return {
    generatedAt: now,
    range: { days, since, until: now, timezone: "UTC" },
    comparison: { range: { since: previousSince, until: previousUntil }, summary: previous },
    warnings: [...new Set(warnings)].slice(0, 50),
    summary: {
      users: accounts.length,
      registrations: daily.reduce((s, d) => s + d.registrations, 0),
      active: activeUsers.size,
      turns: totalUsage,
      tokens: daily.reduce((s, d) => s + d.tokens, 0),
      faceMicroUSD: daily.reduce((s, d) => s + d.faceMicroUSD, 0),
      creditMicroUSD: daily.reduce((s, d) => s + d.creditMicroUSD, 0),
      grantMicroUSD: payments
        .filter((p) => p.channel === "grant" && p.status === "credited")
        .reduce((s, p) => s + p.microUSD, 0),
      paidUsers: new Set(
        payments
          .filter((p) => ["apple", "stripe"].includes(p.channel) && p.status === "credited")
          .map((p) => p.uid),
      ).size,
      sessions: users.reduce((s, u) => s + u.sessions, 0),
      tasks: users.reduce((s, u) => s + u.tasks, 0),
      suspended: users.filter((u) => u.suspended).length,
      knowledge: users.reduce((s, u) => s + u.knowledge, 0),
    },
    analytics: {
      engagement: {
        activeToday: activeToday.size,
        active7Days: active7.size,
        active30Days: active30.size,
        repeatActiveUsers: returningActive,
        repeatActiveRate: ratio(returningActive, activeUsers.size),
        turnsPerActiveUser: ratio(totalUsage, activeUsers.size),
        newActiveUsers: users.filter(
          (u) => u.createdAt >= since && u.createdAt <= now && u.turns > 0,
        ).length,
      },
      tokens: {
        ...tokenTotals,
        cacheReadRate: ratio(
          tokenTotals.cacheRead,
          tokenTotals.input + tokenTotals.cacheRead + tokenTotals.cacheWrite,
        ),
      },
      billing: {
        creditedTransactions: credited.length,
        averageCreditMicroUSD: ratio(creditTotal, credited.length),
        creditPerPayerMicroUSD: ratio(creditTotal, payerCount),
        costPerTurnMicroUSD: ratio(
          daily.reduce((s, d) => s + d.faceMicroUSD, 0),
          totalUsage,
        ),
        refundedTransactions: formalPayments.filter((p) => p.status === "refunded").length,
        refundedMicroUSD: formalPayments
          .filter((p) => p.status === "refunded")
          .reduce((s, p) => s + p.microUSD, 0),
        pendingTransactions: formalPayments.filter(
          (p) => p.status === "pending" || p.status === "refund_pending",
        ).length,
        channels: ["apple", "stripe"].map((channel) => ({
          channel,
          transactions: credited.filter((p) => p.channel === channel).length,
          creditMicroUSD: credited
            .filter((p) => p.channel === channel)
            .reduce((s, p) => s + p.microUSD, 0),
        })),
      },
      autonomy: {
        ...autonomyTotals,
        healthyRate: ratio(autonomyTotals.done + autonomyTotals.noUpdate, autonomyTotals.runs),
      },
      media: { operations: mediaOperations, durationMs: mediaDurationMs },
      accounts: {
        scanned: users.length,
        verified: users.filter((u) => u.verified).length,
        kinds: [...accountKinds].map(([kind, count]) => ({ kind, users: count })),
      },
    },
    daily,
    users,
    payments,
    usage: usage.slice(0, 1000),
    usageTruncated: totalUsage > 1000,
    models: modelList,
    sources: [...sources.values()],
    autonomy: autonomy.slice(0, 1000),
    autonomyTruncated: autonomyTotals.runs > 1000,
    settings: state.settings,
    revision: state.revision,
    roles: state.roles,
    tickets: state.tickets,
    audit: state.audit.slice().reverse(),
    system: {
      version: JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"))
        .version,
      revision: process.env.K_REVISION ?? "local",
      uptimeSeconds: Math.floor(process.uptime()),
      storage: firestoreEnabled() ? "Firestore + GCS" : "持久化文件 / 单实例",
      model: currentModel,
      pricesVersion: PRICES_VERSION,
      dailyCapUSD: Number(process.env.LISA_DAILY_CAP_USD ?? 200),
      rpm: Number(process.env.LISA_RPM_LIMIT ?? 20),
      billingKill: process.env.LISA_BILLING_KILL === "1",
      stripe: !!process.env.STRIPE_SECRET_KEY,
      google: !!process.env.LISA_GOOGLE_WEB_CLIENT_ID,
      apple: process.env.LISA_CLOUD_APPLE_SIGNIN === "1",
      email: !!process.env.RESEND_API_KEY,
      cloudTasks: process.env.LISA_CLOUD_TASKS === "1",
      relay: process.env.LISA_RELAY_ENABLED === "1",
      providers: ["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ZHIPU_API_KEY"]
        .filter((k) => !!process.env[k])
        .map((k) => k.replace("_API_KEY", "")),
      quota: {
        windowHours: WINDOW_MS / 3600000,
        verified: FREE_WINDOW_FULL,
        unverified: FREE_WINDOW_UNVERIFIED,
        tier1: TIER1_WINDOW,
        tier2: TIER2_WINDOW,
        signup: (quota as unknown as Record<string, number>).SIGNUP_GRANT ?? 0,
      },
    },
  };
}
