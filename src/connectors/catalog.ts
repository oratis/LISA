/** Reviewed local-owner providers. Examples are editable read requests for the chat composer. */
export const CONNECTOR_CATALOG = [
  {
    id: "github",
    name: "GitHub",
    access: "read",
    authModes: ["existing", "login"],
    example: {
      en: "Summarize recent commits and pull requests in my selected GitHub repositories.",
      "zh-CN": "总结我选定的 GitHub 仓库最近的提交和 PR。",
    },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    access: "read",
    authModes: ["freebusy", "events"],
    example: {
      en: "List my free time in Google Calendar over the next seven days using the selected calendars.",
      "zh-CN": "查看我选定的 Google 日历未来七天的空闲时段。",
    },
  },
  {
    id: "gmail",
    name: "Gmail",
    access: "read",
    authModes: ["login"],
    example: {
      en: "Summarize recent Gmail subjects and snippets from my selected labels.",
      "zh-CN": "总结我选定标签下 Gmail 近期邮件的主题和摘要。",
    },
  },
  {
    id: "linear",
    name: "Linear",
    access: "read",
    authModes: ["login"],
    example: {
      en: "Review open Linear issues in my selected teams.",
      "zh-CN": "查看我选定团队中的 Linear 待办工单。",
    },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    access: "read",
    authModes: ["login"],
    example: {
      en: "Summarize the text in my selected Google Drive files.",
      "zh-CN": "总结我选定的 Google Drive 文件中的文本。",
    },
  },
  {
    id: "slack",
    name: "Slack",
    access: "read",
    authModes: ["login"],
    example: {
      en: "Summarize recent messages in my selected Slack channels.",
      "zh-CN": "总结我选定的 Slack 频道最近的消息。",
    },
  },
  {
    id: "notion",
    name: "Notion",
    access: "read",
    authModes: ["login"],
    example: {
      en: "Summarize the content of my selected Notion pages.",
      "zh-CN": "总结我选定的 Notion 页面内容。",
    },
  },
] as const;
export type ConnectorProvider = (typeof CONNECTOR_CATALOG)[number]["id"];

/** Directory lookups are side-effect free, including while a connection card is waiting. */
export function connectorCatalogReply(message: string, language?: string): string | undefined {
  const text = message.trim();
  const command = /^\/connectors(?:[ \t]+([^\r\n]{1,100}))?$/i.exec(text);
  const chinese =
    /^(?:有哪些(?:应用|连接器)可以连接|(?:可以|能)连接(?:哪些|什么)应用|有哪些(?:应用)?连接器)[？?。]?$/u.test(
      text,
    );
  const english =
    /^(?:what (?:apps|connectors) can I connect|(?:list|show)(?: the)? (?:available |supported )?(?:app )?connectors)[?!.]?$/i.test(
      text,
    );
  if (!command && !chinese && !english) return;
  const zh = chinese || (!!command && /^zh\b/i.test(language ?? ""));
  const query = command?.[1]?.trim().toLowerCase() ?? "";
  const entries = CONNECTOR_CATALOG.filter((app) =>
    [app.id, app.name, app.example.en, app.example["zh-CN"]].some((v) =>
      v.toLowerCase().includes(query),
    ),
  );
  if (!entries.length)
    return zh
      ? "没有匹配的连接器。输入 /connectors 查看全部。"
      : "No matching app. Use /connectors to see the full catalog.";
  return [
    zh
      ? "本机支持以下只读任务。发送一条示例可选择账号和读取范围。"
      : "These read-only tasks are available on this host. Send an example to use or set up its connection.",
    ...entries.map((app) => `- **${app.name}** — ${app.example[zh ? "zh-CN" : "en"]}`),
  ].join("\n\n");
}
