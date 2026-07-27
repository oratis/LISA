import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  deleteOpenSocialAccount,
  listOpenSocialAccounts,
  publicAccount,
  type OpenSocialAccount,
} from "./accounts.js";
import {
  blueskyCapabilities,
  publishBluesky,
  validateBlueskyDraft,
} from "./bluesky.js";
import {
  mastodonCapabilities,
  publishMastodon,
  validateMastodonDraft,
} from "./mastodon.js";
import type { ConnectorPublishInput } from "./types.js";

export type OpenConnectorPlatform = "bluesky" | "mastodon";

const OBJECT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
};

function tools(): Tool[] {
  return [
    {
      name: "social_accounts_list",
      description: "List linked accounts for this social platform. Never returns credentials.",
      inputSchema: { ...OBJECT_SCHEMA, properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "social_capabilities",
      description: "Return current composition and publishing capabilities.",
      inputSchema: { ...OBJECT_SCHEMA, properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "social_draft_validate",
      description: "Validate canonical content and a platform variant without publishing.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: {
          content: { type: "object" },
          variant: { type: "object" },
        },
        required: ["content"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "social_publish",
      description: "Publish a host-approved immutable snapshot. Host runner only.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: {
          accountId: { type: "string" },
          target: { type: "object" },
          content: { type: "object" },
          variant: { type: "object" },
          idempotencyKey: { type: "string" },
          createdAt: { type: "string" },
        },
        required: [
          "accountId",
          "target",
          "content",
          "idempotencyKey",
          "createdAt",
        ],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "social_account_disconnect",
      description: "Delete one locally linked account credential.",
      inputSchema: {
        ...OBJECT_SCHEMA,
        properties: { accountId: { type: "string" } },
        required: ["accountId"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

function json(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

export async function runOpenSocialConnectorServer(
  platform: OpenConnectorPlatform,
): Promise<void> {
  const server = new Server(
    { name: `lisa-social-${platform}`, version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Credential and API boundary for LISA social publishing. " +
        "The social_publish tool must only be called by LISA's deterministic approved-draft runner.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = asObject(request.params.arguments ?? {});
      switch (request.params.name) {
        case "social_accounts_list":
          return json(
            (await listOpenSocialAccounts(platform)).map((account) =>
              publicAccount(account),
            ),
          );
        case "social_capabilities":
          return json(
            platform === "bluesky"
              ? blueskyCapabilities()
              : mastodonCapabilities(),
          );
        case "social_draft_validate": {
          const content = args.content as ConnectorPublishInput["content"];
          const variant = args.variant as ConnectorPublishInput["variant"];
          return json(
            platform === "bluesky"
              ? validateBlueskyDraft(content, variant)
              : validateMastodonDraft(content, variant),
          );
        }
        case "social_publish": {
          const input = args as unknown as ConnectorPublishInput;
          return json(
            platform === "bluesky"
              ? await publishBluesky(input)
              : await publishMastodon(input),
          );
        }
        case "social_account_disconnect": {
          if (typeof args.accountId !== "string") throw new Error("accountId is required");
          return json({
            removed: await deleteOpenSocialAccount(
              platform,
              args.accountId,
            ),
          });
        }
        default:
          return json({ ok: false, error: "unknown_tool" }, true);
      }
    } catch (err) {
      return json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        true,
      );
    }
  });
  await server.connect(new StdioServerTransport());
  // `connect()` starts the transport and then resolves. Keep this CLI
  // subcommand alive until its MCP client closes stdin; otherwise cli.ts's
  // process.exit would terminate before the initialization handshake.
  if (!process.stdin.readableEnded) {
    await new Promise<void>((resolve) => {
      process.stdin.once("end", resolve);
      process.stdin.once("close", resolve);
    });
  }
}
