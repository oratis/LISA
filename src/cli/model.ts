/**
 * `lisa model <list|install|use|health>` — local-model lifecycle (M1).
 * Thin CLI over src/model/local.ts; `use` writes config.env via env.ts.
 */
import { OllamaBackend, localEndpoint, parseLocalRef } from "../model/local.js";
import { saveConfigEnv } from "../env.js";

function gb(bytes?: number): string {
  return bytes ? `  (${(bytes / 1e9).toFixed(1)} GB)` : "";
}

export async function runModelCommand(subargs: string[]): Promise<number> {
  const sub = subargs[0];

  if (sub === "health") {
    const backend = new OllamaBackend();
    const h = await backend.health();
    console.log(`${backend.name} @ ${backend.host}: ${h}`);
    return h === "up" ? 0 : 1;
  }

  if (sub === "list") {
    const backend = new OllamaBackend();
    const health = await backend.health();
    console.log(`local backend: ${backend.name} @ ${backend.host} (${health})`);
    if (health === "up") {
      const installed = await backend.listInstalled();
      if (installed.length === 0) {
        console.log("  (none installed — `lisa model install <model>`)");
      }
      for (const m of installed) console.log(`  ${m.name}${gb(m.sizeBytes)}`);
    } else {
      console.log("  (backend not running — start it, e.g. `ollama serve`)");
    }
    const base = process.env.LISA_BASE_URL;
    const model = process.env.LISA_MODEL;
    console.log(
      `\nconfigured: ${base ? `${base}${model ? ` · model=${model}` : ""}` : "(cloud provider — no local endpoint set)"}`,
    );
    return 0;
  }

  if (sub === "install") {
    const model = subargs[1];
    if (!model) {
      console.error("usage: lisa model install <model>   (e.g. qwen2.5-coder:32b)");
      return 2;
    }
    const backend = new OllamaBackend();
    console.log(`pulling "${model}" via ${backend.name}…`);
    try {
      await backend.install(model, (line) => console.error(line));
      console.log(`✓ ${model} installed. Switch to it with:  lisa model use local://${model}`);
      return 0;
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`);
      return 1;
    }
  }

  if (sub === "use") {
    const ref = subargs[1];
    const parsed = ref ? parseLocalRef(ref) : null;
    if (!parsed) {
      console.error("usage: lisa model use local://<model>   (e.g. local://qwen2.5-coder:32b)");
      return 2;
    }
    const ep = localEndpoint(parsed.backend);
    await saveConfigEnv({
      LISA_BASE_URL: ep.baseURL,
      LISA_API_KEY: ep.apiKey,
      LISA_MODEL: parsed.model,
    });
    console.log(`✓ default model → "${parsed.model}" via ${parsed.backend} (${ep.baseURL}).`);
    // Probe so the user finds out now, not on the next chat, if it isn't running.
    const { defaultRuntime } = await import("../model/local.js");
    const probe = await defaultRuntime.httpGet(`${ep.host}/api/tags`);
    if (!probe.ok) {
      console.log(
        `⚠ ${parsed.backend} doesn't appear to be running at ${ep.host} — start it ` +
          `(e.g. \`ollama serve\`) and \`lisa model install ${parsed.model}\` if you haven't.`,
      );
    }
    return 0;
  }

  console.error("usage: lisa model <list | install <model> | use local://<model> | health>");
  return 2;
}
