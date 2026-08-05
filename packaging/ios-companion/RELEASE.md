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

> **Status: configured & live** (2026-07-23). All six secrets below are populated
> on `oratis/LISA`, so any collaborator with push access can ship a TestFlight
> build from CI alone — no Mac, no local certificates.

### Releasing (for collaborators)

Either of:

```sh
# 1. Tag-triggered (preferred — leaves a versioned marker)
git tag pocket-v1.2.0 && git push origin pocket-v1.2.0
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
   Copy-ready text is drafted in [`APPSTORE_METADATA.md`](APPSTORE_METADATA.md).
5. **Submit for Review** (the build from TestFlight → "Add Build" on the app version).

## Sign in with Apple (LISA Cloud) — optional

The cloud onboarding path offers **Sign in with Apple** in addition to pasting a
`?token=` URL. It's **off by default** and single-tenant — on success the server
hands back the shared `LISA_WEB_TOKEN`, matching the M0/C2 demo (one shared soul;
per-user isolation is deferred C3 work). Enable it on the cloud instance with:

| Env | Meaning |
| --- | --- |
| `LISA_CLOUD_APPLE_SIGNIN` | `1`/`true` to turn the `POST /api/auth/apple` endpoint on (else 404). |
| `LISA_CLOUD_APPLE_AUD` | Expected token audience; defaults to the app bundle id `ai.meetlisa.main`. |
| `LISA_CLOUD_APPLE_SUBS` | Optional comma-separated allowlist of Apple `sub`s. Empty ⇒ any verified Apple ID may sign in (fine for a rate-limited demo); set it to restrict access. |

The endpoint verifies the Apple identity token (issuer / audience / expiry /
signature against `appleid.apple.com/auth/keys`) before returning the token — see
`src/web/cloudAuth.ts`. The iOS app needs the **Sign in with Apple** capability
(declared in `project.yml`; enable it on the App ID in the Developer portal before
a signed build). For App Review you can leave it off and keep the token-paste demo
flow in the review notes above, or enable it and allowlist the reviewer.

## Honest limits

- The actual upload authenticates to **your** Apple account, so it can't run
  without the API key + the app record above — those are account actions.
- TestFlight builds use the **production** APNs environment; `testflight.sh`
  flips the generated `aps-environment` entitlement to `production` for the
  archive (project.yml stays `development` for normal dev builds).
- Live push behavior is still only verifiable on a real device with `LISA_APNS_*`
  configured; everything up to the upload is scripted here.

## App Review notes (paste into ASC → App Review Information)

Set **Sign-in required: YES**. The ASC form insists on a user/pass pair, but
this build signs in by pasting ONE full URL — so fill the fields in a way that
can't mislead the reviewer, and put the real instructions in the notes:

- **User name**: `see-review-notes` (a literal hint, not a credential)
- **Password**: `<DEMO_TOKEN>` (the raw token, as a fallback reference)

Fill the two placeholders from the live Cloud Run service
(`gcloud run services describe lisa-cloud …`) — keep the real token OUT of this
repo. **Before every submission**: `curl -s -o /dev/null -w '%{http_code}' \
"<DEMO_URL>/?token=<DEMO_TOKEN>"` must print `200` — a `401` here is exactly the
"unable to sign in when we entered the code" rejection (Guideline 2.1,
2026-07-13). The 401 body is now structured JSON (`token_mismatch` /
`token_missing`) if you need to diagnose.

```
Lisa Pocket is a companion client for "Lisa", a personal AI. It connects to
EITHER (a) the user's own Mac running the open-source Lisa server (local +
private — the default), OR (b) a hosted LISA Cloud instance.

IMPORTANT — sign-in model: this build has NO username/password form. Access
is granted by pasting one full URL that embeds the access token. The
username/password fields above are placeholders; please follow these steps:

  1. Open the app → Settings tab.
  2. At the top, set "Connect to" → "LISA Cloud".
  3. Paste this ENTIRE line (one line, nothing trimmed) into the URL field:
       <DEMO_URL>/?token=<DEMO_TOKEN>
  4. Tap "Connect". The app performs a live check and shows
     "Connected to LISA Cloud." If you instead see a message about a
     rejected token (401), the paste was truncated — please re-copy the
     whole line including everything after "?token=".
  5. Open the Chat tab and talk to Lisa. (First reply may take a few
     seconds; responses stream in.)

Lisa collects no personal data; the cloud demo is a shared, rate-limited
instance provided for review.
```

## Pre-submission checklist (App Store, public)

- [ ] ASC app record created (`ai.meetlisa.main`) + App Store Connect API key
- [ ] LISA Cloud demo live + token filled into the review notes above
- [ ] App Privacy → **Data Not Collected** (matches `PrivacyInfo.xcprivacy`)
- [ ] Export compliance → covered by `ITSAppUsesNonExemptEncryption=false`
- [ ] **Privacy-policy URL** (required) hosted on meetlisa.ai
- [ ] Support URL
- [ ] Screenshots — 6.7" + 6.5" iPhone (iPad if `supportsTablet`)
- [x] Metadata — name/subtitle/description/keywords/category/age rating (drafted in [`APPSTORE_METADATA.md`](APPSTORE_METADATA.md))
- [ ] `testflight.sh` upload succeeded → build shows in TestFlight
- [ ] Build attached to the version → **Submit for Review**
