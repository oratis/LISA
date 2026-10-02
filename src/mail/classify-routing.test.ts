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

test("inbound hygiene runs before the text reaches whichever model the router picks", async () => {
  // Route classification to a small local model and stand in for that runtime
  // with a socket that records what it is sent. The one-time code and the
  // sign-in link must already be gone by then.
  const http = await import("node:http");
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(`${req.method} ${req.url}\n${Buffer.concat(chunks).toString("utf8")}`);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "recorder only" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const saved = {
    small: process.env.LISA_MODEL_SMALL,
    host: process.env.OLLAMA_HOST,
  };
  process.env.LISA_MODEL_SMALL = "local://ollama/tiny-classifier";
  process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
  try {
    const secret: RawMail = {
      ...mail,
      uid: "otp-1",
      subject: "Your verification code is 482913",
      snippet:
        "Use 482913 to sign in, or open https://accounts.example.com/login?token=abcDEF123456789xyz",
    };
    const items = await classifyMail([secret], { model: "claude-sonnet-4-6" });

    assert.ok(received.length >= 1, "the routed model was never called");
    const wire = received.join("\n");
    assert.match(wire, /\/v1\/chat\/completions/);
    assert.match(wire, /tiny-classifier/); // the router's pick, not the strong model
    assert.equal(wire.includes("claude-sonnet-4-6"), false);
    assert.equal(wire.includes("482913"), false, "the one-time code reached the model");
    assert.equal(wire.includes("abcDEF123456789xyz"), false, "the sign-in token reached the model");
    assert.match(wire, /\[redacted: one-time code\]/);

    // The recorder refused, so grading fell back to heuristics — on cleaned text.
    assert.equal(items.length, 1);
    assert.equal(items[0]!.category, "security");
    assert.equal(JSON.stringify(items).includes("482913"), false);
  } finally {
    if (saved.small === undefined) delete process.env.LISA_MODEL_SMALL;
    else process.env.LISA_MODEL_SMALL = saved.small;
    if (saved.host === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = saved.host;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
