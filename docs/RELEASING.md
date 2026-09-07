# Releasing Lisa

How to cut a new release that ships:

- The npm package (`@oratis/lisa`)
- Source + self-contained CLI bundles (Mac / Linux) via GitHub Releases
- **Lisa.app DMG** via GitHub Releases (this doc's focus — the Lisa Island
  pill is built into Lisa.app, there's no separate LisaIsland.app anymore)
- The **Homebrew tap** formula (`oratis/homebrew-tap`)

| Workflow / step | Trigger | Produces |
|---|---|---|
| `release.yml` | tag `v*.*.*` | source tarball, mac/linux CLI bundles |
| `release-mac-apps.yml` | tag `v*.*.*` | `Lisa-Suite-vX.Y.Z.dmg` (Lisa.app) |
| `npm publish` | manual (local) | npm package |
| `release-homebrew.yml` | manual (`workflow_dispatch`) | bumped `oratis/homebrew-tap` formula |

The two tag-triggered workflows attach to the same `vX.Y.Z` GitHub Release. The
npm publish and Homebrew bump are manual and run *after* the tag (the tap formula
hashes the published npm tarball, so npm must go first).

---

## Cutting a release

1. **Bump version**

   ```bash
   npm version patch     # 0.2.0 → 0.2.1
   # or: npm version minor / major
   ```

   `npm version` updates `package.json`, makes a commit, and creates the tag.

2. **Write release notes**

   If `docs/RELEASE_v0.2.1.md` exists, the workflow uses it as the release
   body. Otherwise the release uses auto-generated commit notes. It is also the
   only source for that version's `CHANGELOG.md` entry (next step), so skipping
   it leaves a hole in the changelog.

3. **Regenerate the changelog**

   ```bash
   npm run changelog     # rewrites CHANGELOG.md from docs/RELEASE_v*.md
   git add CHANGELOG.md && git commit -m "docs: changelog for vX.Y.Z"
   ```

   `CHANGELOG.md` is generated, not written: `scripts/gen-changelog.mjs` reads
   every `docs/RELEASE_v*.md` and emits one Keep-a-Changelog entry per release —
   the note's headline paragraph, its `##` section titles as bullets, and links
   to the note and the GitHub release. That is the whole reason to write a good
   headline paragraph and good section titles: they *are* the changelog entry.

   The date comes from the `vX.Y.Z` tag when it exists, so run this **after**
   `npm version` created the tag and the entry gets the real release date; run it
   before tagging and the entry falls back to the release note's commit date and
   will need regenerating. `npm run changelog -- --check` fails when the file is
   stale. Both need full history and tags, which a shallow CI clone does not
   have — that is why this is a release step and not a CI gate.

   Releases at 0.12.0 and below predate the release-note convention and are
   hand-written. They live below the `gen-changelog:handwritten` marker comment
   and are copied through untouched; never edit above the marker.

4. **Push**

   ```bash
   git push --follow-tags
   ```

5. **Watch the workflows**

   Both `Release` (Ubuntu, ~5 min) and `Release — Mac apps` (macOS, ~15 min)
   trigger off the tag. The latter takes longer when signing + notarizing
   are enabled — Apple's notary service can sit on a submission for
   2–10 minutes.

6. **Publish to npm** (manual)

   ```bash
   npm publish --access public
   ```

   `--access public` is required: the package is scoped (`@oratis/lisa`), and
   scoped packages default to *restricted* — without the flag npm 404s on the
   `PUT`. `prepublishOnly` runs typecheck + test + build first.

7. **Bump the Homebrew tap** (manual — after npm publish lands on the registry)

   ```bash
   gh workflow run "Release — Homebrew tap"
   ```

   Pins `Formula/lisa.rb` in `oratis/homebrew-tap` to the freshly-published npm
   tarball + its sha256. Needs the one-time `HOMEBREW_TAP_TOKEN` secret (and has a
   manual fallback) — see [PUBLISH.md §2](PUBLISH.md). It must run *after* `npm
   publish` because it hashes the real published tarball.

---

## Signing + notarization (optional but recommended)

Without signing, `Lisa-Suite.dmg` is ad-hoc signed: the app works locally,
but downloaded copies are quarantined by Gatekeeper. Users need to either
right-click → Open the first time, or run:

```bash
xattr -d com.apple.quarantine /Applications/Lisa.app
```

To make the download "just work" — no warnings, no quarantine clearing —
provision six GitHub repository secrets:

| Secret | Where it comes from |
|---|---|
| `APPLE_CERTIFICATE_BASE64` | `base64 -i DeveloperID.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the passphrase you set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` (literal, must match the cert) |
| `APPLE_ID` | your Apple developer account email |
| `APPLE_PASSWORD` | an **app-specific** password from <https://appleid.apple.com> |
| `APPLE_TEAM_ID` | 10-char team id from <https://developer.apple.com/account> |

Settings → Secrets and variables → Actions → New repository secret, one
per row. Once `APPLE_TEAM_ID` is set, the workflow flips on the signed
path automatically; until then it falls through to ad-hoc.

### Exporting the .p12

In Keychain Access:

1. Find your "Developer ID Application: ..." certificate.
2. Right-click → Export → Personal Information Exchange (.p12).
3. Set a passphrase (this becomes `APPLE_CERTIFICATE_PASSWORD`).
4. `base64 -i <exported>.p12 | pbcopy` and paste into
   `APPLE_CERTIFICATE_BASE64`.

### App-specific password

Apple no longer accepts your normal account password for `notarytool`.
Go to <https://appleid.apple.com> → Sign-In and Security → App-Specific
Passwords → generate one labeled "lisa-notarytool".

---

## What the DMG looks like

`Lisa-Suite-vX.Y.Z.dmg` opens to a window with two things:

- `Lisa.app` — drag to /Applications (the Lisa Island pill is built in:
  Settings… → Show Lisa Island)
- `Applications` — drop target

Plus a `README.txt` with the prerequisite (running `lisa serve --web`
locally, either via `npm install -g @oratis/lisa` or the standalone
bundle from the same release).

---

## Trying it locally before tagging

```bash
# Build the app + DMG with ad-hoc signing
bash scripts/build-mac-apps.sh

# Or with your local Developer ID cert in the system keychain:
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  bash scripts/build-mac-apps.sh

# Open the result to sanity-check
open dist-release/Lisa-Suite-v*.dmg
```

Local builds skip notarization — that requires the Apple ID credentials
and is workflow-only.

---

## Troubleshooting

**`xcrun stapler` fails with "Could not find or could not access metadata"**

The notarization submission probably timed out without an `Accepted`
verdict. Check the logs:

```bash
xcrun notarytool log <submission-id> \
  --apple-id $APPLE_ID --password $APPLE_PASSWORD --team-id $APPLE_TEAM_ID
```

Common culprits: missing `--options runtime` flag (we use it), missing
entitlements file (we have them at `packaging/*/Resources/Entitlements.plist`),
or a stale `--timestamp`.

**`Developer ID Application` certificate doesn't appear in `security find-identity`**

The `.p12` export probably didn't include the private key. Re-export
from Keychain Access making sure to select both the certificate AND its
private key before right-clicking → Export.

**The downloaded DMG is bigger than the local one**

The signing process embeds a timestamp + the certificate chain, adding
~10-50 KB. Notarization adds the staple (~1-2 KB). All expected.
