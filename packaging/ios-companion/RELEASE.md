# Shipping Lisa Pocket to TestFlight

Lisa Pocket is a **native SwiftUI** app (XcodeGen), so it can't use Markup's
`eas build`/`eas submit` (that's Expo). The equivalent here is `xcodebuild
archive` + `-exportArchive (destination: upload)` driven by an **App Store
Connect API key**, which handles automatic provisioning *and* the TestFlight
upload. [`testflight.sh`](testflight.sh) runs it locally; the
[`release-ios-testflight.yml`](../../.github/workflows/release-ios-testflight.yml)
workflow runs the same thing in CI — modeled on the secret-gated pattern of
`release-mac-apps.yml` (itself lifted from Markup).

App identity: bundle id **`ai.meetlisa.main`** (+ the widget extension
`ai.meetlisa.main.widgets`), team **`9LH9NBX7P4`**.

The App Store record is **6784690058**. The existing team and App Store Connect API key are reused by CI. The app is native SwiftUI and iOS-only.

The [privacy manifest](Sources/PrivacyInfo.xcprivacy) declares account-linked email, user ID, purchases, chat/content, usage and diagnostics for Cloud functionality; content also supports personalized memory. No advertising or tracking is declared. **Do not select “Data Not Collected”** in App Store Connect. Use the current [metadata and privacy checklist](APPSTORE_METADATA.md#submission-gates); a binary manifest does not update the store disclosure automatically.

## One-time setup (requires the appropriate Apple account role)

1. **Register the app in App Store Connect.** App Store Connect → Apps → ➕ →
   New App → iOS, bundle id `ai.meetlisa.main`, pick an SKU. (If the bundle
   id isn't in the list, register it first under Certificates, IDs & Profiles →
   Identifiers, with **App Groups** + **Push Notifications** capabilities; also
   create the app group `group.ai.meetlisa.main`.)
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

> **CI credentials configured** (metadata rechecked 2026-11-14). All six secrets below are populated
> on `oratis/LISA`, so any collaborator with push access can ship a TestFlight
> build from CI alone — no Mac, no local certificates.

### Releasing (for collaborators)

Either of:

```sh
# 1. Tag-triggered (preferred — leaves a versioned marker)
git tag -a pocket-v1.4.0 <reviewed-commit> -m "Lisa Pocket 1.4"
git push origin pocket-v1.4.0
```

```sh
# 2. Manual: Actions → "Release — iOS TestFlight (Lisa Pocket)" → Run workflow
gh workflow run release-ios-testflight.yml --repo oratis/LISA
```

Watch the run under **Actions**; on success the build appears in App Store
Connect → TestFlight after Apple finishes processing (a few minutes). The build
number is the Unix timestamp of the build (set automatically); the marketing
version comes from `project.yml` unless overridden.

### The secrets behind it

Repo secrets (Settings → Secrets and variables → Actions):

| Secret | What |
| --- | --- |
| `ASC_KEY_ID` | API Key ID |
| `ASC_ISSUER_ID` | API Issuer ID |
| `ASC_API_KEY_BASE64` | `base64 -i AuthKey_<id>.p8 \| pbcopy` |
| `IOS_DIST_CERT_BASE64` | an *Apple Distribution* `.p12` (cert + key), base64 |
| `IOS_DIST_CERT_PASSWORD` | the `.p12` passphrase |
| `APPLE_TEAM_ID` | `9LH9NBX7P4` (reused from the mac workflow) |

With the secrets absent the workflow is a no-op, so forks stay green. To rotate:
re-export the cert / re-download an API key and `gh secret set` the new values —
nothing sensitive lives in the repo itself.

## From TestFlight to App Store (public release)

TestFlight (above) gets the build to Apple. Going **public on the App Store**
adds these App Store Connect steps:

1. Match **App Privacy** to the current manifest, service behavior and [metadata checklist](APPSTORE_METADATA.md#submission-gates).
2. Verify a dedicated review account can sign in through **Use a password instead**, stream a Cloud reply and access the credit packs. Keep its credentials in App Review Information, never in this repository. The reviewer should not need a Mac, emailed OTP or a purchase to review Cloud chat.
3. Verify export-compliance answers against the app's current encryption use. `project.yml` contains `ITSAppUsesNonExemptEncryption=false`.
4. Update localized metadata, What's New, current iPhone/iPad screenshots, support/privacy URLs and age-rating answers. Use [APPSTORE_METADATA.md](APPSTORE_METADATA.md), not the retired shared-token demo instructions.
5. Complete the device checklist below. Attach the processed TestFlight build to the version and submit for review. Upload, processing, submission, approval and public availability are separate states.

## Account sign-in

Cloud uses per-account sessions and separate account data. Email/password, email codes and configured Apple/Google options are described in the current app and [metadata](APPSTORE_METADATA.md). The retired M0 shared-token URL is not the public app's review login. Verify enabled providers and the real review account against the deployed backend; do not copy a server master token into App Review Information.

## Honest limits

- The actual upload authenticates to **your** Apple account, so it can't run
  without the API key + the app record above — those are account actions.
- TestFlight builds use the **production** APNs environment; `testflight.sh`
  flips the generated `aps-environment` entitlement to `production` for the
  archive (project.yml stays `development` for normal dev builds).
- Live push behavior is still only verifiable on a real device with `LISA_APNS_*`
  configured; everything up to the upload is scripted here.

## App Review notes

Use the current [review notes](APPSTORE_METADATA.md#review-notes). Set **Sign-in required: YES**, supply the dedicated account's real username/password privately in ASC, and verify them before every submission. The app opens into Room; open Settings from Room to manage Cloud/My Mac, AI sharing, the account and credits. Review notes must describe the submitted binary, including any Pocket features absent from the currently public version.

## Pre-submission checklist (App Store, public)

- [ ] ASC app record created (`ai.meetlisa.main`) + App Store Connect API key
- [ ] Deployed Cloud login and streamed chat verified with the dedicated review account
- [ ] App Privacy matches `PrivacyInfo.xcprivacy`, live Cloud behavior and `APPSTORE_METADATA.md`
- [ ] Export compliance → covered by `ITSAppUsesNonExemptEncryption=false`
- [ ] **Privacy-policy URL** (required) hosted on meetlisa.ai
- [ ] Support URL
- [ ] Current iPhone/iPad screenshots accepted for the device sizes requested by ASC
- [ ] Current metadata, What’s New and age rating verified in ASC; draft source: [`APPSTORE_METADATA.md`](APPSTORE_METADATA.md)
- [ ] `testflight.sh` upload succeeded → build shows in TestFlight
- [ ] **IAP reachable** — sign in with the review account on a device and confirm
      Settings → "Add credits…" lists all three packs. Then kill the network,
      relaunch, and confirm the button is *still* there: it must not depend on
      `/api/billing/quota` (that dependency is what got 1.1 rejected under
      Guideline 2.1(b) — see [`REVIEW_RESPONSE_2.1b.md`](REVIEW_RESPONSE_2.1b.md))
- [ ] **Sandbox purchases credit the review account** — the review-facing service
      runs a build that includes `sandboxCreditAllowed()` (it allowlists the
      `LISA_REVIEWER_SEED` account automatically); on an older revision App
      Review's sandbox buy fails with `sandbox_rejected`
- [ ] **社交媒体年龄分级** questions answered in ASC → App 信息 (mandatory once you
      submit again)
- [ ] Build attached to the version → **Submit for Review**

## Device checklist before each release (connections)

CI runs the logic tests, the UI tests in `UITests/` and the Node relay tests,
but none of them can stand in for a real iPhone on real networks. Before
submitting, run these on a device against the build being shipped. Each item
traces to an issue from the 2026-11-13 end-to-end pass (#496).

- [ ] **Keyboard and navigation** (#479): on Chat, focus the field, then leave
      by the Hide keyboard button, a tap on the conversation and a swipe down.
      Before setup, Chat shows Get started and the field takes no keyboard.
- [ ] **Wi-Fi → cellular → Wi-Fi** with an account-paired Mac: Settings shows
      Local network, then Cloud relay, then Local network again, and a chat
      keeps working across each switch.
- [ ] **Mac asleep**: put the Mac to sleep. Pocket says the Mac isn't connected
      (not "can't reach", not "Stopped."). Wake it: the route comes back by
      itself within a minute, without touching the Mac (#483).
- [ ] **Firewall denial**: deny LISA incoming connections on the Mac. Pocket
      falls back to the cloud relay.
- [ ] **Session expiry**: sign in with a short-TTL test session (or wait out a
      revoked one). Pocket shows one Sign in again banner, keeps the chat draft,
      and returns to the Mac after signing in (#484).
- [ ] **Sign out of all devices**: the Mac's phone connections show
      sign-in-required, and stay enabled once the Mac signs in again (#481).
- [ ] **Service paused** (`LISA_BILLING_KILL=1` on a test instance): Chat says
      LISA Cloud is paused and offers no credit packs (#485).
- [ ] **Revoke this iPhone** on the Mac while Agents is open: the live list stops
      updating within seconds and says the Mac removed this iPhone (#480, #487).
- [ ] **Cancel pairing** on the phone after codes appear: the Mac's request
      disappears and can't be approved (#494).
- [ ] **Clock skew**: set the phone's clock 10 minutes off. Requests to the Mac
      say to fix the clock (#487).
- [ ] **Tailnet name**: pair by `mac.<tailnet>.ts.net` over Tailscale; it
      connects (#495).
- [ ] **Connection diagnostics** (Settings → About and data) lists each failure
      above, and Copy diagnostics contains no token.
