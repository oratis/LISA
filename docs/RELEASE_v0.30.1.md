# Lisa 0.30.1 — a clearer everyday view

Light mode now has calmer surfaces, stronger text and status contrast, and clearer controls across the website, cloud app, Mac and Lisa Pocket.

- Web and Mac follow the system appearance by default, retain explicit choices, and synchronize open web windows. Appearance is easy to find in Settings.
- Login and account pages use the same light/dark palette. The bilingual website gains an accessible system/light/dark selector.
- Chat has more comfortable line spacing, reading width and touch targets. Settings use labeled controls and clearer grouping.
- Mac synchronizes its native window appearance with the page and preserves the chosen palette during connection failures.
- Lisa Pocket uses adaptive status colors shared with its widgets, clearer message bubbles and input controls, and defaults new installs to system appearance. Existing choices remain intact.
- Includes the latest hosted-startup correction and connector improvements from main.

Validation: 4,043 core tests passed (one pre-existing skip), 35 browser interaction tests passed, 23 Mac tests passed, and 104 iOS simulator tests passed (one opt-in remote-relay test skipped). Mac native message entry, reply, appearance switching, reload persistence and connection-failure presentation were checked. iOS native chat rendering was reviewed in both appearances and at an accessibility text size; text/status contrast passes 4.5:1 on the app's main surfaces. Physical-device validation was unavailable in this session.

Mac: use the signed, notarized DMG attached to this release. Lisa Pocket: the updated 1.3 build is distributed through TestFlight after Apple processing; this release does not imply App Store review approval.
