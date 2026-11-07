import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { loadConfigEnv } from "../../src/env.js";
import { configureProxyFromEnv } from "../../src/proxy-bootstrap.js";
import { homeScope } from "../../src/paths.js";
import { readMemory, writeMemory } from "../../src/memory/store.js";
import { reflectOnSession } from "../../src/reflect.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { detectProvider, resolveDefaultModel } from "../../src/providers/registry.js";
import type { ProviderResult } from "../../src/providers/types.js";
import { cases } from "./cases.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (key: string, fallback: string) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
// Common main ancestor with identical baseline reflector and writer blobs.
const baseline = arg("baseline", "4115c1a01637ed96bebdc558964d923e0261ed72");
const repetitions = Number(arg("repetitions", "2"));
const label = arg("label", `run-${Date.now()}`);
if (!/^[a-z0-9_-]+$/i.test(label)) throw new Error("invalid result label");
const arms = arg("arms", "baseline,current")
  .split(",")
  .filter((a) => a === "baseline" || a === "current");
const selected = cases.filter(
  (c) => !arg("cases", "") || arg("cases", "").split(",").includes(c.id),
);
if (
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 3 ||
  !arms.length ||
  !selected.length
)
  throw new Error("invalid evaluation selection");
loadConfigEnv();
configureProxyFromEnv();
// No fallback: paired measurements must use the same selected model.
delete process.env.LISA_MODEL_FALLBACK;
const model = arg("model", resolveDefaultModel());
if (detectProvider(model) !== "anthropic")
  throw new Error("This evaluation records the Anthropic provider only");
const output = path.join(root, "research/reve-memory-eval/results", `${label}.json`);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, "", { flag: "wx" }); // Never overwrite evidence from a previous run.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-live-memory-eval-"));

// Freeze and execute the original reflector and original memory writer. All
// remaining imports use today's shared harness. No live Lisa files are used.
function sourceAt(file: string) {
  return execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" });
}
function relocate(source: string, originalDir: string) {
  return source.replace(/(["'])(\.{1,2}\/[^"']+)\1/g, (_, quote: string, spec: string) => {
    const target = path.resolve(root, originalDir, spec).replace(/\.js$/, ".ts");
    return `${quote}${pathToFileURL(target).href}${quote}`;
  });
}
const oldStorePath = path.join(temp, "baseline-store.mts");
await fs.writeFile(oldStorePath, relocate(sourceAt("src/memory/store.ts"), "src/memory"));
const oldReflectPath = path.join(temp, "baseline-reflect.mts");
const oldSource = relocate(sourceAt("src/reflect.ts"), "src").replace(
  pathToFileURL(path.join(root, "src/memory/store.ts")).href,
  pathToFileURL(oldStorePath).href,
);
await fs.writeFile(oldReflectPath, oldSource);
const oldReflect = (await import(pathToFileURL(oldReflectPath).href))
  .reflectOnSession as typeof reflectOnSession;

const trace = new AsyncLocalStorage<ProviderResult[]>();
const realRun = AnthropicProvider.prototype.runTurn;
AnthropicProvider.prototype.runTurn = async function (opts) {
  const result = await realRun.call(this, {
    ...opts,
    signal: opts.signal ?? AbortSignal.timeout(90_000),
  });
  trace.getStore()?.push(result);
  return result;
};
const results: Record<string, unknown>[] = [];
const metadata = {
  baseline,
  model,
  configuredGateway: !!process.env.ANTHROPIC_BASE_URL,
  repetitions,
  label,
  startedAt: new Date().toISOString(),
  syntheticData: true,
};
let consumedTokens = 0;
const persist = () =>
  fs.writeFile(output, JSON.stringify({ ...metadata, consumedTokens, results }, null, 2) + "\n");
try {
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const fixture of selected) {
      // Alternate ordering to reduce cache/order bias; each call runs sequentially.
      const order = repetition % 2 ? arms.toReversed() : arms;
      for (const arm of order) {
        if (consumedTokens > 300_000) throw new Error("evaluation token ceiling reached");
        const home = path.join(temp, `${arm}-${fixture.id}-${repetition}`);
        const calls: ProviderResult[] = [];
        const t0 = Date.now();
        const entry = await homeScope.run(home, () =>
          trace.run(calls, async () => {
            await writeMemory(fixture.store, fixture.before);
            try {
              const result = await (arm === "baseline" ? oldReflect : reflectOnSession)({
                history: fixture.history,
                sessionId: "eval-session",
                model,
              });
              const after = await readMemory(fixture.store);
              const other = await readMemory(fixture.store === "user" ? "memory" : "user");
              const all = after + "\n" + other;
              const missing = fixture.required.filter((r) => !r.test(after)).map(String);
              const unsupported = fixture.forbidden.filter((r) => r.test(all)).map(String);
              return {
                after,
                other,
                passed: !missing.length && !unsupported.length,
                missing,
                unsupported,
                result,
              };
            } catch (error) {
              return {
                passed: false,
                error: {
                  name: (error as Error).name,
                  status: (error as { status?: number }).status,
                },
                after: await readMemory(fixture.store),
              };
            }
          }),
        );
        const usage = calls.reduce(
          (u, c) => ({
            inputTokens: u.inputTokens + c.usage.inputTokens,
            outputTokens: u.outputTokens + c.usage.outputTokens,
            cacheReadTokens: u.cacheReadTokens + c.usage.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens + c.usage.cacheWriteTokens,
          }),
          { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        );
        consumedTokens += Object.values(usage).reduce((a, b) => a + b, 0);
        results.push({
          case: fixture.id,
          category: fixture.category,
          arm,
          repetition,
          before: fixture.before,
          history: fixture.history,
          ...entry,
          usage,
          servedModels: [...new Set(calls.map((c) => c.model ?? "unreported"))],
          calls: calls.length,
          durationMs: Date.now() - t0,
        });
        await persist();
        console.log(
          JSON.stringify({
            case: fixture.id,
            arm,
            repetition,
            passed: entry.passed,
            usage,
            consumedTokens,
          }),
        );
      }
    }
  }
} finally {
  AnthropicProvider.prototype.runTurn = realRun;
  await persist();
  await fs.rm(temp, { recursive: true, force: true });
}
console.log(`Results: ${output}`);
