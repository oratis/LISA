import type { ToolDefinition } from "../../types.js";
import {
  createSocialDraft,
  getSocialDraft,
  listSocialDrafts,
  requestSocialDraftApproval,
  updateSocialDraft,
} from "./drafts.js";
import { discoverSocialConnectors } from "./manifest.js";
import type {
  NewSocialDraft,
  SocialDraftPatch,
} from "./types.js";

interface SocialComposeInput {
  action:
    | "connectors"
    | "drafts"
    | "view"
    | "new_draft"
    | "update_draft"
    | "request_confirmation";
  id?: string;
  expectedRevision?: number;
  draft?: NewSocialDraft;
  patch?: SocialDraftPatch;
}

/**
 * Model-visible social surface. Deliberately no approve/publish actions:
 * confirmation is a local UI/CLI action and publishing is a deterministic host
 * runner, never a capability handed to the model.
 */
export const socialComposeTool: ToolDefinition<SocialComposeInput, string> = {
  name: "social_compose",
  description:
    "Prepare social-media posts through LISA's host-enforced draft workflow. " +
    "Can list connectors/drafts, create or update a draft, inspect it, and request a confirmation preview. " +
    "It CANNOT approve or publish: the user must confirm the immutable preview in a trusted local UI.",
  annotations: {
    title: "Social post composer",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "connectors",
          "drafts",
          "view",
          "new_draft",
          "update_draft",
          "request_confirmation",
        ],
      },
      id: { type: "string" },
      expectedRevision: { type: "number" },
      draft: { type: "object" },
      patch: { type: "object" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async execute(input) {
    switch (input.action) {
      case "connectors": {
        const connectors = await discoverSocialConnectors();
        return JSON.stringify(
          connectors.map((item) =>
            item.manifest
              ? {
                  id: item.manifest.id,
                  displayName: item.manifest.displayName,
                  platform: item.manifest.platform,
                  skill: item.manifest.skill,
                  available: true,
                }
              : {
                  plugin: item.plugin,
                  available: false,
                  error: item.error,
                },
          ),
        );
      }
      case "drafts": {
        const drafts = await listSocialDrafts();
        return JSON.stringify(
          drafts.map(({ id, revision, state, targets, updatedAt }) => ({
            id,
            revision,
            state,
            targets,
            updatedAt,
          })),
        );
      }
      case "view": {
        if (!input.id) throw new Error("social_compose view requires id");
        const draft = await getSocialDraft(input.id);
        if (!draft) throw new Error(`social draft "${input.id}" not found`);
        return JSON.stringify(draft);
      }
      case "new_draft": {
        if (!input.draft) {
          throw new Error("social_compose new_draft requires draft");
        }
        return JSON.stringify(await createSocialDraft(input.draft));
      }
      case "update_draft": {
        if (!input.id || input.expectedRevision == null || !input.patch) {
          throw new Error(
            "social_compose update_draft requires id, expectedRevision, and patch",
          );
        }
        return JSON.stringify(
          await updateSocialDraft(
            input.id,
            input.expectedRevision,
            input.patch,
          ),
        );
      }
      case "request_confirmation": {
        if (!input.id || input.expectedRevision == null) {
          throw new Error(
            "social_compose request_confirmation requires id and expectedRevision",
          );
        }
        const result = await requestSocialDraftApproval(
          input.id,
          input.expectedRevision,
        );
        return JSON.stringify({
          draft: result.draft,
          approvalDigest: result.digest,
          instruction:
            "Show this exact preview to the user. Publishing remains blocked until they approve it in the trusted local Sense UI.",
        });
      }
    }
  },
};
