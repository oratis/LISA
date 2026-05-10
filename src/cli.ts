#!/usr/bin/env node
import process from "node:process";
import { runAgent } from "./agent.js";
import { buildApprovalCallback, type ApprovalMode, DEFAULT_MUTATING_TOOLS } from "./approval.js";
import { CONFIG_ENV_PATH, loadConfigEnv } from "./env.js";
import { ensureDir } from "./fs-utils.js";
import { runHeartbeatOnce } from "./heartbeat/runner.js";
import { fireHooks } from "./hooks/runner.js";
import { DEFAULT_MODEL } from "./llm.js";
import { connectMcpServers } from "./mcp/client.js";
import { loadMcpConfig } from "./mcp/config.js";
import { LISA_HOME } from "./paths.js";
import { loadAllPlugins, PLUGINS_ROOT } from "./plugins/loader.js";
import type { HookSpec } from "./plugins/types.js";
import { buildSystemPromptSnapshot, getPromptFingerprint } from "./prompt.js";
import { providerForModel } from "./providers/registry.js";
import { reflectOnSession } from "./reflect.js";
import { runRepl } from "./cli/repl.js";
import { listSessionsOnDisk, loadSessionMessages } from "./sessions/list.js";
import { SessionStore } from "./sessions/store.js";
import { birth } from "./soul/birth.js";
import { isBorn, readSoulSummary } from "./soul/store.js";
import { createTaskTool } from "./tools/task.js";
import { buildToolRegistry, readOnlySubset } from "./tools/registry.js";
import type { AgentEvent, StoredMessage, ToolDefinition } from "./types.js";

const HELP = `Lisa — your self-evolving local AI assistant.

Usage:
  lisa                         Start an interactive session.
  lisa "prompt"                Run one prompt and exit.
  lisa resume <id> [prompt]    Resume a previous session by id.
  lisa sessions                List recent sessions.
  lisa serve --web [--port N]  Start the web UI (default port 5757).
  lisa serve --channels <list> Start IM channel adapters (comma-separated, or "all").
                                  Built-in: telegram, discord, slack, webhook, imessage.
                                  Config: ~/.lisa/channels.json
  lisa serve --imessage        Shortcut for --channels imessage (macOS).
  lisa channels                List available channel adapters.
  lisa skills list             List executable skills (~/.lisa/skills/<slug>/tool.js).
  lisa skills approve <slug>   Review the source of a skill's tool.js and approve it.
  lisa skills disable <slug> [reason]   Block an approved skill from loading.
  lisa skills enable <slug>    Remove a disable flag.
  lisa skills audit <slug>     Show the audit trail.
  lisa heartbeat run [name]    Run heartbeat tasks once (incl. self-driven desires).
  lisa heartbeat install [--load] [--every <30m|1h|...>]
                                Install macOS launchd plist (or print cron line).
  lisa heartbeat uninstall      Remove the launchd plist (macOS).
  lisa search "<query>"        Search past sessions (TF-IDF).
  lisa birth                   Run the birth ritual (auto-runs on first launch).
  lisa soul                    Print Lisa's current soul summary.
  lisa --help                  Show this message.

Flags:
  --model <id>          Override default (${DEFAULT_MODEL}).
  --provider <name>     anthropic | openai (else inferred from model).
  --think               Enable adaptive thinking each turn.
  --no-reflect          Skip end-of-session reflection.
  --compact             Enable Anthropic context compaction beta.
  --approval <mode>     auto | ask | ask-mutating  (default: auto)
  --no-mcp              Skip loading MCP servers.
  --no-plugins          Skip loading plugins.
  --voice               Enable speak/transcribe tools.
  --idle <minutes>      Trigger idle mode after N min of no input (default: 60).
  --no-idle             Disable idle mode entirely.

REPL slash commands:
  /help, /exit, /quit
  /skills [view <name>]
  /memory
  /sessions
  /reflect              Run reflection on the current session immediately.
  /search <query>       Search past sessions.
  /think                Toggle adaptive thinking.
  /clear                Forget current in-memory history (session log preserved).
  /save <text>          Append to MEMORY.md immediately.

Data: ${LISA_HOME}
Plugins: ${PLUGINS_ROOT}/<name>/{commands,agents,skills,hooks,.lisa-plugin/plugin.json}
MCP:     ${LISA_HOME}/mcp.json   (Claude-Code-style {"mcpServers": {...}})
Heartbeat: ${LISA_HOME}/heartbeat.json   ({"tasks": [{name, prompt, ...}]})
Config:  ${CONFIG_ENV_PATH}   (KEY=VALUE)`;

interface ParsedArgs {
  showHelp: boolean;
  reflect: boolean;
  thinking: boolean;
  compaction: boolean;
  model: string;
  approval: ApprovalMode;
  loadMcp: boolean;
  loadPlugins: boolean;
  voice: boolean;
  idleMinutes: number;
  subcommand?:
    | "resume"
    | "sessions"
    | "serve"
    | "heartbeat"
    | "search"
    | "birth"
    | "soul"
    | "channels"
    | "skills";
  subargs: string[];
  serveWeb: boolean;
  serveImessage: boolean;
  serveChannels: string[];
  port: number;
  prompt: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    showHelp: false,
    reflect: true,
    thinking: false,
    compaction: false,
    model: DEFAULT_MODEL,
    approval: "auto",
    loadMcp: true,
    loadPlugins: true,
    voice: false,
    idleMinutes: 60,
    subargs: [],
    serveWeb: false,
    serveImessage: false,
    serveChannels: [],
    port: 5757,
    prompt: null,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") out.showHelp = true;
    else if (arg === "--no-reflect") out.reflect = false;
    else if (arg === "--think" || arg === "--thinking") out.thinking = true;
    else if (arg === "--compact") out.compaction = true;
    else if (arg === "--no-mcp") out.loadMcp = false;
    else if (arg === "--no-plugins") out.loadPlugins = false;
    else if (arg === "--voice") out.voice = true;
    else if (arg === "--no-idle") out.idleMinutes = 0;
    else if (arg === "--idle") {
      const v = mustNext(argv, ++i, "--idle");
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) throw new Error(`bad --idle: ${v}`);
      out.idleMinutes = n;
    }
    else if (arg === "--web") out.serveWeb = true;
    else if (arg === "--imessage") out.serveImessage = true;
    else if (arg === "--channels") {
      out.serveChannels = mustNext(argv, ++i, "--channels")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--channels=")) {
      out.serveChannels = arg
        .slice("--channels=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    else if (arg === "--model") out.model = mustNext(argv, ++i, "--model");
    else if (arg.startsWith("--model=")) out.model = arg.slice("--model=".length);
    else if (arg === "--provider") {
      const v = mustNext(argv, ++i, "--provider");
      process.env.LISA_PROVIDER = v;
    } else if (arg === "--approval") {
      const v = mustNext(argv, ++i, "--approval") as ApprovalMode;
      if (!["auto", "ask", "ask-mutating"].includes(v)) {
        throw new Error(`bad --approval mode: ${v}`);
      }
      out.approval = v;
    } else if (arg === "--port") {
      out.port = parseInt(mustNext(argv, ++i, "--port"), 10);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) {
    const first = positional[0]!;
    if (
      first === "resume" ||
      first === "sessions" ||
      first === "serve" ||
      first === "heartbeat" ||
      first === "search" ||
      first === "birth" ||
      first === "soul" ||
      first === "channels" ||
      first === "skills"
    ) {
      out.subcommand = first;
      out.subargs = positional.slice(1);
    } else {
      out.prompt = positional.join(" ");
    }
  }
  return out;
}

function mustNext(argv: string[], idx: number, flag: string): string {
  const v = argv[idx];
  if (!v) throw new Error(`${flag} requires a value`);
  return v;
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(HELP);
    process.exit(2);
  }
  if (args.showHelp) {
    console.log(HELP);
    return;
  }

  await ensureDir(LISA_HOME);
  loadConfigEnv();

  // ── soul-only subcommands (don't need agent loop) ─────────────────────
  if (args.subcommand === "birth") {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("Birth ritual needs ANTHROPIC_API_KEY (an LLM dreams Lisa into existence).");
      process.exit(1);
    }
    await runBirthCeremony(args.model);
    return;
  }

  if (args.subcommand === "soul") {
    const summary = await readSoulSummary();
    if (!summary) {
      console.log("Lisa hasn't been born yet. Run `lisa birth`.");
      return;
    }
    printSoulSummary(summary);
    return;
  }

  if (args.subcommand === "channels") {
    const { listAvailableChannels, registerBuiltins } = await import("./channels/registry.js");
    const { loadChannelsConfig, CHANNELS_CONFIG_PATH } = await import("./channels/config.js");
    await registerBuiltins();
    const available = listAvailableChannels();
    const cfg = await loadChannelsConfig();
    console.log("Available channel adapters:\n");
    for (const name of available) {
      const entry = cfg.channels[name];
      const status = !entry
        ? "(not configured)"
        : entry.enabled === false
          ? "(disabled)"
          : "configured ✓";
      console.log(`  ${name.padEnd(12)} ${status}`);
    }
    console.log(`\nConfig: ${CHANNELS_CONFIG_PATH}`);
    console.log(`Start: lisa serve --channels <comma-list>  (or --channels all)`);
    return;
  }

  if (args.subcommand === "skills") {
    await handleSkillsSubcommand(args.subargs);
    return;
  }

  if (args.subcommand === "sessions") {
    const sessions = await listSessionsOnDisk();
    for (const s of sessions) {
      console.log(
        `${s.id}  ${s.startedAt}  msgs=${s.messageCount}  model=${s.model}` +
          (s.lastUserMessage ? `  last="${s.lastUserMessage}"` : ""),
      );
    }
    return;
  }
  if (args.subcommand === "search") {
    const query = args.subargs.join(" ");
    if (!query) {
      console.error("usage: lisa search <query>");
      process.exit(2);
    }
    const { buildIndex, search } = await import("./memory/vector.js");
    const index = await buildIndex();
    const hits = search(index, query, 10);
    if (hits.length === 0) console.log("(no matches)");
    for (const h of hits) {
      console.log(
        `[${h.startedAt}] ${h.sessionId} (score=${h.score.toFixed(2)})\n  ${h.excerpt}\n`,
      );
    }
    return;
  }

  // Most paths from here need the API key.
  // Exception: `serve --web` defers the key check to the browser UI, which
  // shows a popup that writes the key to ~/.lisa/config.env on save.
  const isWebServe = args.subcommand === "serve" && args.serveWeb;
  const provider = providerForModel(args.model);
  if (!isWebServe) {
    if (provider.name === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
      console.error(
        `Lisa needs ANTHROPIC_API_KEY. Set it in your shell or in ${CONFIG_ENV_PATH}:\n\n  ANTHROPIC_API_KEY=sk-ant-...\n\nGet a key at https://console.anthropic.com/.`,
      );
      process.exit(1);
    }
    if (provider.name === "openai" && !process.env.OPENAI_API_KEY) {
      console.error(
        `Lisa needs OPENAI_API_KEY for the OpenAI provider. Set it in your shell or in ${CONFIG_ENV_PATH}.`,
      );
      process.exit(1);
    }
  }

  // ── auto-birth on first launch ──────────────────────────────────────
  // Skipped for `serve --web` — the browser UI runs the birth ritual itself
  // (and only after the API key has been entered via the config popup).
  if (!isWebServe && !(await isBorn())) {
    console.error(
      "\nLisa hasn't been born yet — running her birth ritual now (one-time, ~30s).\nIf you'd rather skip this, hit Ctrl-C and run `lisa birth` later.\n",
    );
    await runBirthCeremony(args.model);
    console.error("\n");
  }

  // Executable skills (Phase 3.1): tool.js files in ~/.lisa/skills/<slug>/
  // that have been explicitly approved by SHA. Sandbox is the user's review,
  // not the runtime — these run in-process. Unapproved or stale ones are
  // surfaced as a startup notice; the user runs `lisa skills approve <slug>`.
  const { discoverExecutableSkills, loadApprovedExecutableTools, summarizeCandidate } =
    await import("./skills/executable.js");
  const skillCandidates = await discoverExecutableSkills();
  const executableTools = await loadApprovedExecutableTools((m) => console.error(m));
  if (skillCandidates.length > 0) {
    const pending = skillCandidates.filter((c) => c.status !== "approved-current");
    if (pending.length > 0) {
      console.error(`\n[skills] ${executableTools.length} executable tool(s) loaded; ${pending.length} pending:`);
      for (const c of pending) console.error(summarizeCandidate(c));
      console.error(`Run \`lisa skills approve <slug>\` to review and approve.\n`);
    }
  }
  const baseTools = buildToolRegistry({ includeVoice: args.voice, extra: executableTools });

  // Load plugins (skills/commands/agents/hooks/mcp).
  const plugins = args.loadPlugins ? await loadAllPlugins() : [];
  const allHooks: HookSpec[] = plugins.flatMap((p) => p.hooks);
  const pluginMcp = plugins.flatMap((p) => p.mcpServers);

  // Load MCP servers (config + plugins).
  let mcpConnections: Awaited<ReturnType<typeof connectMcpServers>> = [];
  if (args.loadMcp) {
    const configMcp = await loadMcpConfig();
    const allSpecs = [...configMcp, ...pluginMcp];
    if (allSpecs.length > 0) {
      mcpConnections = await connectMcpServers(allSpecs, (m) =>
        console.error(m),
      );
    }
  }
  const mcpTools = mcpConnections.flatMap((c) => c.tools);

  // Build the full tool list, including the task subagent tool.
  const abortController = new AbortController();
  process.on("SIGINT", () => abortController.abort());
  const cwd = process.cwd();

  const composedTools: ToolDefinition[] = [...baseTools, ...mcpTools];
  const taskTool = createTaskTool({
    fullToolset: () => composedTools,
    readOnlyToolset: () => readOnlySubset(composedTools),
    cwd,
    signal: abortController.signal,
    defaultModel: args.model,
  });
  composedTools.push(taskTool as ToolDefinition);
  composedTools.sort((a, b) => a.name.localeCompare(b.name));

  // Heartbeat sub-command — uses the assembled toolset.
  if (args.subcommand === "heartbeat") {
    const sub = args.subargs[0];
    if (sub === "install") {
      const { installHeartbeat } = await import("./heartbeat/install.js");
      const everyIdx = args.subargs.indexOf("--every");
      const schedule =
        everyIdx >= 0 && args.subargs[everyIdx + 1]
          ? `every:${args.subargs[everyIdx + 1]}`
          : undefined;
      const load = args.subargs.includes("--load");
      const result = await installHeartbeat({ schedule, load });
      console.log(`platform: ${result.platform}\n${result.instructions}`);
      await Promise.all(mcpConnections.map((c) => c.close()));
      return;
    }
    if (sub === "uninstall") {
      const { uninstallHeartbeat } = await import("./heartbeat/install.js");
      console.log(await uninstallHeartbeat());
      await Promise.all(mcpConnections.map((c) => c.close()));
      return;
    }
    if (sub !== "run") {
      console.error("usage: lisa heartbeat <run|install|uninstall> [args...]");
      process.exit(2);
    }
    const results = await runHeartbeatOnce({
      tools: composedTools,
      cwd,
      signal: abortController.signal,
      model: args.model,
      taskFilter: args.subargs[1],
    });
    for (const r of results) {
      if (r.silent) {
        console.error(`[heartbeat:${r.task}] (silent)`);
      } else {
        console.log(`[heartbeat:${r.task}]\n${r.output}\n`);
      }
    }
    await Promise.all(mcpConnections.map((c) => c.close()));
    return;
  }

  // Serve sub-command — web or imessage.
  if (args.subcommand === "serve") {
    if (args.serveWeb) {
      const { startWebServer } = await import("./web/server.js");
      await startWebServer({
        port: args.port,
        tools: composedTools,
        model: args.model,
        thinking: args.thinking,
        reflect: args.reflect,
        idleMinutes: args.idleMinutes,
      });
      console.error(`Lisa web UI listening on http://localhost:${args.port}`);
      // Keep alive until SIGINT.
      await new Promise<void>(() => {});
      return;
    }
    if (args.serveImessage) args.serveChannels.push("imessage");
    if (args.serveChannels.length > 0) {
      const { ChannelRouter } = await import("./channels/router.js");
      const { loadChannelsConfig } = await import("./channels/config.js");
      const { makeChannel, registerBuiltins, listAvailableChannels } = await import("./channels/registry.js");
      await registerBuiltins();
      const cfg = await loadChannelsConfig();
      let names = args.serveChannels;
      if (names.includes("all")) {
        names = Object.keys(cfg.channels).filter(
          (n) => cfg.channels[n]!.enabled !== false,
        );
      }
      if (names.length === 0) {
        console.error(
          `No channels selected. Built-in adapters: ${listAvailableChannels().join(", ")}\nDefine them in ~/.lisa/channels.json then run \`lisa serve --channels <list>\`.`,
        );
        process.exit(2);
      }
      const adapters = [];
      for (const n of names) {
        const entry = cfg.channels[n] ?? {};
        if (entry.enabled === false) {
          console.error(`[router] ${n} disabled in config, skipping`);
          continue;
        }
        try {
          adapters.push(await makeChannel(n, entry));
        } catch (err) {
          console.error(`[router] ${n} failed to init: ${(err as Error).message}`);
        }
      }
      if (adapters.length === 0) {
        console.error("no channels could be started — check config and credentials");
        process.exit(1);
      }
      const router = new ChannelRouter({
        channels: adapters,
        tools: composedTools,
        cwd,
        signal: abortController.signal,
        model: args.model,
        thinking: args.thinking,
        compaction: args.compaction,
      });
      await router.start();
      console.error(
        `Lisa is now reachable on: ${adapters.map((a) => a.name).join(", ")}`,
      );
      const shutdown = async () => {
        console.error("\n[router] shutting down…");
        await router.stop();
        if (args.reflect) await router.reflectAll();
        await Promise.all(mcpConnections.map((c) => c.close()));
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise<void>(() => {});
      return;
    }
    console.error("usage: lisa serve --web [--port N]  |  lisa serve --channels <list>");
    process.exit(2);
  }

  // Resume vs new.
  let session: SessionStore;
  let history: StoredMessage[];
  if (args.subcommand === "resume") {
    const id = args.subargs[0];
    if (!id) {
      console.error("usage: lisa resume <id> [prompt]");
      process.exit(2);
    }
    const loaded = await loadSessionMessages(id);
    session = await SessionStore.open(id);
    history = loaded.messages;
    args.prompt = args.subargs.slice(1).join(" ") || null;
    console.error(`Resumed session ${id} (${history.length} messages).`);
  } else {
    session = await SessionStore.create({ cwd, model: args.model });
    history = [];
  }

  const snapshot = await buildSystemPromptSnapshot();
  const initialFingerprint = await getPromptFingerprint();
  const totalSkills = snapshot.skillCount + plugins.flatMap((p) => p.skills).length;
  console.error(
    `Lisa session ${session.id} — ${totalSkills} skills, ${snapshot.memoryBytes}B memory, ${composedTools.length} tools, ${mcpConnections.length} mcp, ${plugins.length} plugins, model=${args.model}${args.thinking ? ", thinking=adaptive" : ""}${args.compaction ? ", compaction=on" : ""}, approval=${args.approval}`,
  );

  const approval = buildApprovalCallback({
    mode: args.approval,
    mutatingTools: DEFAULT_MUTATING_TOOLS,
  });

  const rebuildPrompt = makeHotReloadRebuilder(initialFingerprint, snapshot.text);

  const turn = async (prompt: string): Promise<void> => {
    process.stdout.write("\nLisa> ");
    // Per-turn freshness: pick up any cross-session writes to soul / skills /
    // memory (e.g. she patched her own soul during the previous turn). The
    // closure caches by fingerprint so this is cheap when nothing changed.
    const fresh = await rebuildPrompt();
    const result = await runAgent({
      provider,
      systemPrompt: fresh.text,
      tools: composedTools,
      toolCtx: { cwd, signal: abortController.signal, log: () => {} },
      history,
      userMessage: prompt,
      model: args.model,
      thinking: args.thinking,
      compaction: args.compaction,
      approval,
      preToolHook: async (name, input) => {
        const r = await fireHooks(
          "PreToolUse",
          allHooks,
          { TOOL_NAME: name, TOOL_INPUT: JSON.stringify(input), SESSION_ID: session.id, LISA_HOME, CLAUDE_PROJECT_DIR: cwd },
          cwd,
        );
        if (r.blocked.length > 0) return { block: r.blocked.join("; ") };
      },
      postToolHook: async (name, input, result, isError) => {
        const r = await fireHooks(
          "PostToolUse",
          allHooks,
          {
            TOOL_NAME: name,
            TOOL_INPUT: JSON.stringify(input),
            TOOL_RESULT: result,
            TOOL_ERROR: isError ? "1" : "",
            SESSION_ID: session.id,
            LISA_HOME,
            CLAUDE_PROJECT_DIR: cwd,
          },
          cwd,
        );
        if (r.rewriteResult != null) return { rewriteResult: r.rewriteResult };
      },
      onEvent: renderEvent,
      onMessagePersist: (msg) => session.appendMessage(msg),
      hotReload: {
        initialFingerprint: fresh.fingerprint,
        rebuild: rebuildPrompt,
      },
    });
    process.stdout.write("\n");
    history.length = 0;
    history.push(...result.history);
    if (result.cacheReadTokens || result.cacheWriteTokens || result.inputTokens) {
      console.error(
        `[tokens in=${result.inputTokens} out=${result.outputTokens} cache_read=${result.cacheReadTokens} cache_write=${result.cacheWriteTokens}]`,
      );
    }
  };

  const finish = async (): Promise<void> => {
    if (!args.reflect || history.length < 2) return;
    console.error("\n[lisa] reflecting on session…");
    try {
      const reflection = await reflectOnSession({
        history,
        sessionId: session.id,
        model: args.model,
      });
      await session.appendReflection(reflection.summary);
      console.error(`[reflection] ${reflection.summary}`);
      for (const a of reflection.applied) console.error(`  applied: ${a}`);
      for (const s of reflection.skipped) console.error(`  skipped: ${s}`);
    } catch (err) {
      console.error(`[reflection] failed: ${(err as Error).message}`);
    }
    await fireHooks(
      "SessionEnd",
      allHooks,
      { SESSION_ID: session.id, LISA_HOME },
      cwd,
    );
    await Promise.all(mcpConnections.map((c) => c.close()));
  };

  if (args.prompt) {
    await turn(args.prompt);
    await finish();
    return;
  }

  await fireHooks(
    "SessionStart",
    allHooks,
    { SESSION_ID: session.id, LISA_HOME },
    cwd,
  );

  // Idle watcher in REPL mode: fire silently (writes journal/skills only —
  // we don't want a popup interrupting an active terminal session).
  if (args.idleMinutes > 0) {
    const { getIdleWatcher } = await import("./idle/watcher.js");
    const { runIdleOnce } = await import("./idle/runner.js");
    const watcher = getIdleWatcher(args.idleMinutes * 60_000);
    let busy = false;
    watcher.on("idle", async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await runIdleOnce({
          tools: composedTools,
          cwd,
          signal: abortController.signal,
          model: args.model,
          idleMs: watcher.idleFor(),
        });
        if (!r.silent) {
          process.stderr.write(`\n\n[★ while you were away]\n${r.text}\n\nyou> `);
        }
      } catch (err) {
        process.stderr.write(`\n[idle] error: ${(err as Error).message}\n`);
      } finally {
        busy = false;
      }
    });
    watcher.start();
  }

  await runRepl({
    onLine: async (line) => {
      try {
        const { getIdleWatcher } = await import("./idle/watcher.js");
        getIdleWatcher(args.idleMinutes * 60_000 || 60 * 60_000).tick();
      } catch {}
      const r = await fireHooks(
        "UserPromptSubmit",
        allHooks,
        { USER_PROMPT: line, SESSION_ID: session.id, LISA_HOME },
        cwd,
      );
      if (r.blocked.length > 0) {
        console.error(`[hook blocked] ${r.blocked.join("; ")}`);
        return;
      }
      await turn(line);
    },
    onSlash: async (cmd, args2) => {
      if (cmd === "exit" || cmd === "quit") {
        process.kill(process.pid, "SIGINT");
        return true;
      }
      if (cmd === "help") {
        console.error(HELP);
        return true;
      }
      if (cmd === "skills") {
        const { listSkills, getSkill } = await import("./skills/manager.js");
        if (args2.startsWith("view ")) {
          const skill = await getSkill(args2.slice(5).trim());
          if (!skill) console.error("(not found)");
          else console.error(`# ${skill.frontmatter.name}\n${skill.frontmatter.description}\n\n${skill.body}`);
          return true;
        }
        const skills = await listSkills();
        if (skills.length === 0) console.error("(no skills saved)");
        else for (const s of skills) console.error(`- ${s.frontmatter.name}: ${s.frontmatter.description}`);
        return true;
      }
      if (cmd === "memory") {
        const { readMemory } = await import("./memory/store.js");
        console.error("--- USER.md ---\n" + ((await readMemory("user")) || "(empty)"));
        console.error("--- MEMORY.md ---\n" + ((await readMemory("memory")) || "(empty)"));
        return true;
      }
      if (cmd === "sessions") {
        const sessions = await listSessionsOnDisk();
        for (const s of sessions.slice(0, 20)) {
          console.error(`${s.id}  msgs=${s.messageCount}  ${s.lastUserMessage ?? ""}`);
        }
        return true;
      }
      if (cmd === "search") {
        const { buildIndex, search } = await import("./memory/vector.js");
        const index = await buildIndex();
        const hits = search(index, args2, 5);
        for (const h of hits) console.error(`[${h.startedAt}] ${h.sessionId}\n  ${h.excerpt}`);
        return true;
      }
      if (cmd === "reflect") {
        await finish();
        return true;
      }
      if (cmd === "think") {
        args.thinking = !args.thinking;
        console.error(`[think=${args.thinking}]`);
        return true;
      }
      if (cmd === "clear") {
        history.length = 0;
        console.error("[history cleared from in-memory; on-disk session preserved]");
        return true;
      }
      if (cmd === "save") {
        const { appendMemory } = await import("./memory/store.js");
        await appendMemory("memory", args2);
        console.error("[saved to MEMORY.md]");
        return true;
      }
      // Plugin slash commands
      for (const p of plugins) {
        const match = p.commands.find((c) => c.name === cmd);
        if (match) {
          const expanded = match.body.replace(/\$ARGUMENTS/g, args2);
          await turn(expanded);
          return true;
        }
      }
      return false;
    },
    onClose: async () => {
      await finish();
    },
  });
}

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text_delta":
      if (event.text) process.stdout.write(event.text);
      break;
    case "thinking_delta":
      break;
    case "tool_call_start": {
      const inputPreview = JSON.stringify(event.toolInput).slice(0, 120);
      process.stderr.write(`\n[tool ${event.toolName} ${inputPreview}]\n`);
      break;
    }
    case "tool_call_end":
      if (event.isError) {
        process.stderr.write(`[tool ${event.toolName} ✗ ${event.toolResult}]\n`);
      }
      break;
    case "system_prompt_rebuilt":
      process.stderr.write(`[soul] ${event.message}\n`);
      break;
    case "error":
      process.stderr.write(`\n[error] ${event.message}\n`);
      break;
    default:
      break;
  }
}

/**
 * Make a hot-reload rebuild closure that maintains its own (fingerprint, text)
 * cache. Called once per session; the agent loop calls it once per turn.
 *
 * Cheap path: if the fingerprint hasn't moved, return the cached text without
 * re-running buildSystemPromptSnapshot (which does several I/O calls). Slow
 * path: rebuild + cache.
 */
function makeHotReloadRebuilder(
  initialFingerprint: string,
  initialText: string,
): () => Promise<{ text: string; fingerprint: string }> {
  let cachedFp = initialFingerprint;
  let cachedText = initialText;
  return async () => {
    const fp = await getPromptFingerprint();
    if (fp === cachedFp) {
      return { text: cachedText, fingerprint: fp };
    }
    const next = await buildSystemPromptSnapshot();
    cachedFp = fp;
    cachedText = next.text;
    return { text: next.text, fingerprint: fp };
  };
}

// ── Birth ceremony (CLI rendering) ────────────────────────────────────

const STAR_TOP    = "    ✦  ✦  ✦  ✦  ✦";
const STAR_BAR    = "  ─────────────────────";

async function runBirthCeremony(model: string): Promise<void> {
  process.stderr.write(`\n${STAR_TOP}\n${STAR_BAR}\n     B I R T H   R I T U A L\n${STAR_BAR}\n${STAR_TOP}\n\n`);
  await birth({
    model,
    onStep: async (log) => {
      const pad = log.step.padEnd(15, " ");
      process.stderr.write(`  ${pad}  ${log.detail}\n`);
    },
  });
  const summary = await readSoulSummary();
  if (summary) {
    process.stderr.write(`\n  she chose her name: ${summary.name}\n  her purpose:\n${indent(summary.purpose, "    ")}\n\n`);
  }
}

function printSoulSummary(s: Awaited<ReturnType<typeof readSoulSummary>> & object): void {
  if (!s) return;
  console.log(`name: ${s.name}`);
  console.log(`born: ${s.seed.bornAt}`);
  console.log(`big5: O${(s.seed.bigFive.openness*100|0)} C${(s.seed.bigFive.conscientiousness*100|0)} E${(s.seed.bigFive.extraversion*100|0)} A${(s.seed.bigFive.agreeableness*100|0)} N${(s.seed.bigFive.neuroticism*100|0)}`);
  console.log(`\n── identity ──\n${s.identity}`);
  console.log(`\n── purpose ──\n${s.purpose}`);
  console.log(`\n── constitution ──\n${s.constitution}`);
  if (s.values.length) console.log(`\n── values (${s.values.length}) ──\n${s.values.map(v => `• ${v.title}`).join("\n")}`);
  if (s.opinions.length) console.log(`\n── opinions (${s.opinions.length}) ──\n${s.opinions.map(o => `• ${o.stance} (${o.confidence})`).join("\n")}`);
  if (s.desires.length) console.log(`\n── desires (${s.desires.length}) ──\n${s.desires.map(d => `• ${d.what}${d.actionable ? " *" : ""}`).join("\n")}`);
  console.log(`\n── emotions ──`);
  for (const [k, v] of Object.entries(s.emotions.values)) {
    console.log(`  ${k.padEnd(14)} ${v.toFixed(2)}`);
  }
  if (s.tampered.length) console.log(`\n⚠ tampered files: ${s.tampered.join(", ")}`);
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((l) => prefix + l).join("\n");
}

// ── `lisa skills` subcommand (Phase 3.1) ─────────────────────────────

async function handleSkillsSubcommand(subargs: string[]): Promise<void> {
  const sub = subargs[0];
  const skillsMod = await import("./skills/executable.js");
  if (!sub || sub === "list" || sub === "list-executable") {
    const candidates = await skillsMod.discoverExecutableSkills();
    if (candidates.length === 0) {
      console.log("No executable skills found.\n(An executable skill is a ~/.lisa/skills/<slug>/tool.js that exports `tool: ToolDefinition`.)");
      return;
    }
    console.log("Executable skills:");
    for (const c of candidates) console.log(skillsMod.summarizeCandidate(c));
    console.log("\nNext: `lisa skills approve <slug>` to review + approve.");
    return;
  }
  const slug = subargs[1];
  if (!slug) {
    console.error(`usage: lisa skills <approve|disable|enable|audit> <slug>`);
    process.exit(2);
  }
  if (sub === "approve") {
    await approveExecutableSkillInteractive(slug);
    return;
  }
  if (sub === "disable") {
    const reason = subargs[2];
    await skillsMod.disableExecutableSkill(slug, reason);
    console.log(`Disabled ${slug}.`);
    return;
  }
  if (sub === "enable") {
    await skillsMod.enableExecutableSkill(slug);
    console.log(`Enabled ${slug}.`);
    return;
  }
  if (sub === "audit") {
    const log = await skillsMod.readAudit(slug);
    console.log(log || "(no audit entries)");
    return;
  }
  console.error(`unknown skills subcommand: ${sub}`);
  process.exit(2);
}

async function approveExecutableSkillInteractive(slug: string): Promise<void> {
  const skillsMod = await import("./skills/executable.js");
  const src = await skillsMod.readToolSource(slug);
  if (!src) {
    console.error(`No tool source found for skill "${slug}".`);
    process.exit(1);
  }
  const candidates = await skillsMod.discoverExecutableSkills();
  const c = candidates.find((x) => x.slug === slug);
  if (!c) {
    console.error(`Skill "${slug}" has no tool.js — cannot approve.`);
    process.exit(1);
  }
  console.log(`\n── ${slug} (sha=${c.currentSha.slice(0, 16)}) ──\n`);
  console.log(src);
  console.log(`\n── end of source ──\n`);
  if (c.approved) {
    console.log(`Previously approved at ${c.approved.approvedAt} (sha=${c.approved.sha256.slice(0, 16)}).`);
    if (c.approved.sha256 !== c.currentSha) {
      console.log(`⚠ Source has changed since approval.`);
    }
  }
  // Try to extract the tool.name without importing (regex on the source) so
  // we can show the user what tool name they're approving. Falls back to slug.
  const nameMatch = /name\s*:\s*["']([^"']+)["']/.exec(src);
  const toolName = nameMatch?.[1] ?? slug;
  console.log(`This tool will be registered as: "${toolName}"`);
  console.log(`It runs in-process with no sandbox. Only approve code you've read.\n`);
  const yes = await promptYesNo(`Approve and load on next launch? [y/N] `);
  if (!yes) {
    console.log("Not approved.");
    return;
  }
  const note = await promptLine(`Optional one-line note (enter to skip): `);
  await skillsMod.approveExecutableSkill(slug, { toolName, note: note.trim() || undefined });
  console.log(`\n✓ Approved ${slug}.`);
}

async function promptYesNo(q: string): Promise<boolean> {
  const ans = (await promptLine(q)).trim().toLowerCase();
  return ans === "y" || ans === "yes";
}

function promptLine(q: string): Promise<string> {
  process.stdout.write(q);
  return new Promise<string>((resolve) => {
    let data = "";
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      data += s;
      if (data.includes("\n")) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(data.replace(/\r?\n.*/s, ""));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
