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

**Reused from Telloria** (same Apple Developer account, **wangharp@gmail.com**):
the Apple **team `9LH9NBX7P4`** and the **App Store Connect API key** are
account-level, so the very key that uploads Telloria uploads Lisa Pocket too —
no new credentials. The **privacy manifest** ([`Sources/PrivacyInfo.xcprivacy`](Sources/PrivacyInfo.xcprivacy))
mirrors Telloria's required-reason API set (UserDefaults / file-timestamp /
boot-time / disk-space). It differs only on data collection: Telloria declares
email / user-id / purchase / analytics because it collects them; Lisa Pocket is
a thin client to **your own** backend and collects nothing to a Lisa server, so
its collected-data + tracking are empty. **iOS only** — there is no Android
target (Lisa Pocket is native SwiftUI, not the Expo app Telloria ships to both
stores).

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

## From TestFlight to App Store (public release)

TestFlight (above) gets the build to Apple. Going **public on the App Store**
adds these App Store Connect console steps (account actions — only you):

1. **App Privacy** (App → App Privacy) — answer **"Data Not Collected"** to match
   the privacy manifest (Lisa Pocket is a thin client to your own backend; nothing
   reaches a Lisa-operated server). No tracking.
2. **Reviewability — the make-or-break item.** A reviewer has no Mac running
   `lisa serve`, so a pairing-only build looks non-functional (Guideline 2.1).
   Ship the **LISA Cloud M0 demo** (see [docs/PLAN_CLOUD_v1.0.md](../../docs/PLAN_CLOUD_v1.0.md)):
   a hosted instance + a seeded **demo account**, and put its credentials in
   App Review → **App Review Information → Sign-in required → demo user/pass**,
   with a note explaining the Mac-pairing vs cloud modes.
3. **Encryption / export compliance** — answered by `ITSAppUsesNonExemptEncryption=false`
   in `project.yml` (standard HTTPS only), so no per-build prompt.
4. **Metadata** — name "Lisa Pocket", subtitle, description, keywords, **support URL**
   + **privacy-policy URL** (required; host on meetlisa.ai), category, **age rating**,
   and **screenshots** (6.7"/6.5" iPhone at minimum; iPad if `supportsTablet`).
5. **Submit for Review** (the build from TestFlight → "Add Build" on the app version).

## Honest limits

- The actual upload authenticates to **your** Apple account, so it can't run
  without the API key + the app record above — those are account actions.
- TestFlight builds use the **production** APNs environment; `testflight.sh`
  flips the generated `aps-environment` entitlement to `production` for the
  archive (project.yml stays `development` for normal dev builds).
- Live push behavior is still only verifiable on a real device with `LISA_APNS_*`
  configured; everything up to the upload is scripted here.
