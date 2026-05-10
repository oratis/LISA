/**
 * `lisa doctor` — health check across config / network / git / models.
 *
 * Diagnoses the most common "Lisa won't start" failures:
 *   - Missing API keys
 *   - Anthropic API unreachable (geo-block / no proxy)
 *   - git not in PATH (soul history breaks)
 *   - Outdated Node
 *   - sandbox env weirdness
 *   - heartbeat not installed
 *
 * Exit code: 0 if all critical checks pass, 1 if any critical issue.
 */
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  dim,
  fail,
  green,
  grey,
  heading,
  ok,
  rule,
  warn,
} from "./colors.js";
import { LISA_HOME } from "../paths.js";
import { CONFIG_ENV_PATH } from "../env.js";
import { SOUL_DIR } from "../soul/paths.js";
import { listConfiguredProviders, OPENAI_COMPAT_PRESETS } from "../providers/registry.js";
import { isBorn } from "../soul/store.js";
import { pathExists } from "../fs-utils.js";

interface Check {
  label: string;
  critical: boolean;
  run: () => Promise<{ ok: boolean; detail?: string }>;
}

const checks: Check[] = [
  {
    label: "Node version ≥ 20",
    critical: true,
    run: async () => {
      const major = parseInt(process.versions.node.split(".")[0]!, 10);
      return major >= 20
        ? { ok: true, detail: `node ${process.versions.node}` }
        : { ok: false, detail: `node ${process.versions.node} (need ≥ 20)` };
    },
  },
  {
    label: "git available",
    critical: false, // soul history is best-effort; Lisa works without it
    run: async () => {
      try {
        const v = execSync("git --version 2>&1", { encoding: "utf8" }).trim();
        return { ok: true, detail: v };
      } catch {
        return { ok: false, detail: "soul git history will be disabled" };
      }
    },
  },
  {
    label: "~/.lisa/ exists",
    critical: false,
    run: async () => {
      return (await pathExists(LISA_HOME))
        ? { ok: true, detail: LISA_HOME }
        : { ok: false, detail: `${LISA_HOME} not yet created (will be on first run)` };
    },
  },
  {
    label: "~/.lisa/config.env exists",
    critical: false,
    run: async () => {
      return (await pathExists(CONFIG_ENV_PATH))
        ? { ok: true, detail: CONFIG_ENV_PATH }
        : { ok: false, detail: `not found — keys must be in shell env` };
    },
  },
  {
    label: "Soul born",
    critical: false,
    run: async () => {
      return (await isBorn())
        ? { ok: true, detail: "yes" }
        : { ok: false, detail: "run `lisa birth` (auto-runs on first session)" };
    },
  },
  {
    label: "Soul git repo initialized",
    critical: false,
    run: async () => {
      const dotGit = path.join(SOUL_DIR, ".git");
      return (await pathExists(dotGit))
        ? { ok: true, detail: dotGit }
        : { ok: false, detail: "init pending; will run automatically on next start" };
    },
  },
  {
    label: "At least one LLM provider configured",
    critical: true,
    run: async () => {
      const provs = listConfiguredProviders().filter((p) => p.configured);
      return provs.length > 0
        ? { ok: true, detail: provs.map((p) => p.name).join(", ") }
        : { ok: false, detail: "set ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY / etc." };
    },
  },
  {
    label: "Outbound HTTPS to api.anthropic.com",
    critical: false, // not critical — user might use openai-compat exclusively
    run: async () => testHttp("https://api.anthropic.com/v1/messages"),
  },
  {
    label: "Outbound HTTPS to api.openai.com",
    critical: false,
    run: async () => testHttp("https://api.openai.com/v1/models"),
  },
];

async function testHttp(url: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    // 4xx is fine — server reachable, just no auth
    if (r.status > 0 && r.status < 600) {
      return { ok: true, detail: `${r.status} (reachable)` };
    }
    return { ok: false, detail: `unexpected status ${r.status}` };
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 80) ?? "unknown error";
    return { ok: false, detail: msg };
  }
}

export async function runDoctor(): Promise<void> {
  console.log(rule("LISA DOCTOR"));

  // Environment summary
  console.log(heading("Environment"));
  console.log(`  ${dim("platform:")}  ${process.platform} ${os.release()}`);
  console.log(`  ${dim("node:")}      ${process.versions.node}`);
  console.log(`  ${dim("LISA_HOME:")} ${LISA_HOME}`);
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    console.log(`  ${dim("proxy:")}     ${process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY}`);
  } else {
    console.log(`  ${dim("proxy:")}     ${dim("(none)")}`);
  }

  // Run checks
  console.log(heading("Checks"));
  let failures = 0;
  let criticalFailures = 0;
  for (const check of checks) {
    const r = await check.run();
    const tag = r.ok ? ok(check.label) : check.critical ? fail(check.label) : warn(check.label);
    console.log(`  ${tag}${r.detail ? grey("  " + r.detail) : ""}`);
    if (!r.ok) {
      failures++;
      if (check.critical) criticalFailures++;
    }
  }

  // Provider preset hint
  console.log(heading("LLM provider presets"));
  console.log(`  ${dim("(set the matching key, then use the listed model prefix)")}`);
  for (const p of OPENAI_COMPAT_PRESETS) {
    const set = !!process.env[p.apiKeyEnv];
    const flag = set ? green("●") : grey("○");
    console.log(`  ${flag} ${p.name.padEnd(28)} ${dim(p.apiKeyEnv.padEnd(22))} ${dim(p.modelPrefixes.join(", "))}`);
  }

  // Summary
  console.log();
  console.log(rule());
  if (criticalFailures > 0) {
    console.log(fail(`${criticalFailures} critical failure${criticalFailures === 1 ? "" : "s"} — Lisa won't run reliably`));
    process.exit(1);
  } else if (failures > 0) {
    console.log(warn(`${failures} non-critical issue${failures === 1 ? "" : "s"} — Lisa will run but degraded`));
  } else {
    console.log(ok("all checks passed"));
  }
}
