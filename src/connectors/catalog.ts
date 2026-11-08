import { workspaceApps, workspaceIds, workspaceScopes } from "./workspace/catalog.js";

/** Reviewed local-owner providers; adding a catalog entry never enables arbitrary MCP. */
export const CONNECTOR_CATALOG = [
  { id: "github", name: "GitHub", access: "read", authModes: ["existing", "login"] },
  {
    id: "google-calendar",
    name: "Google Calendar",
    access: "read",
    authModes: ["freebusy", "events"],
  },
  { id: "gmail", name: "Gmail", access: "read", authModes: ["login"] },
  { id: "linear", name: "Linear", access: "read", authModes: ["login"] },
  { id: "google-drive", name: "Google Drive", access: "read", authModes: ["login"] },
  { id: "slack", name: "Slack", access: "read", authModes: ["login"] },
  { id: "notion", name: "Notion", access: "read", authModes: ["login"] },
  ...workspaceIds.map((id) => {
    const { name, vendor, unit, hint } = workspaceApps[id];
    return {
      id,
      name,
      access: "read" as const,
      authModes: ["login"],
      workspace: { vendor, unit, hint, scope: workspaceScopes(id) },
    };
  }),
] as const;
export type ConnectorProvider = (typeof CONNECTOR_CATALOG)[number]["id"];
