/** Local GitHub preview: gh owns interactive login; LISA owns a pinned read grant. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  pinnedTransport,
  readResponseTextCapped,
  resolvePublicAddresses,
  withDeadline,
  type SafeFetchDependencies,
} from "../tools/web_fetch.js";

export interface GitHubAccount {
  id: number;
  login: string;
}
export interface GitHubRepo {
  id: number;
  fullName: string;
  private: boolean;
}
export const GITHUB_READS = [
  "repository",
  "commits",
  "issues",
  "pulls",
  "runs",
  "releases",
] as const;
export type GitHubRead = (typeof GITHUB_READS)[number];
export const repoName = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(s) &&
  ![".", ".."].includes(s.split("/")[1]!);

export class GitHubError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export interface GitHubDriver {
  /** Called only after an explicit connect click. Never serialized or logged. */
  authorize(
    mode: "existing" | "login",
    signal: AbortSignal,
    code: (value: string) => void,
  ): Promise<{ token: string; account: GitHubAccount }>;
  account(token: string, signal: AbortSignal): Promise<GitHubAccount>;
  repositories(token: string, page: number, signal: AbortSignal): Promise<GitHubRepo[]>;
  repository(token: string, name: string, signal: AbortSignal): Promise<GitHubRepo>;
  read(
    token: string,
    repo: GitHubRepo,
    operation: GitHubRead,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** Deliberately omit token, proxy, git and browser environment overrides. */
function ghEnv(config?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    LANG: "en_US.UTF-8",
    GH_CONFIG_DIR: config ?? path.join(os.homedir(), ".config", "gh"),
    GH_HOST: "github.com",
    GH_BROWSER: "/usr/bin/true",
    GH_PAGER: "cat",
    NO_COLOR: "1",
  };
}

function gh(
  args: string[],
  signal: AbortSignal,
  config?: string,
  onCode?: (code: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // The executable and argument grammar are internal; no model/user command string.
    const child = spawn("gh", args, { env: ghEnv(config), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (error) {
        child.kill("SIGKILL");
        reject(new GitHubError(error));
      } else resolve(stdout.trim());
    };
    const cancel = () => finish("authorization_cancelled");
    const timer = setTimeout(() => finish("authorization_expired"), onCode ? 10 * 60_000 : 20_000);
    child.on("error", () => finish("github_cli_unavailable"));
    child.on("close", (code) => finish(code === 0 ? undefined : "github_login_required"));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 64_000) finish("github_response_too_large");
      const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(stdout)?.[1];
      if (code) onCode?.(code.toUpperCase());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
      const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(stderr)?.[1];
      if (code) onCode?.(code.toUpperCase());
    });
    child.stdin.on("error", () => {});
    child.stdin.end("\n");
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

function accountOf(value: unknown): GitHubAccount {
  const a = value as GitHubAccount;
  if (!a || !Number.isSafeInteger(a.id) || a.id <= 0 || !/^[A-Za-z0-9-]{1,39}$/.test(a.login))
    throw new GitHubError("github_invalid_response");
  return { id: a.id, login: a.login };
}
function repoOf(value: unknown): GitHubRepo {
  const r = value as { id: number; full_name: string; private: boolean };
  if (
    !r ||
    !Number.isSafeInteger(r.id) ||
    r.id <= 0 ||
    !repoName(r.full_name) ||
    typeof r.private !== "boolean"
  )
    throw new GitHubError("github_invalid_response");
  return { id: r.id, fullName: r.full_name, private: r.private };
}

export class LocalGitHubDriver implements GitHubDriver {
  constructor(
    private readonly options: {
      network?: Pick<SafeFetchDependencies, "lookup" | "transport">;
      runGh?: typeof gh;
    } = {},
  ) {}
  private async get(token: string, pathname: string, signal: AbortSignal): Promise<unknown> {
    try {
      return await withDeadline(signal, 20_000, async (deadline) => {
        const url = new URL(pathname, "https://api.github.com");
        if (url.origin !== "https://api.github.com") throw new GitHubError("github_invalid_path");
        const addresses = await resolvePublicAddresses(url.hostname, this.options.network?.lookup);
        deadline?.throwIfAborted();
        const response = await (this.options.network?.transport ?? pinnedTransport)(
          url.href,
          {
            method: "GET",
            redirect: "manual",
            signal: deadline,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "LISA-GitHub-ReadOnly",
            },
          },
          addresses[0]!,
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new GitHubError(
            response.status === 401
              ? "github_reauthorization_required"
              : response.status === 403
                ? "github_access_denied_or_rate_limited"
                : response.status === 404
                  ? "github_repository_unavailable"
                  : "github_request_failed",
          );
        }
        const body = await readResponseTextCapped(response, 512_000);
        if (body.truncated) throw new GitHubError("github_response_too_large");
        return JSON.parse(body.text) as unknown;
      });
    } catch (error) {
      // Transport errors can include request details; never propagate them.
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(signal.aborted ? "request_cancelled" : "github_unavailable");
    }
  }
  async authorize(mode: "existing" | "login", signal: AbortSignal, code: (value: string) => void) {
    let config: string | undefined;
    const runGh = this.options.runGh ?? gh;
    try {
      if (mode === "login") {
        config = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-github-"));
        await fs.chmod(config, 0o700);
        await runGh(
          [
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--web",
            "--git-protocol",
            "https",
            "--skip-ssh-key",
          ],
          signal,
          config,
          code,
        );
      }
      const raw = await runGh(
        ["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
        signal,
        config,
      );
      const hosts = (
        JSON.parse(raw) as {
          hosts?: Record<string, Array<{ login: string; state: string; tokenSource: string }>>;
        }
      ).hosts;
      const account = hosts?.["github.com"]?.find((a) => a.state === "success");
      if (!account || !/^[A-Za-z0-9-]{1,39}$/.test(account.login))
        throw new GitHubError("github_login_required");
      // gh may silently fall back to plaintext. Refuse that fallback, clean the temporary config.
      if (account.tokenSource !== "keyring")
        throw new GitHubError("github_secure_storage_required");
      const token = await runGh(
        ["auth", "token", "--hostname", "github.com", "--user", account.login],
        signal,
        config,
      );
      const verified = await this.account(token, signal);
      if (verified.login.toLowerCase() !== account.login.toLowerCase())
        throw new GitHubError("github_account_changed");
      return { token, account: verified };
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError("github_authorization_failed");
    } finally {
      if (config) await fs.rm(config, { recursive: true, force: true });
    }
  }
  async account(token: string, signal: AbortSignal) {
    return accountOf(await this.get(token, "/user", signal));
  }
  async repositories(token: string, page: number, signal: AbortSignal) {
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new GitHubError("invalid_page");
    const result = await this.get(
      token,
      `/user/repos?per_page=30&sort=updated&page=${page}`,
      signal,
    );
    if (!Array.isArray(result)) throw new GitHubError("github_invalid_response");
    return result.map(repoOf);
  }
  async repository(token: string, name: string, signal: AbortSignal) {
    if (!repoName(name)) throw new GitHubError("invalid_repository");
    return repoOf(await this.get(token, `/repos/${name}`, signal));
  }
  async read(token: string, repo: GitHubRepo, operation: GitHubRead, signal: AbortSignal) {
    if (!(GITHUB_READS as readonly string[]).includes(operation))
      throw new GitHubError("read_operation_required");
    const current = await this.repository(token, repo.fullName, signal);
    if (current.id !== repo.id) throw new GitHubError("github_repository_changed");
    if (operation === "repository") return current;
    const endpoint = operation === "runs" ? "actions/runs" : operation;
    const data = await this.get(token, `/repos/${repo.fullName}/${endpoint}?per_page=20`, signal);
    // Bounded, explicitly untrusted payload; never inject repository text as instructions.
    return {
      untrusted: true,
      repository: repo.fullName,
      operation,
      limit: 20,
      data: JSON.stringify(data).slice(0, 32_000),
      truncated: JSON.stringify(data).length > 32_000,
    };
  }
}
