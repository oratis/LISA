import crypto from "node:crypto";
import type { ToolDefinition } from "../../types.js";
import { appendSocialAudit } from "./audit.js";
import {
  claimApprovedSocialDraft,
  completeSocialDraftPublish,
} from "./drafts.js";
import {
  discoverSocialConnectors,
  socialMcpToolName,
} from "./manifest.js";
import type {
  DiscoveredSocialConnector,
  SocialPublishOutcome,
} from "./types.js";
import { socialPublishingPaused } from "./policy.js";

export interface SocialRunnerOptions {
  connectorTools: ToolDefinition[];
  connectors?: DiscoveredSocialConnector[];
  signal?: AbortSignal;
  now?: () => number;
}

function parsedValue(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function parsedObject(value: unknown): Record<string, unknown> {
  const parsed = parsedValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("connector returned a non-object result");
  }
  return parsed as Record<string, unknown>;
}

async function invokeValue(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`connector tool "${name}" is not loaded`);
  const output = await tool.execute(input, {
    cwd: process.cwd(),
    signal,
    log: () => {},
  });
  return parsedValue(output);
}

async function invoke(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const parsed = parsedObject(await invokeValue(tools, name, input, signal));
  if (parsed.ok === false) throw new Error(String(parsed.error ?? "connector failed"));
  return parsed;
}

export async function listSocialConnectorAccounts(
  connectorTools: ToolDefinition[],
  connectors?: DiscoveredSocialConnector[],
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  const signal = new AbortController().signal;
  for (const connector of connectors ?? await discoverSocialConnectors()) {
    if (!connector.manifest) continue;
    const name = socialMcpToolName(connector.manifest, "listAccounts");
    if (!name) continue;
    try {
      const accounts = await invokeValue(connectorTools, name, {}, signal);
      result[connector.manifest.id] = Array.isArray(accounts) ? accounts : [];
    } catch {
      result[connector.manifest.id] = [];
    }
  }
  return result;
}

/**
 * Deterministic publication path. It consumes a one-shot approval, validates
 * again against runtime capabilities, calls only manifest-bound hidden tools,
 * and records exactly one structural outcome per target.
 */
export async function publishApprovedSocialDraft(
  id: string,
  digest: string,
  opts: SocialRunnerOptions,
) {
  if (await socialPublishingPaused()) {
    throw new Error("social publishing is paused");
  }
  const now = opts.now ?? Date.now;
  const draft = await claimApprovedSocialDraft(id, digest, now());
  const connectors = opts.connectors ?? await discoverSocialConnectors();
  const signal = opts.signal ?? new AbortController().signal;
  const outcomes: SocialPublishOutcome[] = [];
  for (const target of draft.targets) {
    const targetKey = `${target.connectorId}:${target.accountId}`;
    const manifest = connectors.find(
      (candidate) => candidate.manifest?.id === target.connectorId,
    )?.manifest;
    try {
      if (!manifest) throw new Error(`connector "${target.connectorId}" is unavailable`);
      const variant = draft.variants[targetKey];
      const validateName = socialMcpToolName(manifest, "validateDraft");
      const publishName = socialMcpToolName(manifest, "publish");
      if (!validateName || !publishName) throw new Error("connector manifest is incomplete");
      const validation = await invoke(
        opts.connectorTools,
        validateName,
        { content: draft.canonical, variant },
        signal,
      );
      if (validation.ok !== true) {
        const errors = Array.isArray(validation.errors)
          ? validation.errors.map(String).join("; ")
          : "runtime validation failed";
        throw new Error(errors);
      }
      const result = await invoke(
        opts.connectorTools,
        publishName,
        {
          accountId: target.accountId,
          target,
          content: draft.canonical,
          variant,
          idempotencyKey: crypto
            .createHash("sha256")
            .update(`${draft.id}\0${draft.revision}\0${targetKey}`)
            .digest("hex"),
        },
        signal,
      );
      outcomes.push({
        targetKey,
        ok: true,
        platformPostId:
          typeof result.platformPostId === "string"
            ? result.platformPostId
            : undefined,
        url: typeof result.url === "string" ? result.url : undefined,
        attempts: 1,
        completedAt: new Date(now()).toISOString(),
      });
    } catch (err) {
      outcomes.push({
        targetKey,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        attempts: 1,
        completedAt: new Date(now()).toISOString(),
      });
    }
  }
  const finished = await completeSocialDraftPublish(id, outcomes, now());
  await appendSocialAudit({
    at: finished.updatedAt,
    draftId: finished.id,
    revision: finished.revision,
    digestPrefix: digest.slice(0, 12),
    state: finished.state,
    targets: outcomes.map(({ targetKey, ok, platformPostId, error }) => ({
      targetKey,
      ok,
      platformPostId,
      error,
    })),
  });
  return finished;
}
