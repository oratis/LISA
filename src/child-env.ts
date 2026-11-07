/**
 * Environment for processes LISA starts on behalf of the agent or the user:
 * shell commands, repo tools, dispatched/PTY coding agents, MCP stdio servers,
 * plugin hooks and redeploy builds.
 *
 * Connector OAuth client secrets (LISA_GOOGLE_CLIENT_SECRET,
 * LISA_NOTION_CLIENT_SECRET, …) are read by LISA itself from its own
 * environment. A child never needs them, and anything a child prints can reach
 * the model: one `env` command would otherwise hand a confidential client
 * secret (Notion's has no PKCE behind it) to whatever read that output.
 */
const CLIENT_SECRET_ENV = /^LISA_[A-Z0-9_]*CLIENT_SECRET$/i;

export function isClientSecretEnv(name: string): boolean {
  return CLIENT_SECRET_ENV.test(name);
}

/** A copy of `base` without connector client secrets. `base` is never modified. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base))
    if (value !== undefined && !isClientSecretEnv(name)) env[name] = value;
  return env;
}
