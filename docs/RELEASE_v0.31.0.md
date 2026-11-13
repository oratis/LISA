# Lisa 0.31.0 — Your other Macs, more of your apps

Lisa on your Mac can now start and steer Claude Code in workspaces on your other paired Macs, each one granted separately. Read-only connections grow from seven apps to eighteen, cards let you pick what Lisa may read in one place, and you can browse the connectors and add public HTTPS MCP servers from the chat. Codex sessions show up again with their real titles. This release also fixes a security problem in the local web server, stops the hosted edition from running the idle dream, and corrects how cached tokens are counted for OpenAI-compatible models.

## Security fix for the local web server

On the Mac edition, a request that reaches Lisa over loopback needs no token. Before this release, most routes trusted such a request whatever page sent it. Lisa now checks every loopback request before routing it:

- A state-changing request from another site is refused.
- A read from another site is refused unless you followed a link to Lisa in the browser.
- A request that connects over loopback but names another host, such as a tunnel, a reverse proxy or a DNS-rebinding page, is treated as a remote caller. It needs `LISA_WEB_TOKEN`, as a phone on your network does. It gets in with the token, but it is never treated as the owner at the machine.

The Mac app, the menu bar, the island, the CLI, Lisa Pocket over the relay and OAuth sign-ins are unaffected. If you reach Lisa through a tunnel without a token, set `LISA_WEB_TOKEN`.

## Claude Code on your other Macs

A new Remote Macs page lists the Macs paired to your account. Pick a workspace, start Claude Code there, send another turn, read the result or stop it.

- Each Mac grants each workspace separately, after v2 pairing. The relay only carries encrypted traffic and cannot start anything.
- File tools on the remote Mac ask for approval once per use. Paths outside the workspace, dot folders and links are refused.
- If Lisa restarts while an agent is running, the next start either frees the slot or stops the agent. It stops it only after confirming it is the same process it launched.
- Revoking a device, or removing a workspace from its grant, stops that device's running agents.
- A timeline records each remote task, so the controlling Mac can page through what happened.

## Eighteen read-only connections

New read-only connections: Todoist, Outlook Mail, Outlook Calendar, OneDrive, SharePoint, Jira, Confluence, Figma, Dropbox, Apple Calendar and Apple Reminders. They join GitHub, Google Calendar, Gmail, Linear, Google Drive, Slack and Notion.

- Each source requests read-only scopes, and Lisa reads only the projects, folders, calendars, pages or files you select on its card.
- A cloud source appears once its OAuth client is configured (see the connector setup guide). Todoist needs no setup.
- Apple Calendar and Apple Reminders need a Swift toolchain on macOS 14 or later. They are not available in the Mac app yet.
- Each connection card groups the account, the read-only scope, the resources you can select and the confirmation. It has keyboard-accessible select-all and clear, a live count, labelled pages and the 30-resource limit, and it keeps your selection while you page.
- Lisa only parks a chat behind a connection card when you plainly ask to read a source. Questions such as "What is Figma?" are answered as ordinary chat.

## Connectors and MCP from the chat

- Type `/connectors`, ask which apps you can connect, or use the + menu to browse the connectors available here. Each one has an example request you can edit before sending.
- MCP configs, at home and in plugins, accept public HTTPS (Streamable HTTP) servers, optionally limited to an exact list of tool names. Lisa sends them no credentials and resolves and pins their address on every request. Their results reach the model fenced as untrusted content.

## Codex sessions in Lisa

Control finds your local Codex sessions again and lets you show or hide them without restarting Lisa. The sidebar, tabs and inspector show each session's Codex title and project. The reader handles the current desktop and CLI formats, and skips the setup text the CLI writes. A metadata-only visibility setting stays as you set it.

## Memory corrections you can trace

When Rêve corrects a memory, the correction is grounded in what you said, including in earlier conversations, and you can see the history of each change.

## Also in this release

- **Long chats stay cheaper.** Past the context budget, the start of the conversation sent to the model now stays the same for many turns instead of changing every turn, so the provider's prompt cache keeps working.
- **Quicker lookups.** Independent reads, searches and fetches in one turn run at the same time in the web chat and the CLI. Sub-agents still run one at a time.
- **Reflection is sturdier.** A reply with text around its JSON is no longer thrown away. A reply cut off at the output limit is retried with room to finish. An unparseable pass is never stored as the conversation's summary.
- **Fetched pages arrive as served.** Web pages, search results and saved web captures are fenced with a marker that carries a random id for each call, so the content is no longer rewritten to defuse look-alike markers.
- **Hosted edition.** The idle dream no longer runs on the multi-tenant server. Operators get a protected console at `/console` with role-based access, capped credit grants, support tickets and an audit history that archives itself.
- **Billing.** Cached prompt tokens for OpenAI-compatible models are counted once, not twice.
- **Anthropic SDK 1.7.** Requests now use Anthropic API version `2026-10-21`. The API key is still sent as `x-api-key`. When an auth token is configured, only the token is sent.
- The Mac build rebuilds the bundled backend before packaging.

## Behaviour changes to note

- A loopback request that names a non-loopback host needs `LISA_WEB_TOKEN`. Without it, the answer is `403 untrusted_host`.
- Older Lisa Pocket builds can still deny a managed-agent approval, but approving needs the updated Pocket.
- Fetched content is fenced as `<<<EXTERNAL-CONTENT id=…>>> … <<<END-EXTERNAL-CONTENT id=…>>>`. Anything outside Lisa that parsed the old markers needs updating.
- For OpenAI-compatible models, `inputTokens` now counts only uncached input, as it already did for Anthropic and Gemini. Usage and token budgets read lower.
- Anthropic-compatible endpoints behind `ANTHROPIC_BASE_URL` now receive `anthropic-version: 2026-10-21`.

## Known limits

- The Feishu document connector is still in review and is not part of this release.
- Apple Calendar and Apple Reminders are not available in the Mac app yet.
- How strictly each model honours the fence id, and how much the cache change saves, have not been measured against live providers.
- The physical iPhone Wi-Fi/cellular handoff test is still pending.

## Updating

Replace Lisa.app in Applications, then restart its background service or the Mac. Update Lisa Pocket to approve managed-agent requests from the phone. With npm: `npm i -g @oratis/lisa@0.31.0`. With Homebrew: `brew upgrade lisa`.
