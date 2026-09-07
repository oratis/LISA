/**
 * Terminal rendering of AgentEvents for the CLI (REPL and one-shot prompts).
 *
 * Two streams with two jobs:
 *   - stdout carries Lisa's words and nothing else, so `lisa "…" | pbcopy`
 *     and `> answer.md` get exactly the answer.
 *   - stderr carries everything about *how* the answer is being produced: the
 *     `Lisa> ` label, a spinner while waiting for the model, a `thinking…`
 *     marker, one compact line per tool call, `[soul updated]`, errors.
 *
 * On a terminal, transient state (spinner, thinking marker, a tool call in
 * flight) occupies the current line and is redrawn in place with `\r\x1b[K`;
 * when stderr is not a TTY every state change is a plain line instead. The
 * in-place rewrite only ever touches the line the cursor is on, so if a tool
 * or hook writes to the terminal in between, the worst case is an orphaned
 * "⚙ running" line — never corrupted output.
 *
 * Thinking content is never printed: only the fact that it is happening.
 */
import type { AgentEvent } from "../types.js";
import { makePalette, type Palette } from "./ansi.js";

export interface Writer {
  write(chunk: string): unknown;
}

export interface RendererOptions {
  stdout: Writer;
  stderr: Writer;
  /** Colour the stderr decorations. Lisa's text on stdout is never coloured. */
  color?: boolean;
  /** Print full tool results and hot-reload details. */
  verbose?: boolean;
  /** stderr is an interactive terminal: spinner + in-place line updates. */
  tty?: boolean;
  /** Terminal width; the in-flight tool line is truncated to it so the rewrite never wraps. */
  columns?: number;
  now?: () => number;
  /** Injectable for tests so no real interval is ever left running. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

export interface EventRenderer {
  onEvent(event: AgentEvent): void;
  /** Right before a prompt is sent: separator line + spinner until the model responds. */
  beginTurn(): void;
  /** After the agent returns or throws: stop the spinner, finish the output line, reset. */
  endTurn(): void;
}

const LABEL = "Lisa> ";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
const CLEAR_LINE = "\r\x1b[K";
const RESULT_MAX_LINES = 20;

export function createEventRenderer(opts: RendererOptions): EventRenderer {
  const { stdout, stderr } = opts;
  const p: Palette = makePalette(opts.color === true);
  const verbose = opts.verbose === true;
  const tty = opts.tty === true;
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? {
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      // Never let the animation keep the process alive after the work is done.
      h.unref();
      return h;
    },
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  };
  const columns = Math.max(20, opts.columns ?? 100);

  // `Lisa> ` is emitted lazily, right before the first text of the turn, so
  // tool lines that precede any words stand on their own and the label sits
  // next to what it labels.
  let labelPending = false;
  // Two different "unfinished line" questions, and they are not the same one:
  //   stdoutMidLine — the *terminal cursor* sits mid-line because of Lisa's
  //     text, so a stderr decoration must break the line first.
  //   stdoutOpen    — the *stdout stream* is not newline-terminated. Only a
  //     newline written to stdout clears it, because `lisa … > answer.md` must
  //     end with one and must NOT contain the line breaks we emit for the
  //     terminal's benefit.
  let stdoutMidLine = false;
  let stdoutOpen = false;
  let thinkingShown = false;
  // What currently occupies the stderr line on a TTY. Only one thing can.
  let status: "none" | "spinner" | "tool" = "none";
  let spinnerLabel = "";
  let spinnerHandle: unknown = null;
  let frame = 0;
  const toolStarts: { name: string; at: number }[] = [];

  function drawSpinner(): void {
    const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
    frame++;
    stderr.write(CLEAR_LINE + p.dim(spinnerLabel ? `${glyph} ${spinnerLabel}` : glyph));
  }

  /** Start (or relabel) the wait indicator. TTY only; a pipe gets nothing. */
  function showSpinner(label: string): void {
    if (!tty) return;
    if (status === "tool") return; // a tool line is in flight; it owns the line
    breakStdoutLine();
    spinnerLabel = label;
    if (status === "spinner") {
      drawSpinner();
      return;
    }
    status = "spinner";
    frame = 0;
    drawSpinner();
    spinnerHandle = timers.setInterval(drawSpinner, SPINNER_MS);
  }

  /** Remove whatever transient thing is on the stderr line. */
  function clearStatus(): void {
    if (status === "spinner") {
      timers.clearInterval(spinnerHandle);
      spinnerHandle = null;
      stderr.write(CLEAR_LINE);
    } else if (status === "tool") {
      // A tool line is being abandoned (error mid-call, turn aborted): keep it
      // as a finished line rather than overwriting it.
      stderr.write("\n");
    }
    status = "none";
  }

  /** If Lisa's text stopped mid-line, move stderr decorations to a fresh line. */
  function breakStdoutLine(): void {
    if (stdoutMidLine) {
      stderr.write("\n");
      stdoutMidLine = false;
    }
  }

  function writeLine(line: string): void {
    clearStatus();
    breakStdoutLine();
    stderr.write(line + "\n");
  }

  function onText(text: string): void {
    if (!text) return;
    clearStatus();
    if (labelPending) {
      stderr.write(LABEL);
      labelPending = false;
    }
    stdout.write(text);
    stdoutMidLine = !text.endsWith("\n");
    stdoutOpen = stdoutMidLine;
  }

  function onToolStart(name: string, input: unknown): void {
    clearStatus();
    breakStdoutLine();
    toolStarts.push({ name, at: now() });
    const head = `${p.yellow("⚙")} ${p.bold(name)}`;
    const summary = summarizeToolInput(input);
    if (tty) {
      // Budget: "⚙ " + name + "  " + summary must fit on one row, or the
      // \r\x1b[K rewrite on tool_call_end would only clear the last row.
      const room = columns - 1 - (2 + name.length + 2);
      const fitted = room > 3 && summary.length > room ? summary.slice(0, room - 1) + "…" : summary;
      stderr.write(CLEAR_LINE + head + (fitted ? `  ${p.dim(fitted)}` : ""));
      status = "tool";
    } else {
      stderr.write(head + (summary ? `  ${summary}` : "") + "\n");
    }
  }

  function onToolEnd(name: string, result: unknown, isError: boolean): void {
    let started: number | undefined;
    for (let i = toolStarts.length - 1; i >= 0; i--) {
      if (toolStarts[i]!.name === name) {
        started = toolStarts.splice(i, 1)[0]!.at;
        break;
      }
    }
    const took = p.dim(`(${formatDuration(started === undefined ? 0 : now() - started)})`);
    const text = resultText(result);
    const line = isError
      ? `${p.red("✗")} ${name} ${took}${text ? `: ${firstLine(text)}` : ""}`
      : `${p.green("✓")} ${name} ${took}`;
    if (tty && status === "tool") {
      stderr.write(CLEAR_LINE + line + "\n");
      status = "none";
    } else {
      writeLine(line);
    }
    if (verbose && text) {
      const lines = text.split("\n");
      const shown = lines.slice(0, RESULT_MAX_LINES);
      for (const l of shown) stderr.write(`    ${p.dim(l)}\n`);
      if (lines.length > shown.length) {
        stderr.write(`    ${p.dim(`… ${lines.length - shown.length} more line(s)`)}\n`);
      }
    }
  }

  function onThinking(): void {
    if (thinkingShown) return;
    thinkingShown = true;
    if (tty) showSpinner("thinking…");
    else writeLine(p.dim("thinking…"));
  }

  return {
    beginTurn(): void {
      // Blank separator after the user's line; the label itself waits for text.
      stderr.write("\n");
      labelPending = true;
      stdoutMidLine = false;
      stdoutOpen = false;
      thinkingShown = false;
      toolStarts.length = 0;
      showSpinner("");
    },

    endTurn(): void {
      clearStatus();
      if (stdoutOpen) {
        // Finish the line on stdout so piped output is newline-terminated and
        // the next prompt starts at column 0.
        stdout.write("\n");
        stdoutOpen = false;
        stdoutMidLine = false;
      }
      labelPending = false;
      thinkingShown = false;
      toolStarts.length = 0;
    },

    onEvent(event: AgentEvent): void {
      switch (event.type) {
        case "turn_start":
          // Each provider call is a fresh wait — and a fresh chance to think.
          thinkingShown = false;
          showSpinner("");
          break;
        case "text_delta":
          onText(event.text ?? "");
          break;
        case "thinking_delta":
          onThinking();
          break;
        case "tool_call_start":
          onToolStart(event.toolName ?? "tool", event.toolInput);
          break;
        case "tool_call_end":
          onToolEnd(event.toolName ?? "tool", event.toolResult, event.isError === true);
          break;
        case "turn_end":
          clearStatus();
          break;
        case "system_prompt_rebuilt":
          writeLine(p.dim(verbose && event.message ? `[soul updated] ${event.message}` : "[soul updated]"));
          break;
        case "error":
          writeLine(p.red(`[error] ${event.message ?? "unknown error"}`));
          break;
        case "info":
          // Rare and load-bearing ("stopped after N iterations", "budget
          // reached"): they explain why Lisa went quiet, so always shown.
          if (event.message) writeLine(p.dim(event.message));
          break;
        default:
          break;
      }
    },
  };
}

/** `1.2s`, `0.3s`, `1m 05s` — the shape a person scans, not a millisecond count. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m ${String(rest).padStart(2, "0")}s`;
}

/** Keys that, when present, say what a tool call is *about* better than the whole JSON. */
const PREFERRED_KEYS = [
  "command",
  "cmd",
  "path",
  "file_path",
  "filePath",
  "file",
  "url",
  "query",
  "pattern",
  "prompt",
  "name",
  "slug",
  "text",
  "content",
  "message",
  "title",
];

/**
 * One short line describing a tool input: the shell command for bash, the
 * path for file tools, the URL for fetches — falling back to compact JSON.
 * Newlines and runs of whitespace collapse so the line stays a line.
 */
export function summarizeToolInput(input: unknown, max = 80): string {
  let s: string;
  if (input == null) s = "";
  else if (typeof input === "string") s = input;
  else if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const action = typeof obj.action === "string" ? obj.action : "";
    const key = PREFERRED_KEYS.find((k) => typeof obj[k] === "string" && (obj[k]).length > 0);
    if (key) s = action ? `${action} ${obj[key] as string}` : (obj[key] as string);
    else if (action) s = action;
    else s = safeJson(input);
  } else s = String(input);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function safeJson(v: unknown): string {
  try {
    const j = JSON.stringify(v);
    return j === "{}" ? "" : j;
  } catch {
    return String(v);
  }
}

function resultText(result: unknown): string {
  if (result == null) return "";
  return typeof result === "string" ? result : safeJson(result);
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const t = line.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
