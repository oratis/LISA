/**
 * `/api/reachout/*` — the user's controls over when Lisa may reach out
 * (docs/POLICY_REACH_OUT.md §3) and the numbers behind them (§7).
 *
 * Everything here reads and writes under `lisaHome()`, so in the cloud edition
 * a signed-in request (which runs inside that account's home scope) only ever
 * sees its own settings and ledger.
 */
import type http from "node:http";
import { getAutonomyEnabled } from "../autonomy/state.js";
import { lisaHome } from "../paths.js";
import { inQuietHours, localMoment } from "../reachout/clock.js";
import {
  aggregateLedger,
  budgetUsed,
  readLedger,
  recordReachOutFeedback,
  withReachOutLock,
} from "../reachout/ledger.js";
import {
  DAILY_BUDGET,
  applyReachOutPatch,
  loadReachOutSettings,
  saveReachOutSettings,
  type ReachOutSettings,
} from "../reachout/settings.js";
import { readCappedText, CTRL_BODY_LIMIT } from "./http-body.js";

export interface ReachOutApiOptions {
  /** Can push physically reach this caller? False in the cloud edition. */
  pushAvailable: boolean;
  /** Is an IM channel wired into the gate? */
  imAvailable?: boolean;
  now?: () => Date;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

async function bodyObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readCappedText(req, CTRL_BODY_LIMIT);
  const parsed = JSON.parse(raw || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

/** The settings view every surface (web, CLI, iOS) renders from. */
export function reachOutSettingsView(
  settings: ReachOutSettings,
  home: string,
  opts: ReachOutApiOptions,
): Record<string, unknown> {
  const now = (opts.now ?? (() => new Date()))();
  const daily = DAILY_BUDGET[settings.dial];
  const used = budgetUsed(readLedger(home), localMoment(now, settings.quietHours.tz).day);
  return {
    settings,
    // The "Proactive mode" switch (/api/autonomy/state). Separate from the dial:
    // it decides whether Lisa acts on her own; the dial decides how much she
    // may interrupt. With it off, `idle` and `desire` behave as dial "off".
    proactiveMode: getAutonomyEnabled(),
    budget: { dial: settings.dial, daily, usedToday: used, remaining: Math.max(0, daily - used) },
    budgets: DAILY_BUDGET,
    quietNow: inQuietHours(now, settings.quietHours),
    channelsAvailable: {
      inapp: true,
      push: opts.pushAvailable,
      im: opts.imAvailable === true,
    },
  };
}

/**
 * Handle `/api/reachout/*`. Returns false when the route is outside this
 * domain. The caller has already authenticated the request.
 */
export async function handleReachOutApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  opts: ReachOutApiOptions,
): Promise<boolean> {
  const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
  const pathname = parsedUrl.pathname;
  if (!pathname.startsWith("/api/reachout/")) return false;
  const home = lisaHome();

  try {
    if (pathname === "/api/reachout/settings") {
      if (req.method === "GET") {
        json(res, 200, reachOutSettingsView(loadReachOutSettings(home), home, opts));
        return true;
      }
      if (req.method === "PUT") {
        let patch: Record<string, unknown>;
        try {
          patch = await bodyObject(req);
        } catch (err) {
          json(res, 400, { error: "invalid_body", message: (err as Error).message });
          return true;
        }
        const result = await withReachOutLock(home, async () => {
          const merged = applyReachOutPatch(loadReachOutSettings(home), patch);
          if (!merged.ok) return merged;
          return { ok: true as const, settings: await saveReachOutSettings(merged.settings, home) };
        });
        if (!result.ok) {
          json(res, 400, { error: "invalid_settings", message: result.error });
          return true;
        }
        json(res, 200, reachOutSettingsView(result.settings, home, opts));
        return true;
      }
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }

    if (pathname === "/api/reachout/ledger" && req.method === "GET") {
      const raw = parsedUrl.searchParams.get("days");
      const days = raw === null ? 7 : Number(raw);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        json(res, 400, { error: "invalid_days", message: "days must be an integer 1–90" });
        return true;
      }
      const settings = loadReachOutSettings(home);
      const now = (opts.now ?? (() => new Date()))();
      // Aggregates only — the ledger holds no message text, and this never
      // returns its rows (ids, hashes) either.
      json(res, 200, aggregateLedger(readLedger(home), days, now, settings.quietHours.tz));
      return true;
    }

    if (pathname === "/api/reachout/feedback" && req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await bodyObject(req);
      } catch (err) {
        json(res, 400, { error: "invalid_body", message: (err as Error).message });
        return true;
      }
      const { id, verdict } = body;
      if (typeof id !== "string" || !/^ro_[A-Za-z0-9_-]{1,32}$/.test(id)) {
        json(res, 400, { error: "invalid_id" });
        return true;
      }
      if (verdict !== "useful" && verdict !== "dismissed") {
        json(res, 400, {
          error: "invalid_verdict",
          message: 'verdict must be "useful" or "dismissed"',
        });
        return true;
      }
      const now = (opts.now ?? (() => new Date()))();
      const recorded = await recordReachOutFeedback(id, verdict, home, now);
      if (!recorded.ok) {
        json(res, 404, { error: "reachout_notice_not_found" });
        return true;
      }
      json(res, 200, { ok: true, id, verdict });
      return true;
    }

    json(res, 404, { error: "reachout_route_not_found" });
    return true;
  } catch (err) {
    json(res, 500, { error: "reachout_api_failed", message: (err as Error).message });
    return true;
  }
}
