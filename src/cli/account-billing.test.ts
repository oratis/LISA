/** `lisa billing` against a stubbed account API (#447 review). */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LISA_MANAGED_SESSION = "s1.test.session";
process.env.LISA_MANAGED_BASE = "https://cloud.example.com";

const { cmdBilling } = await import("./account.js");

test("the allowance line names the reset date, not just a time of day", async () => {
  // A rolling 24-hour window: the reset is normally on another calendar day.
  const resetAt = Date.parse("2026-11-08T15:14:00Z");
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const lines: string[] = [];
  globalThis.fetch = async (url: string | URL | Request) =>
    String(url).endsWith("/api/billing/quota")
      ? Response.json({
          available: true,
          tier: "free",
          windowMicroUSD: 300_000,
          remainingMicroUSD: 200_000,
          paidMicroUSD: 0,
          grantMicroUSD: 2_000_000,
          resetAt,
        })
      : Response.json({});
  console.log = (line: string) => lines.push(line);
  try {
    await cmdBilling([]);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  const allowance = lines.find((line) => line.startsWith("allowance:"));
  assert.ok(allowance, lines.join("\n"));
  assert.ok(allowance.includes(new Date(resetAt).toLocaleString()), allowance);
  assert.ok(allowance.includes(new Date(resetAt).toLocaleDateString()), allowance);
  assert.ok(lines.some((line) => line.startsWith("welcome:") && line.includes("$2.00")));
});
