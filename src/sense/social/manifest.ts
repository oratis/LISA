import fs from "node:fs/promises";
import path from "node:path";
import { lisaGlobalHome } from "../../paths.js";
import {
  SOCIAL_CONNECTOR_SCHEMA_VERSION,
  type DiscoveredSocialConnector,
  type SocialConnectorManifest,
} from "./types.js";

const MANIFEST_FILE = "social-connector.json";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const SAFE_TOOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requiredString(
  obj: Record<string, unknown>,
  key: string,
  pattern?: RegExp,
): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`social connector manifest: "${key}" must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (pattern && !pattern.test(trimmed)) {
    throw new Error(`social connector manifest: "${key}" contains unsupported characters`);
  }
  return trimmed;
}

function optionalTool(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  if (obj[key] == null) return undefined;
  return requiredString(obj, key, SAFE_TOOL);
}

/** Strict parser: malformed connector metadata is never partially trusted. */
export function parseSocialConnectorManifest(
  input: unknown,
): SocialConnectorManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("social connector manifest must be an object");
  }
  const obj = input as Record<string, unknown>;
  if (obj.schemaVersion !== SOCIAL_CONNECTOR_SCHEMA_VERSION) {
    throw new Error(
      `social connector manifest: unsupported schemaVersion ${String(obj.schemaVersion)}`,
    );
  }
  if (!obj.tools || typeof obj.tools !== "object" || Array.isArray(obj.tools)) {
    throw new Error('social connector manifest: "tools" must be an object');
  }
  const rawTools = obj.tools as Record<string, unknown>;
  const tools: SocialConnectorManifest["tools"] = {
    listAccounts: requiredString(rawTools, "listAccounts", SAFE_TOOL),
    getCapabilities: requiredString(rawTools, "getCapabilities", SAFE_TOOL),
    validateDraft: requiredString(rawTools, "validateDraft", SAFE_TOOL),
    publish: requiredString(rawTools, "publish", SAFE_TOOL),
    getPublishStatus: optionalTool(rawTools, "getPublishStatus"),
    disconnectAccount: optionalTool(rawTools, "disconnectAccount"),
  };
  const names = Object.values(tools).filter(
    (value): value is string => typeof value === "string",
  );
  if (new Set(names).size !== names.length) {
    throw new Error("social connector manifest: tool names must be unique");
  }
  return {
    schemaVersion: SOCIAL_CONNECTOR_SCHEMA_VERSION,
    id: requiredString(obj, "id", SAFE_ID),
    displayName: requiredString(obj, "displayName"),
    platform: requiredString(obj, "platform", SAFE_ID),
    mcpServer: requiredString(obj, "mcpServer", SAFE_ID),
    skill: requiredString(obj, "skill", SAFE_ID),
    tools,
  };
}

/** Resolve a manifest's server-local tool name to LISA's MCP tool namespace. */
export function socialMcpToolName(
  manifest: SocialConnectorManifest,
  operation: keyof SocialConnectorManifest["tools"],
): string | undefined {
  const localName = manifest.tools[operation];
  return localName
    ? `mcp__${manifest.mcpServer}__${localName}`
    : undefined;
}

/** Operations reserved for the trusted host and excluded from every LLM toolset. */
export function hiddenSocialMcpToolNames(
  connectors: DiscoveredSocialConnector[],
): Set<string> {
  return new Set(
    connectors.flatMap((connector) => {
      if (!connector.manifest) return [];
      return [
        socialMcpToolName(connector.manifest, "publish"),
        socialMcpToolName(connector.manifest, "disconnectAccount"),
      ].filter((name): name is string => Boolean(name));
    }),
  );
}

/**
 * Discover connector manifests without loading connector code. Invalid
 * manifests are returned with an error so `lisa sense social` can surface them.
 */
export async function discoverSocialConnectors(
  pluginsRoot: string = path.join(lisaGlobalHome(), "plugins"),
): Promise<DiscoveredSocialConnector[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: DiscoveredSocialConnector[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestPath = path.join(pluginsRoot, entry.name, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      out.push({
        plugin: entry.name,
        manifestPath,
        error: (err as Error).message,
      });
      continue;
    }
    try {
      const manifest = parseSocialConnectorManifest(JSON.parse(raw) as unknown);
      out.push({ plugin: entry.name, manifestPath, manifest });
    } catch (err) {
      out.push({
        plugin: entry.name,
        manifestPath,
        error: (err as Error).message,
      });
    }
  }
  return out.sort((a, b) => a.plugin.localeCompare(b.plugin));
}
