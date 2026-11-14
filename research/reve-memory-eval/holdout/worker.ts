// A fresh process, operator home and tenant per arm and case. The driver sends
// only synthetic conversation inputs here, keeping its rubric out of the model.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { StoredMessage } from "../../../src/types.js";
import type { ProviderResult, ProviderRunOpts } from "../../../src/providers/types.js";

export interface Scenario {
  id: string;
  store: "user" | "memory";
  before: string;
  sessions: { id: string; turns: StoredMessage[]; origin?: "legacy" | "owner" | "channel" }[];
}
export interface Request {
  root: string;
  scenario: Scenario;
  model: string;
  anchor: number;
  nativeSessions: boolean;
}
export type Memory = Record<Scenario["store"], string>;
type Usage = Omit<ProviderResult["usage"], "cacheWrite1hTokens">;
interface Call {
  requested: string;
  served: string | null;
  usage: Usage | null;
  // Includes unsuccessful SDK/stream retries, whose billable usage is unknown.
  http: (number | null)[];
  error?: string;
}
export interface Observation {
  before: Memory;
  after: Memory;
  calls: Call[];
  revisions: unknown[];
  reflection?: { raw: string; applied: string[]; skipped: string[]; malformed: boolean };
  error?: string;
}
interface Stream {
  finalMessage(): Promise<{ model: string }>;
}
interface MessagesResource {
  stream(...parameters: unknown[]): Stream;
}
interface TracedProvider {
  client: { messages: MessagesResource };
  runTurn(opts: ProviderRunOpts): Promise<ProviderResult>;
}

function safeError(error: unknown) {
  // SDK error messages can include request headers, endpoints or local paths.
  return error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 80) : "Error";
}

async function trial({
  root,
  scenario,
  model,
  anchor,
  nativeSessions,
}: Request): Promise<Observation> {
  const load = (name: string) => import(pathToFileURL(path.join(root, "src", name + ".ts")).href);
  const { configureProxyFromEnv } = await load("proxy-bootstrap");
  configureProxyFromEnv();
  const { detectProvider } = await load("providers/registry");
  if (detectProvider(model) !== "anthropic") throw new Error("unexpected provider");

  const { AnthropicProvider } = await load("providers/anthropic");
  const prototype: TracedProvider = AnthropicProvider.prototype;
  const original = prototype.runTurn;
  const fetchOriginal = globalThis.fetch;
  const calls: Call[] = [];
  let active: Call | undefined;
  globalThis.fetch = async (...args) => {
    const trace = active;
    const index = trace?.http.push(null);
    const response = await fetchOriginal(...args);
    if (trace && index) trace.http[index - 1] = response.status;
    return response;
  };
  prototype.runTurn = async function (opts) {
    const call: Call = { requested: opts.model, served: null, usage: null, http: [] };
    calls.push(call);
    active = call;
    // Older releases discard message.model. Observe the same final SDK response
    // the production adapter consumes; leave request and response intact.
    const resource = this.client.messages;
    const stream = resource.stream;
    resource.stream = function (...args) {
      const response = stream.apply(this, args);
      const final = response.finalMessage;
      response.finalMessage = async function () {
        const message = await final.call(this);
        call.served = message.model;
        return message;
      };
      return response;
    };
    try {
      const result = await original.call(this, {
        ...opts,
        signal: opts.signal ?? AbortSignal.timeout(90_000),
      });
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = result.usage;
      call.usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
      return result;
    } catch (err) {
      call.error = safeError(err);
      throw err;
    } finally {
      resource.stream = stream;
      active = undefined;
    }
  };

  const { sessionsDir, memoryDir } = await load("paths");
  const { readMemory, writeMemory } = await load("memory/store");
  const readBoth = async (): Promise<Memory> => ({
    user: await readMemory("user"),
    memory: await readMemory("memory"),
  });
  const { loadSessionMessages } = await load("sessions/list");
  const { reflectOnSession }: typeof import("../../../src/reflect.js") = await load("reflect");
  await writeMemory(scenario.store, scenario.before);
  const before = await readBoth();
  await fs.mkdir(sessionsDir(), { recursive: true, mode: 0o700 });
  const { SessionStore }: typeof import("../../../src/sessions/store.js") =
    await load("sessions/store");
  let lastId = "";
  for (const [index, session] of scenario.sessions.entries()) {
    const start = anchor - (scenario.sessions.length - index) * 3_600_000;
    const at = (offset: number) => new Date(start + offset).toISOString();
    // Native trials use the measured version's real header, including its origin
    // policy. Legacy fixtures reproduce the unmarked v2 format before this change.
    const live =
      nativeSessions && session.origin !== "legacy"
        ? await SessionStore.create({ cwd: "/synthetic", model, origin: session.origin ?? "owner" })
        : undefined;
    lastId = live?.id ?? session.id;
    const header = live?.header ?? {
      type: "session",
      id: lastId,
      version: 2,
      cwd: "/synthetic",
      model,
    };
    const records = [
      { ...header, startedAt: at(0) },
      ...session.turns.map((message, i) => ({ type: "message", ts: at(i + 1), message })),
    ];
    const file = live?.path ?? path.join(sessionsDir(), session.id + ".jsonl");
    await fs.writeFile(file, records.map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
      flag: live ? "w" : "wx",
      mode: 0o600,
    });
    await fs.utimes(file, new Date(start), new Date(start + session.turns.length));
  }
  const { messages } = await loadSessionMessages(lastId);
  let reflection: Observation["reflection"];
  let error: string | undefined;
  try {
    // All prior sessions are on disk. Only the last conversation is passed to
    // the normal reflection entry point, exactly as for a resumed installation.
    const result = await reflectOnSession({ sessionId: lastId, history: messages, model });
    const clean = (s: string) => s.replaceAll(process.env.LISA_HOME!, "<synthetic-home>");
    reflection = {
      raw: clean(result.raw),
      applied: result.applied.map(clean),
      skipped: result.skipped.map(clean),
      malformed: !!result.malformed,
    };
    if (result.malformed) error = "MalformedReflection";
    if (!calls.some((c) => c.usage && c.usage.outputTokens > 0)) error = "NoReportedCompletion";
    if (calls.some((c) => c.served !== model || c.requested !== model)) error = "ModelUnconfirmed";
  } catch (err) {
    error = safeError(err);
  }
  const revisionsDir = path.join(memoryDir(), "revisions");
  let names: string[];
  try {
    names = await fs.readdir(revisionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    names = [];
  }
  const revisions = [];
  for (const name of names.sort()) {
    if (/^[a-f0-9]{64}\.json$/.test(name)) {
      revisions.push(JSON.parse(await fs.readFile(path.join(revisionsDir, name), "utf8")));
    }
  }
  return { before, after: await readBoth(), calls, revisions, reflection, error };
}

process.once("message", async (request: Request) => {
  try {
    const result = await trial(request);
    process.send!({ result });
  } catch (error) {
    process.send!({ fatal: safeError(error) });
  } finally {
    process.disconnect();
  }
});
