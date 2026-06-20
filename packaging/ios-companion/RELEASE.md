# Shipping Lisa Pocket to TestFlight

Lisa Pocket is a **native SwiftUI** app (XcodeGen), so it can't use Markup's
`eas build`/`eas submit` (that's Expo). The equivalent here is `xcodebuild
archive` + `-exportArchive (destination: upload)` driven by an **App Store
Connect API key**, which handles automatic provisioning *and* the TestFlight
upload. [`testflight.sh`](testflight.sh) runs it locally; the
[`release-ios-testflight.yml`](../../.github/workflows/release-ios-testflight.yml)
workflow runs the same thing in CI — modeled on the secret-gated pattern of
`release-mac-apps.yml` (itself lifted from Markup).

App identity: bundle id **`ai.meetlisa.pocket`** (+ the widget extension
`ai.meetlisa.pocket.widgets`), team **`9LH9NBX7P4`**.

## One-time setup (Apple account actions — only you can do these)

1. **Register the app in App Store Connect.** App Store Connect → Apps → ➕ →
   New App → iOS, bundle id `ai.meetlisa.pocket`, pick an SKU. (If the bundle
   id isn't in the list, register it first under Certificates, IDs & Profiles →
   Identifiers, with **App Groups** + **Push Notifications** capabilities; also
   create the app group `group.ai.meetlisa.pocket`.)
2. **Create an App Store Connect API key.** Users and Access → Integrations →
   App Store Connect API → ➕, role **App Manager**. Note the **Key ID** and
   **Issuer ID**, and download `AuthKey_<KEYID>.p8` (downloadable once).
3. **First push permission only:** APNs alerts / Live-Activity refresh stay
   inert until you also set `LISA_APNS_*` on the Mac running `lisa serve`
   (see ../../packaging/ios-companion/README.md). TestFlight itself doesn't
   need that — only live push delivery does.

## Build + upload locally (one command)

```sh
cd packaging/ios-companion
brew install xcodegen                      # one-time
ASC_KEY_ID=ABC123XYZ9 \
ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
ASC_KEY_PATH=~/Downloads/AuthKey_ABC123XYZ9.p8 \
./testflight.sh
```

The Mac already has the **Apple Distribution** cert in its keychain, so locally
you only need the API key. The build number defaults to a timestamp; override
with `BUILD_NUMBER=…` / `MARKETING_VERSION=…` if needed. On Xcode < 16 pass
`EXPORT_METHOD=app-store`.

Then: App Store Connect → your app → **TestFlight** → add yourself / a tester
group once Apple finishes processing (a few minutes).

## Build + upload from CI (tag-triggered)

Add these repo secrets (Settings → Secrets and variables → Actions):

| Secret | What |
| --- | --- |
| `ASC_KEY_ID` | API Key ID |
| `ASC_ISSUER_ID` | API Issuer ID |
| `ASC_API_KEY_BASE64` | `base64 -i AuthKey_<id>.p8 \| pbcopy` |
| `IOS_DIST_CERT_BASE64` | an *Apple Distribution* `.p12` (cert + key), base64 |
| `IOS_DIST_CERT_PASSWORD` | the `.p12` passphrase |
| `APPLE_TEAM_ID` | `9LH9NBX7P4` (reused from the mac workflow) |

Then push a tag `pocket-vX.Y.Z` (or run the workflow manually). With the secrets
absent the workflow is a no-op, so the repo stays green for others.

## Honest limits

- The actual upload authenticates to **your** Apple account, so it can't run
  without the API key + the app record above — those are account actions.
- TestFlight builds use the **production** APNs environment; `testflight.sh`
  flips the generated `aps-environment` entitlement to `production` for the
  archive (project.yml stays `development` for normal dev builds).
- Live push behavior is still only verifiable on a real device with `LISA_APNS_*`
  configured; everything up to the upload is scripted here.
