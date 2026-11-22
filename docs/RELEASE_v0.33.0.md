# Lisa 0.33.0 — Game libraries and app connectors

Lisa 0.33.0 adds local game library imports and product icons across the connector directory, chat picker and permission cards. Online game connectors are off by default. Dashboard cards show setup requirements and the current grant. The directory works at phone widths and supports keyboard navigation. The iOS Room and native Mac account and device windows also have updated layouts. Pocket changes follow its separate native release channel.

## Organize games from a file

Open **Dashboard → App connectors → Game Library · Playnite**. Send the example in chat to open the local file picker. Choose a Playnite CSV/TSV, or fill out the downloadable template with the games you want to share. Filter the preview, choose fields and select up to 30 games. The original file stays in the browser. The first confirmation saves those rows on this computer. The second confirmation grants the selected scope to the configured chat model.

You can enter records from Epic, PlayStation, Xbox, Nintendo, GOG and other platforms into the template. Each row retains its source, version and time units when supplied. Automatic synchronization and parsing native PDF, HTML or Excel account archives require separate platform-specific validation.

## Online game connectors are off by default

The release ships without game service credentials. Each service requires its own explicit host configuration and restart. Opening the directory or importing a file makes no game platform requests. The following integrations are available for operator testing.

- **itch.io** connects through a registered desktop OAuth application. Select claimed titles from your library. Disconnecting removes the local grant and attempts upstream revocation. itch.io may share that token between other installations of the same client.
- **Steam** verifies the account through Steam OpenID. A host operator supplies a registered Steam Web API key. The connector reads selected visible games, playtime and achievements where available.
- **Game information and prices** opens a separate lookup panel in the dashboard directory. Search IGDB by title or Steam AppID and choose a game or edition. Use IsThereAnyDeal with a country code to check covered stores, currencies and recent price history. These lookups use application credentials and do not send the player's identity or library.

Disconnect clears gaming grant metadata on this host. Previously shared chat results remain in session history and can be reviewed through Forget.

## Follow-up verification

Local acceptance covered file preview, field selection, scoped reads, disconnect and saving templates in the Mac app. Follow-up testing covers real itch.io consent and revocation, Steam accounts with different privacy settings, registered IGDB and IsThereAnyDeal queries, and redacted Windows Playnite exports and native platform archives. The [game platform integration plan and acceptance checklist](https://github.com/oratis/LISA/blob/v0.33.0/docs/RESEARCH_GAME_PLATFORM_CONNECTORS_2026-11-22.md#本机配置与验收状态) records the evidence needed for each platform.
