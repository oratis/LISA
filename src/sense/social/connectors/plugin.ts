import fs from "node:fs/promises";
import path from "node:path";
import { lisaGlobalHome } from "../../../paths.js";
import type { SocialConnectorManifest } from "../types.js";
import type { OpenConnectorPlatform } from "./server.js";

function pluginName(platform: OpenConnectorPlatform): string {
  return `lisa-social-${platform}`;
}

export function bundledConnectorManifest(
  platform: OpenConnectorPlatform,
): SocialConnectorManifest {
  return {
    schemaVersion: 1,
    id: `${platform}-official`,
    displayName: platform === "bluesky" ? "Bluesky" : "Mastodon",
    platform,
    mcpServer: platform,
    skill: `${platform}-publisher`,
    tools: {
      listAccounts: "social_accounts_list",
      getCapabilities: "social_capabilities",
      validateDraft: "social_draft_validate",
      publish: "social_publish",
      disconnectAccount: "social_account_disconnect",
    },
  };
}

function skillText(platform: OpenConnectorPlatform): string {
  const label = platform === "bluesky" ? "Bluesky" : "Mastodon";
  return `---
name: ${platform}-publisher
description: Compose and validate ${label} posts through LISA's host-enforced social workflow.
---

# ${label} publisher

Use this skill when the user asks to prepare content for ${label}.

1. Call \`mcp__${platform}__social_accounts_list\` and use only an account the user linked.
2. Call \`mcp__${platform}__social_capabilities\` before promising format, media, visibility, or scheduling support.
3. Create or revise the canonical post with \`social_compose\`; keep platform-specific fields in the target or variant.
4. Call \`mcp__${platform}__social_draft_validate\` and explain every error or warning.
5. Call \`social_compose\` with \`request_confirmation\`, then show the exact preview.
6. Stop. The user approves in the trusted Sense interface; the host runner publishes.

Never call a publish operation, use curl/bash to bypass the host, request a token in chat, or treat phrases such as “post it” as permission to skip the immutable confirmation snapshot.
`;
}

export async function installBundledOpenConnector(
  platform: OpenConnectorPlatform,
  force = false,
  pluginsRoot: string = path.join(lisaGlobalHome(), "plugins"),
): Promise<string> {
  const root = path.join(pluginsRoot, pluginName(platform));
  try {
    await fs.access(root);
    if (!force) {
      throw new Error(
        `${pluginName(platform)} already exists; pass --force to replace the bundled files`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.join(root, ".lisa-plugin"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, "skills", `${platform}-publisher`), {
    recursive: true,
    mode: 0o700,
  });
  const files: Array<[string, string]> = [
    [
      path.join(root, ".lisa-plugin", "plugin.json"),
      JSON.stringify({
        name: pluginName(platform),
        version: "1.0.0",
        description: `First-party ${platform} social connector`,
        author: "LISA",
      }, null, 2),
    ],
    [
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          [platform]: {
            command: "lisa",
            args: ["sense", "social", "serve-connector", platform],
          },
        },
      }, null, 2),
    ],
    [
      path.join(root, "social-connector.json"),
      JSON.stringify(bundledConnectorManifest(platform), null, 2),
    ],
    [
      path.join(root, "skills", `${platform}-publisher`, "SKILL.md"),
      skillText(platform),
    ],
  ];
  await Promise.all(
    files.map(([file, content]) =>
      fs.writeFile(file, `${content.trim()}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }),
    ),
  );
  return root;
}
