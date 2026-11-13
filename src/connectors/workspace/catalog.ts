// Public card metadata. Credentials and tenant-specific settings never enter this catalog.
export const workspaceApps = {
  todoist: {
    name: "Todoist",
    example: {
      en: "Summarize the active tasks in my selected Todoist projects.",
      "zh-CN": "总结我选定的 Todoist 项目中进行中的任务。",
    },
    vendor: "todoist",
    scope: "data:read",
    unit: "project",
    hint: "Project ID",
    intent: /\btodoist\b/i,
  },
  "outlook-mail": {
    name: "Outlook Mail",
    example: {
      en: "Summarize recent messages in my selected Outlook Mail folders.",
      "zh-CN": "总结我选定的 Outlook 邮箱文件夹中的近期邮件。",
    },
    vendor: "microsoft",
    scope: "Mail.ReadBasic",
    unit: "mailFolder",
    hint: "Mail folder ID",
    intent: /(?:outlook|微软).{0,16}(?:邮件|邮箱|收件箱|mail|inbox)|(?:mail|inbox).{0,12}outlook/i,
  },
  "outlook-calendar": {
    name: "Outlook Calendar",
    example: {
      en: "List upcoming events in my selected Outlook calendars.",
      "zh-CN": "列出我选定的 Outlook 日历中即将到来的日程。",
    },
    vendor: "microsoft",
    scope: "Calendars.ReadBasic",
    unit: "calendar",
    hint: "Calendar ID",
    intent: /(?:outlook|微软).{0,24}(?:日历|日程|会议|calendar|schedule)|calendar.{0,12}outlook/i,
  },
  onedrive: {
    name: "OneDrive",
    example: {
      en: "Summarize the text in my selected OneDrive files.",
      "zh-CN": "总结我选定的 OneDrive 文件中的文本。",
    },
    vendor: "microsoft",
    scope: "Files.Read",
    unit: "file",
    hint: "Drive item ID",
    intent: /\bone\s?drive\b/i,
  },
  sharepoint: {
    name: "SharePoint",
    example: {
      en: "Summarize the text in my selected SharePoint files.",
      "zh-CN": "总结我选定的 SharePoint 文件中的文本。",
    },
    vendor: "microsoft",
    scope: "Sites.Selected",
    unit: "siteFile",
    hint: "siteId|itemId",
    intent: /\bsharepoint\b/i,
  },
  jira: {
    name: "Jira",
    example: {
      en: "Review open issues in my selected Jira projects.",
      "zh-CN": "查看我选定的 Jira 项目中的未完成工单。",
    },
    vendor: "atlassian",
    scope: "read:jira-work",
    unit: "project",
    hint: "cloudId|projectId",
    intent: /\bjira\b/i,
  },
  confluence: {
    name: "Confluence",
    example: {
      en: "Summarize my selected Confluence pages.",
      "zh-CN": "总结我选定的 Confluence 页面。",
    },
    vendor: "atlassian",
    scope: "read:page:confluence",
    unit: "page",
    hint: "cloudId|pageId",
    intent: /\bconfluence\b/i,
  },
  figma: {
    name: "Figma",
    example: {
      en: "Review the frames in my selected Figma design.",
      "zh-CN": "查看我选定的 Figma 设计中的画框。",
    },
    vendor: "figma",
    scope: "file_content:read",
    unit: "design",
    hint: "Figma URL / fileKey|nodeId",
    intent: /\bfigma\b/i,
  },
  dropbox: {
    name: "Dropbox",
    example: {
      en: "Summarize the text in my selected Dropbox files.",
      "zh-CN": "总结我选定的 Dropbox 文件中的文本。",
    },
    vendor: "dropbox",
    scope: "files.metadata.read files.content.read",
    unit: "file",
    hint: "id:…",
    intent: /\bdropbox\b/i,
  },
  "apple-calendar": {
    name: "Apple Calendar",
    example: {
      en: "List upcoming events in my selected Apple Calendar calendars.",
      "zh-CN": "列出我选定的苹果日历中即将到来的日程。",
    },
    vendor: "apple",
    scope: "events",
    unit: "calendar",
    hint: "Calendar ID",
    intent: /(?:apple|macOS|苹果).{0,10}(?:日历|日程|calendar)|\biCal\b/i,
  },
  "apple-reminders": {
    name: "Apple Reminders",
    example: {
      en: "List open items in my selected Apple Reminders lists.",
      "zh-CN": "列出我选定的苹果提醒事项列表中未完成的事项。",
    },
    vendor: "apple",
    scope: "reminders",
    unit: "reminderList",
    hint: "Reminder list ID",
    intent: /(?:apple|macOS|苹果).{0,10}(?:提醒事项|提醒|reminders)/i,
  },
} as const;
export type WorkspaceId = keyof typeof workspaceApps;
export const workspaceIds = Object.keys(workspaceApps) as WorkspaceId[];
export type CloudId = Exclude<WorkspaceId, "apple-calendar" | "apple-reminders">;
/** The same permission string is shown on the card and used in the authorization request. */
export function workspaceScopes(id: WorkspaceId) {
  const app = workspaceApps[id];
  switch (app.vendor) {
    case "microsoft":
      return "User.Read " + app.scope + " offline_access";
    case "atlassian":
      return "read:me " + app.scope + " offline_access";
    case "dropbox":
      return "account_info.read " + app.scope;
    case "figma":
      return "current_user:read " + app.scope;
    default:
      return app.scope;
  }
}
const writeVerb =
  /删除|创建|更新|修改|清空|标记|发送|回复|邀请|写入|上传|移动到|归档|\b(?:send|reply|create|delete|write|edit|update|invite|archive|upload|move|assign|mark|close)\b/i;
// Whole English words only: "already" must not read as "read". Question words such as
// "what", "find" and "show" are left out, so "What is Figma?" stays an ordinary chat.
const readVerb =
  /查看|读取|看看|列出|汇总|总结|梳理|只读|安排|待办|日程|查找|\b(?:read|list|summari[sz]e|review|inspect|schedule)\b/i;
/**
 * Sources a message explicitly asks to read. The server further drops sources that are not
 * available on this install (no OAuth client configured, or no EventKit reader).
 */
export function workspaceReadIntents(text: string): WorkspaceId[] {
  if (writeVerb.test(text) || !readVerb.test(text)) return [];
  return workspaceIds.filter((id) => workspaceApps[id].intent.test(text));
}
export function toolName(id: WorkspaceId) {
  return id.replaceAll("-", "_") + "_read";
}
