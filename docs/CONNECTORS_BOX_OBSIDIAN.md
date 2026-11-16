# Box and Obsidian connectors

Both connectors are read-only and use Lisa's existing consent flow: ask for a read in chat, authorize, select resources, then let Lisa resume the original task. They are available only to the local owner. Dashboard lists all providers even when their login configuration is absent. “Authorized” describes a saved grant, not a live health check; refreshing Dashboard never reads provider documents.

## Box

Register a Box Platform App using OAuth 2.0. Enable **Read all files and folders** (`root_readonly`) and register `http://localhost:4870/oauth/box` as its redirect URI. Lisa explicitly requests only this scope.

Use the existing workspace client configuration: set `LISA_WORKSPACE_CLIENTS_FILE` in `~/.lisa/config.env` to an absolute path, protect that JSON file with mode `0600`, and add:

```json
{
  "box": {
    "clientId": "YOUR_BOX_CLIENT_ID",
    "clientSecret": "YOUR_BOX_CLIENT_SECRET"
  }
}
```

Restart Lisa. Send “Summarize the text in my selected Box files.” Sign in through the displayed Box link, then select files from the root listing or enter a file ID for a file elsewhere. Selection does not grant sibling files or descendants. Supported text extensions: `.txt`, `.md`, `.csv`, `.tsv`, `.json`, `.log`, `.xml`, `.yaml`, `.yml`; downloads are capped at 1 MB, output at 30,000 characters. Binary/PDF/Office extraction is not included in this connector.

Reads pin the file version and reject concurrent changes. Signed download redirects are restricted to public Box CDN addresses and do not receive the Box bearer. Refresh-token rotation is stored before use. Disconnect removes the local grant; manage upstream app consent in Box if full app revocation is needed.

References: [Box OAuth without SDKs](https://developer.box.com/guides/authentication/oauth2/without-sdk/), [read-only scopes](https://developer.box.com/guides/api-calls/permissions-and-errors/scopes/), [download API](https://developer.box.com/reference/get-files-id-content/).

## Obsidian

Open a vault in Obsidian on the same computer. Send “Search my selected Obsidian vaults and summarize my Markdown notes.” Choose **Choose local vaults**, then explicitly select the vaults Lisa may read. No community plugin or local HTTP server is needed. Requested note content is provided to the configured conversation model, as with other chat sources.

Lisa discovers registered vaults from Obsidian's local configuration. For a portable or nonstandard installation, `LISA_OBSIDIAN_VAULTS` may be a JSON array of absolute vault paths in Lisa's environment; restart after changing it. This is host configuration, never model-controlled input.

Only ordinary Markdown files in selected vaults can be read. Hidden directories (including `.obsidian`), symbolic links, hard-linked files and attachments are excluded from content reads. Vault identity is rechecked after access. A moved/replaced vault requires renewed selection. Notes are capped at 256 KB and returned text at 30,000 characters. Search is bounded to 1,000 visited entries, 4 MB of text, eight directory levels and 50 results, with truncation reported. No files are written.

Reference: [Obsidian vaults are local folders](https://obsidian.md/help/manage-vaults).

## 中文验收路径

- **Box**：完成本机应用配置后，在聊天中输入“总结我选定的 Box 文件中的文本”，登录、选择文件、确认只读访问。未配置时，总览明确显示“待配置”。
- **Obsidian**：先在本机打开保险库，再输入“检索我选定的 Obsidian 保险库并总结 Markdown 笔记”，选择保险库后继续。未发现保险库时会显示下一步操作。
- **总览**：搜索 Box 或 Obsidian，查看已保存的授权状态与选定资源数量。授权、选范围和发送请求都由用户明确触发。
