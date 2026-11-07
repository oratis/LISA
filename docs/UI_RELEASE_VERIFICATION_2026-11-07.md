# Appearance release verification — 2026-11-07

The light-mode and interaction improvements are published on the website and
Cloud, included in the signed Mac 0.30.3 installer, and uploaded to internal
TestFlight as Lisa Pocket 1.3 (1794062401).

## Sources and deployment

- UI implementation: [PR #458](https://github.com/oratis/LISA/pull/458), merged as `32a8b84`.
- Mac cumulative release: `v0.30.3`. Its source tree matches main commit `3345b13`.
- Cloud/website deployment source: `cc998a89022047a2f9d3a40b10cc2f6740e81685`
  on `codex/ui-console-integration-20261107`. This combines main `3345b13`
  with console commit `2628a19` from [PR #457](https://github.com/oratis/LISA/pull/457).
  The already-deployed console routes, controls, operator configuration and
  TLS-verified website proxy were preserved during the appearance rollout.
- Cloud build: `63259c57-0e5a-41bc-bb81-a7d08590bdb4` (successful).

Both services in project `oratis-491316`, region `us-central1`, receive 100% of
production traffic on the following revisions:

| Service | Revision | Image digest |
| --- | --- | --- |
| Cloud | `lisa-cloud-ui0303console` | `sha256:8590a1a837e53e323965229056953a7f8e0c3fdaa127d20a19d4f09bb3278d26` |
| Website | `lisa-web-ui0303console` | `sha256:9fe3df8b34b2a4578842d69cd1b58262bc2c764e7f2b9c11593433e48358c7fa` |

The immediately previous revisions, `lisa-cloud-console-1107` and
`lisa-web-console-1107b`, remain available for rollback. They preserve the console
but predate the appearance update. Service configuration and secrets were retained.

## Verification

- Integrated application: 4,059 tests passed, one existing test skipped; typecheck
  and production build passed.
- Browser regressions: 35 tests passed across shell, theme persistence/system
  preference, layout/mobile, initial key gate, session/composer and Cloud startup.
- Website: all 14 routes built. English/Chinese appearance controls and the public
  light-mode homepage were inspected in a browser. The console login remained
  reachable through the public website.
- Cloud preview and production: health and authentication configuration passed;
  the browser sign-in page contains the shared appearance styles. Console assets
  load and unauthenticated console APIs return 401 with private/no-store headers.
  The public Cloud sign-in page was checked in a browser. Automated origin checks
  use Cloud Run URLs because the public edge can reject non-browser clients.
- No ERROR-level logs were returned for the two final revisions during the
  post-deployment check. No paid model request, email or account mutation was
  needed for these production checks.
- Mac: 37 native tests passed. An isolated running app was checked for light/dark
  appearance, settings persistence, message entry/reply and failure feedback.
- iOS: 104 simulator tests passed; one opt-in remote-Mac live test skipped.
  Native-rendered light/dark and accessibility-size views were visually inspected.
  No physical iPhone was attached, so physical-device network handoff remains
  unverified.

## Client delivery

The [Mac 0.30.3 release](https://github.com/oratis/LISA/releases/tag/v0.30.3)
completed signing and Apple notarization in workflow `42383504183`. The downloaded
DMG checksum, stapled tickets, app signature and Gatekeeper assessment passed.
The embedded app reports version 0.30.3 and contains both x86_64 and arm64 code.

`Lisa-Suite-v0.30.3.dmg` SHA-256:

```text
21149629557a75535bc5b649c5333f30aa3c1f74f1a1859eb37fcfab691778b4
```

Lisa Pocket 1.3 (1794062401) completed archive, export, upload and Apple processing
in workflow `42382439600`. App Store Connect shows the build in the existing
internal TestFlight group. This is an internal TestFlight update; the public
App Store version was not changed by this task.
