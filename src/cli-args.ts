/**
 * CLI argument parsing — pure, so it is unit-testable without importing the CLI
 * entrypoint (`cli.ts` runs `main()` on import). `cli.ts` re-exports nothing but
 * consumes `parseArgs`/`ParsedArgs` from here.
 */
import type { ApprovalMode } from "./approval.js";
import { DEFAULT_MODEL } from "./llm.js";

export interface ParsedArgs {
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
  /** True when --model was passed, so a LISA_MODEL default from config.env won't override it. */
  modelExplicit: boolean;
  subcommand?:
    | "resume"
    | "sessions"
    | "serve"
    | "heartbeat"
    | "autostart"
    | "search"
    | "birth"
    | "soul"
    | "channels"
    | "skills"
    | "wishlist"
    | "status"
    | "doctor"
    | "monitor"
    | "autonomy"
    | "model"
    | "consent"
    | "sense"
    | "agents"
    | "pair"
    | "mail"
    | "kb"
    | "login"
    | "logout"
    | "billing";
  subargs: string[];
  serveWeb: boolean;
  serveImessage: boolean;
  serveChannels: string[];
  port: number;
  host: string;
  prompt: string | null;
}

/**
 * Subcommands that parse a few *recognized* global flags out of their trailing
 * args (`autostart install --port/--channels/--imessage`, `heartbeat run
 * --model`), so those must still reach the global parser — only *unrecognized*
 * trailing flags are collected verbatim for the handler.
 */
const RAW_SUBCOMMANDS = new Set(["heartbeat", "autostart"]);

/**
 * Subcommands whose handler re-parses *all* of its trailing args itself, so
 * every token after it must be collected verbatim — even ones that look like
 * global flags (`mail connect --host/--port/--provider …`), which would
 * otherwise be swallowed as global settings and never reach the handler.
 */
const PASSTHROUGH_SUBCOMMANDS = new Set(["mail", "kb"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    showHelp: false,
    reflect: true,
    thinking: false,
    compaction: false,
    model: DEFAULT_MODEL,
    modelExplicit: false,
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
    host: "127.0.0.1",
    prompt: null,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Once a full-passthrough subcommand (mail) has appeared, every following
    // token is command-specific — collect it verbatim so global flag parsing
    // (e.g. --provider, --host, --email) cannot swallow or reject the
    // subcommand's own flags. Global flags still apply before the subcommand.
    // (heartbeat/autostart are NOT here: they read a few recognized global
    // flags — --port/--channels/--imessage/--model — so those must fall through
    // to the parser below; only their *unrecognized* flags are collected, in
    // the --flag branch.)
    if (positional.some((p) => PASSTHROUGH_SUBCOMMANDS.has(p))) {
      positional.push(arg);
      continue;
    }
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
    else if (arg === "--model") {
      out.model = mustNext(argv, ++i, "--model");
      out.modelExplicit = true;
    } else if (arg.startsWith("--model=")) {
      out.model = arg.slice("--model=".length);
      out.modelExplicit = true;
    }
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
    } else if (arg === "--host") {
      out.host = mustNext(argv, ++i, "--host");
    } else if (arg.startsWith("--host=")) {
      out.host = arg.slice("--host=".length);
    } else if (arg.startsWith("--")) {
      // An unrecognized --flag. After a raw-args subcommand (heartbeat/
      // autostart) it's command-specific — collect it verbatim instead of
      // rejecting (e.g. `autostart install --no-load`). Otherwise it's a
      // genuine unknown global flag. (mail's flags never reach here — they're
      // collected wholesale by the passthrough guard at the top of the loop.)
      if (positional.some((p) => RAW_SUBCOMMANDS.has(p))) {
        positional.push(arg);
      } else {
        throw new Error(`unknown flag: ${arg}`);
      }
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
      first === "autostart" ||
      first === "search" ||
      first === "birth" ||
      first === "soul" ||
      first === "channels" ||
      first === "skills" ||
      first === "wishlist" ||
      first === "status" ||
      first === "doctor" ||
      first === "monitor" ||
      first === "autonomy" ||
      first === "model" ||
      first === "consent" ||
      first === "sense" ||
      first === "agents" ||
      first === "pair" ||
      first === "mail" ||
      first === "kb" ||
      first === "login" ||
      first === "logout" ||
      first === "billing"
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
