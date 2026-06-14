/**
 * Local-model lifecycle (PLAN_MODEL_v1.0 M1).
 *
 * Before this, "local models" meant: the user installs Ollama themselves, runs
 * `ollama serve`, and hand-edits LISA_BASE_URL in config.env. This module makes
 * it a first-class option — install / list / health / switch — while still
 * routing through the existing OpenAI-compatible provider (Ollama et al. speak
 * the OpenAI API), so no provider code changes.
 *
 * The runtime (process exec + HTTP) is injectable so the logic is unit-testable
 * without a real Ollama install.
 */
import { spawn } from "node:child_process";

export interface LocalModelInfo {
  name: string;
  sizeBytes?: number;
}

export interface LocalRuntime {
  /** Run a command; stream stdout/stderr lines to onLine. Never rejects. */
  exec(
    cmd: string,
    args: string[],
    onLine?: (line: string) => void,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** GET a URL. Never rejects — a network error resolves to { ok:false }. */
  httpGet(url: string): Promise<{ ok: boolean; status: number; body: string }>;
}

export const defaultRuntime: LocalRuntime = {
  exec(cmd, args, onLine) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let child;
      try {
        child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        resolve({ code: 127, stdout: "", stderr: (err as Error).message });
        return;
      }
      const pump = (chunk: Buffer, sink: "out" | "err") => {
        const s = chunk.toString();
        if (sink === "out") stdout += s;
        else stderr += s;
        if (onLine) for (const line of s.split("\n")) if (line.trim()) onLine(line.trim());
      };
      child.stdout?.on("data", (c) => pump(c, "out"));
      child.stderr?.on("data", (c) => pump(c, "err")); // ollama writes pull progress to stderr
      child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }));
      child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  },
  async httpGet(url) {
    try {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch {
      return { ok: false, status: 0, body: "" };
    }
  },
};

/** Default OpenAI-compatible endpoints per local backend. Pure. */
export function localEndpoint(backend: string): { host: string; baseURL: string; apiKey: string } {
  const hosts: Record<string, string> = {
    ollama: "http://localhost:11434",
    lmstudio: "http://localhost:1234",
    llamacpp: "http://localhost:8080",
  };
  const envHost = backend === "ollama" ? process.env.OLLAMA_HOST : undefined;
  const host = (envHost || hosts[backend] || hosts.ollama!).replace(/\/$/, "");
  return { host, baseURL: `${host}/v1`, apiKey: backend };
}

/** Parse a `local://[backend/]model` reference. Pure. */
export function parseLocalRef(ref: string): { backend: string; model: string } | null {
  const m = ref.match(/^local:\/\/(.+)$/);
  if (!m) return null;
  const rest = m[1]!.trim();
  if (!rest) return null;
  const known = new Set(["ollama", "lmstudio", "llamacpp"]);
  const slash = rest.indexOf("/");
  if (slash > 0 && known.has(rest.slice(0, slash))) {
    return { backend: rest.slice(0, slash), model: rest.slice(slash + 1) };
  }
  return { backend: "ollama", model: rest };
}

/** Parse Ollama's /api/tags JSON into model infos. Pure. */
export function parseOllamaTags(body: string): LocalModelInfo[] {
  try {
    const json = JSON.parse(body) as { models?: Array<{ name?: string; size?: number }> };
    return (json.models ?? [])
      .filter((m): m is { name: string; size?: number } => typeof m.name === "string")
      .map((m) => ({ name: m.name, sizeBytes: typeof m.size === "number" ? m.size : undefined }));
  } catch {
    return [];
  }
}

/** The Ollama backend: install / list / health via its CLI + HTTP API. */
export class OllamaBackend {
  readonly name = "ollama";
  readonly host: string;
  constructor(
    private runtime: LocalRuntime = defaultRuntime,
    host: string = localEndpoint("ollama").host,
  ) {
    this.host = host.replace(/\/$/, "");
  }

  async health(): Promise<"up" | "down"> {
    const res = await this.runtime.httpGet(`${this.host}/api/tags`);
    return res.ok ? "up" : "down";
  }

  async listInstalled(): Promise<LocalModelInfo[]> {
    const res = await this.runtime.httpGet(`${this.host}/api/tags`);
    return res.ok ? parseOllamaTags(res.body) : [];
  }

  async install(model: string, onLine?: (line: string) => void): Promise<void> {
    const { code, stderr } = await this.runtime.exec("ollama", ["pull", model], onLine);
    if (code === 0) return;
    throw new Error(
      code === 127
        ? "ollama CLI not found — install it from https://ollama.com, then retry"
        : `\`ollama pull ${model}\` failed: ${stderr.trim().slice(-200) || `exit ${code}`}`,
    );
  }
}
