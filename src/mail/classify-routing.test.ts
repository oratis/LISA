import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMail } from "./classify.js";
import type { Provider, ProviderResult, ProviderRunOpts } from "../providers/types.js";
import type { RawMail } from "./types.js";

const mail: RawMail = {
  uid: "1",
  accountId: "acc",
  from: "Jane <jane@x.com>",
  fromAddress: "jane@x.com",
  subject: "Invoice #42 due",
  date: 1_700_000_000_000,
  snippet: "payment",
  flags: [],
  mailbox: "INBOX",
};

function recordingProvider(reply: string): { provider: Provider; models: string[] } {
  const models: string[] = [];
  return {
    models,
    provider: {
      name: "fake",
      async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
        models.push(opts.model);
        return {
          content: [{ type: "text", text: reply, citations: null }],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    },
  };
}

const REPLY = JSON.stringify([
  { uid: "1", category: "finance", importance: 2, reason: "an invoice is due" },
]);

test("a caller-pinned provider keeps the caller's model — no small-tier rerouting", async () => {
  const before = { ...process.env };
  process.env.LISA_MODEL_SMALL = "gpt-4o-mini";
  process.env.OPENAI_API_KEY = "k";
  try {
    const { provider, models } = recordingProvider(REPLY);
    const items = await classifyMail([mail], { provider, model: "claude-sonnet-4-6" });
    assert.deepEqual(models, ["claude-sonnet-4-6"]);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.category, "finance");
  } finally {
    for (const key of ["LISA_MODEL_SMALL", "OPENAI_API_KEY"] as const) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test("a pinned provider with no model still gets the previous default", async () => {
  const { provider, models } = recordingProvider(REPLY);
  await classifyMail([mail], { provider });
  assert.deepEqual(models, ["claude-sonnet-4-6"]);
});

test("an unusable route degrades to heuristic grading instead of failing the sweep", async () => {
  const before = process.env.LISA_MODEL_SMALL;
  // A local runtime nobody is listening on: the call fails, the mail is still graded.
  process.env.LISA_MODEL_SMALL = "local://llamacpp/none";
  const prevHost = process.env.OLLAMA_HOST;
  try {
    const controller = new AbortController();
    controller.abort();
    const items = await classifyMail([mail], { signal: controller.signal });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.category, "finance"); // from the finance heuristic
  } finally {
    if (before === undefined) delete process.env.LISA_MODEL_SMALL;
    else process.env.LISA_MODEL_SMALL = before;
    if (prevHost !== undefined) process.env.OLLAMA_HOST = prevHost;
  }
});
