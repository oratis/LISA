/**
 * `lisa model <list|install|use|health>` — local-model lifecycle (M1).
 * Thin CLI over src/model/local.ts; `use` writes config.env via env.ts.
 */
import { OllamaBackend, localEndpoint, parseLocalRef } from "../model/local.js";
import {
  detectPlan,
  detectPlans,
  parsePlanRef,
  selectedPlan,
  type PlanStatus,
} from "../model/plans.js";
import { saveConfigEnv } from "../env.js";

function gb(bytes?: number): string {
  return bytes ? `  (${(bytes / 1e9).toFixed(1)} GB)` : "";
}

/** One row in `lisa model list`'s coding-plans section. */
function planLine(p: PlanStatus, selected: boolean): string {
  const mark = !p.available ? "✗" : p.loggedIn === true ? "✓" : p.loggedIn === false ? "✗" : "?";
  const exp = p.experimental ? " (experimental)" : "";
  const star = selected ? "  ★ selected" : "";
  return `${mark} ${p.label.padEnd(22)} plan://${p.id.padEnd(8)} — ${p.detail}${exp}${star}`;
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

    // Coding plans — delegate coding work to a subscription CLI (detection only;
    // delegation wiring is a later phase, see docs/CODING_PLANS.md).
    const sel = selectedPlan();
    console.log("\ncoding plans (run coding work on a subscription, not an API key):");
    for (const p of detectPlans()) console.log("  " + planLine(p, sel === p.id));
    console.log("  switch with:  lisa model use plan://<claude|codex|copilot>");
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

    // `plan://<id>` selects a coding-plan delegation target. This does NOT touch
    // LISA_MODEL — her own loop keeps its provider; the plan is only the default
    // target for delegated coding work (docs/CODING_PLANS.md).
    const planId = ref ? parsePlanRef(ref) : null;
    if (planId) {
      await saveConfigEnv({ LISA_CODING_PLAN: planId });
      const status = detectPlan(planId);
      console.log(`✓ coding-plan target → ${status.label} (plan://${planId}).`);
      if (!status.available) console.log(`⚠ ${status.cli} isn't installed yet — ${status.detail}.`);
      else if (status.loggedIn === false) console.log(`⚠ ${status.detail}.`);
      console.log(
        "  Detection + selection only in this build — delegation runs on the existing\n" +
          "  CLI bridge in a later phase (docs/CODING_PLANS.md). Your own model is unchanged.",
      );
      return 0;
    }

    const parsed = ref ? parseLocalRef(ref) : null;
    if (!parsed) {
      console.error(
        "usage: lisa model use local://<model>   (e.g. local://qwen2.5-coder:32b)\n" +
          "   or: lisa model use plan://<claude|codex|copilot>",
      );
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

  console.error(
    "usage: lisa model <list | install <model> | use local://<model> | use plan://<claude|codex|copilot> | health>",
  );
  return 2;
}
