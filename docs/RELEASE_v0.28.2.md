# Lisa v0.28.2 — a little more room

- **Smaller room character.** Lisa is 14% smaller in both rooms, with shadows scaled to match. Seated poses stay attached to the chair; standing poses keep their feet on the rug. Reading, working, tea and sleep now use dedicated seated drawings, with furniture occlusion and shared room lighting.
- **A clearer Send button.** One upward arrow and a single-line “Send” label replace the duplicate arrows. The compact control retains its keyboard shortcut and accessible name. This includes the previously merged #424 fix in the Mac download.
- **One Mac/web icon.** The Mac app, website header/footer/hero, favicon, touch icon and web-app icons use the pixel-art Lisa icon from the owner's installed Mac app. Website icon URLs include a content digest so old cached artwork is replaced.
- **Layout polish.** Long identity text stays inside the sidebar; the menu-bar portrait is circular.
- **Release maintenance.** Production dependencies refreshed within supported ranges, and current website Lisa Pocket availability copy retained from #431. Lisa Pocket ships separately; this version does not upload a new iOS binary or change Cloud feature flags.

## Updating

Download the signed and notarized **Lisa-Suite-v0.28.2.dmg** from this release and replace Lisa.app in Applications. Chat history and settings remain in your existing Lisa home directory.

If you deliberately installed a room preview using `~/.lisa/serve-command.txt`, that override takes priority over the bundled backend. Back up and remove only that preview override to use the released backend, then restart Lisa. Custom commands for other backends should be left in place.

## Icon source

The canonical master is `packaging/mac-client/Resources/app-icon-1024.png`, extracted unchanged from the installed `AppIcon.icns` on 2026-11-07 (SHA-256 `16ec141139bbf208b31138f59c7f36d2aadddbaa4f0f6f39c362bea39695ac2b`). Run `node scripts/sync-brand-icons.mjs` to reproduce the website and web-app exports. Soft Ink character illustrations remain separate from the app's branding.
