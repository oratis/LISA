import type { ApprovalMode } from "../approval.js";
import { openAIChatEfforts } from "../providers/openai.js";
import { DEFAULT_MODEL } from "../llm.js";
import { hasCredentialsForModel } from "../providers/registry.js";
import { chatPermissions, type ChatPermission } from "../warden/chat-permissions.js";

const efforts = ["low", "medium", "high"] as const;
type ChatEffort = (typeof efforts)[number] | "xhigh";

export interface ChatControls {
  permission: ChatPermission;
  /** Omitted means follow the server's configured model and fallback chain. */
  model?: string;
  effort?: ChatEffort;
}

function effortChoices(model: string): readonly ChatEffort[] {
  // The Anthropic adapter passes output_config.effort. Other adapters and
  // older Claude models do not promise this knob.
  return /^claude-(sonnet|opus)-(4-6|[5-9])(?:-|$)/i.test(model)
    ? efforts
    : openAIChatEfforts(model);
}

/** Build the allowed permissions, models, and reasoning effort levels for local Web chat. */
export function chatControlOptions(
  defaultModel: string,
  approval: ApprovalMode,
  env = process.env,
) {
  const configured = env.LISA_CHAT_MODELS?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const candidates = configured?.length
    ? configured
    : [
        ...(env.LISA_MODEL_FALLBACK ?? "").split(",").map((id) => id.trim()),
        env.LISA_MODEL_SMALL,
        DEFAULT_MODEL,
        "claude-haiku-4-5",
        "gemini-2.5-flash",
        "deepseek-chat",
        // A custom OpenAI-compatible endpoint only knows the model IDs its
        // operator installed. Its key does not imply it serves OpenAI's lineup.
        ...(!env.LISA_BASE_URL ? ["gpt-6-astra", "gpt-4o", "gpt-4o-mini"] : []),
      ];
  const models = new Set([defaultModel]);
  for (const id of candidates) {
    if (
      id &&
      /^[a-z0-9][a-z0-9._:/-]{0,119}$/i.test(id) &&
      !id.includes("://") &&
      hasCredentialsForModel(id, env)
    )
      models.add(id);
  }
  return {
    defaultModel,
    permissions: chatPermissions(approval),
    models: [...models].map((id) => ({ id, efforts: effortChoices(id) })),
  };
}

/** Validate and normalize client-supplied chat controls against the server's allowed options. */
export function parseChatControls(
  raw: unknown,
  options: ReturnType<typeof chatControlOptions>,
): ChatControls {
  if (raw === undefined) return { permission: options.permissions[0]! };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid_chat_controls");
  if (Object.keys(raw).some((key) => !["permission", "model", "effort"].includes(key)))
    throw new Error("invalid_chat_controls");
  const { permission, model, effort } = raw as Record<string, unknown>;
  if (!options.permissions.some((value) => value === permission))
    throw new Error("chat_permission_unavailable");
  const choice = options.models.find(
    (m) => m.id === (model === undefined ? options.defaultModel : model),
  );
  if (!choice) throw new Error("chat_model_unavailable");
  if (effort !== undefined && !choice.efforts.some((value) => value === effort))
    throw new Error("chat_effort_unavailable");
  return {
    permission: permission as ChatPermission,
    ...(model === undefined ? {} : { model: choice.id }),
    ...(effort === undefined ? {} : { effort: effort as ChatEffort }),
  };
}
