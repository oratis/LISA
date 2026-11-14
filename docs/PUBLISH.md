# Publishing Lisa

Tag pushes publish the GitHub release and npm package automatically. The
separate Mac workflow signs and notarizes `Lisa.app` and its DMG. Homebrew is
updated by dispatching its workflow after npm publication succeeds.

## Quick reference

```sh
# On a release branch, before review; do not create the tag yet.
npm version patch --no-git-tag-version
# Write docs/RELEASE_vX.Y.Z.md, commit, open a PR, and merge after CI passes.

# Tag the reviewed merge commit, then push that tag explicitly.
git tag -a vX.Y.Z <merge-commit> -m "Lisa vX.Y.Z"
git push origin vX.Y.Z

# Wait for release.yml (artifacts + npm) and release-mac-apps.yml (notarized DMG).
npm view @oratis/lisa version
# Only after npm serves the new version:
gh workflow run release-homebrew.yml --repo oratis/LISA -f version=X.Y.Z
```

`workflow_dispatch` on `release.yml` rebuilds artifacts but does **not** publish
to npm. The manual npm procedure below is a recovery path, not a second step
for a successful tag release. Never rebuild or move a published version tag.

## 0. GitHub Release artifacts (automated)

Triggered by pushing the explicit version tag on the reviewed merge commit. The
[release.yml](../.github/workflows/release.yml) workflow does the work:

1. Validates that `package.json` version matches the tag.
2. Runs [scripts/build-release.sh](../scripts/build-release.sh) to produce three artifacts in `dist-release/`:
   - **`lisa-source-vX.Y.Z.tar.gz`** — the npm-style tarball (~28 MB).
     Same content as `npm publish` ships. For users who want clean source.
   - **`lisa-mac-bundle-vX.Y.Z.zip`** — self-contained "drop-and-go" bundle (~80 MB):
     - `bin/lisa` (CLI shim)
     - `bin/lisa-gui.command` (Mac users double-click → opens browser to web UI)
     - `dist/` (compiled JS + 114 mood portraits)
     - `node_modules/` (runtime deps, no devDependencies)
     - `QUICKSTART.txt` + README
   - **`lisa-linux-bundle-vX.Y.Z.tar.gz`** — same as Mac minus the .command launcher.
3. Computes SHA-256 checksums (`SHA256SUMS.txt`).
4. If `docs/RELEASE_v<version>.md` exists, uses it as release body; otherwise GitHub auto-generates from commit messages.
5. Posts the GitHub Release.

User caveat for the Mac/Linux bundles: they still need **Node.js 22.19+**
on PATH. The bundles include all npm deps but not Node itself.
Bundling Node would mean a 130-150 MB tarball *per platform* and
fighting the `sharp` native dep across architectures — trade-off
deferred.

To trigger manually (e.g. re-build a release):

```sh
gh workflow run release.yml -f tag=v0.2.0
```

To run the build locally without pushing:

```sh
./scripts/build-release.sh
ls dist-release/
```

---

## 1. npm — `@oratis/lisa`

### Prerequisites (one-time)

```sh
# Login to npm with your account.
npm whoami        # check who you are
npm login         # if needed
```

The package name is **scoped** (`@oratis/lisa`), so npm won't conflict with the global `lisa` namespace. It also implies the package is publicly published under your scope.

### Normal releases and manual recovery

For normal releases, use the reviewed-merge/tag sequence in the quick reference. The tag workflow publishes npm; there is no second local publish step.

Manual recovery is only for a failed npm-publish job after confirming no other publisher is running and the version is absent from the registry. Work from the exact reviewed tag with its matching package version; do not bump again or move the tag:

```sh
npm ci
npm pack --dry-run | tail -10
# Confirm the registry does not already contain this exact version before continuing.
npm view @oratis/lisa@X.Y.Z version
# Only when that exact version is absent and authenticated npm access is available:
npm publish --access public
```

`prepublishOnly` checks the API contract, types and tests, builds the package and materializes the web assets. `postpublish` restores the development asset symlink. If interrupted after publication, `npm run copy-assets` restores it manually; do not republish an existing version.

### What the tarball contains

`files` field in `package.json` whitelists:

- `dist/` (compiled JS + d.ts + sourcemaps + bundled web assets)
- `contracts/`, `packaging/eventkit/` and `scripts/fix-node-pty-perms.mjs`
- `channels.example.json`
- `completions/` (bash/zsh/fish)
- `LICENSE`, `README.md`, `README.zh-CN.md`

Excluded by default (and double-excluded via `.npmignore`):

- `src/`, other `scripts/`, `docs/`, `website/`, `reference/`
- `node_modules/`, `.git/`, dotfiles, env files

Tarball size: ~30 MB (the bulk is the 114 pixel-art mood portraits;
they're what make Lisa visually distinctive, so we bundle them).

### Install path for users

```sh
npm i -g @oratis/lisa
lisa --help

# Or one-shot:
npx @oratis/lisa "say hi"
```

---

## 2. Homebrew — `oratis/homebrew-tap` (when ready)

### Prerequisites (one-time)

1. Create a separate GitHub repo `https://github.com/oratis/homebrew-tap` with a
   single file `Formula/lisa.rb` (a copy of
   [`packaging/homebrew/lisa.rb`](../packaging/homebrew/lisa.rb) from this repo).
2. **For the automated bump (recommended):** add a repo secret
   `HOMEBREW_TAP_TOKEN` to **this** repo — a token with *write* access to the tap
   repo (the per-repo `GITHUB_TOKEN` can't push to a different repo):
   - Fine-grained PAT: **Only select repositories → `oratis/homebrew-tap`**,
     Repository permissions → **Contents: Read and write**; or a classic token
     with `repo` scope.
   - Settings → Secrets and variables → Actions → New repository secret →
     `HOMEBREW_TAP_TOKEN`.

### Per-release (automated)

The formula points at the **npm tarball** (not the GitHub source archive), because
the npm tarball ships pre-built `dist/` — that avoids needing TypeScript at brew
install time. So the tap bump must come **after `npm publish`** (§1 above): it
pins the `sha256` of the *freshly-published* npm tarball, which must already exist
on the registry (a hash computed any other way risks not matching the registry
bytes and breaking `brew install`).

Once `HOMEBREW_TAP_TOKEN` is set, just run the workflow after `npm publish`:

```sh
# After `npm publish` has landed @oratis/lisa@<version> on the registry:
gh workflow run "Release — Homebrew tap"            # uses the latest v* tag
# or pin explicitly:
gh workflow run "Release — Homebrew tap" -f version=0.11.0
```

[`.github/workflows/release-homebrew.yml`](../.github/workflows/release-homebrew.yml)
fetches the published tarball, computes its sha256, and pushes
`Formula/lisa.rb` (`lisa <version>`) to the tap repo. (Also keep the in-repo
template [`packaging/homebrew/lisa.rb`](../packaging/homebrew/lisa.rb) in sync when
convenient — it's the reference copy, not what users install.)

### Per-release (manual fallback)

If the token isn't set up, do it by hand:

```sh
# 0. Make sure npm publish (§1 above) has run — the npm tarball must exist.

# 1. Compute the sha256 of the npm tarball.
VERSION=$(node -p 'require("./package.json").version')
NPM_TARBALL="https://registry.npmjs.org/@oratis/lisa/-/lisa-${VERSION}.tgz"
SHA=$(curl -sL "$NPM_TARBALL" | shasum -a 256 | cut -d' ' -f1)
echo "version=$VERSION"
echo "sha256=$SHA"

# 2. Edit packaging/homebrew/lisa.rb in this repo:
#      url    "https://registry.npmjs.org/@oratis/lisa/-/lisa-${VERSION}.tgz"
#      sha256 "${SHA}"
#    Then copy the same file to the homebrew-tap repo at Formula/lisa.rb.

# 3. Commit + push the tap repo.
cd ../homebrew-tap
git add Formula/lisa.rb
git commit -m "lisa ${VERSION}"
git push
```

**No-clone alternative** (used for v0.14.0 — edits `Formula/lisa.rb` straight over the
GitHub API, so you don't need a local checkout of `homebrew-tap`; `gh` must be authed
with write access to the tap repo). Do this only *after* `npm publish` lands the tarball:

```sh
VERSION=$(node -p 'require("./package.json").version')
SHA=$(curl -sL "https://registry.npmjs.org/@oratis/lisa/-/lisa-${VERSION}.tgz" | shasum -a 256 | cut -d' ' -f1)
BLOB=$(gh api repos/oratis/homebrew-tap/contents/Formula/lisa.rb --jq .sha)
NEW=$(gh api repos/oratis/homebrew-tap/contents/Formula/lisa.rb --jq .content | base64 -d \
  | sed -E "s#lisa-[0-9][0-9.]*\.tgz#lisa-${VERSION}.tgz#g; s#sha256 \"[a-f0-9]{64}\"#sha256 \"${SHA}\"#" | base64)
gh api -X PUT repos/oratis/homebrew-tap/contents/Formula/lisa.rb \
  -f message="lisa ${VERSION}" -f content="$NEW" -f sha="$BLOB"
# Verify the pinned hash matches the live tarball before trusting it:
gh api repos/oratis/homebrew-tap/contents/Formula/lisa.rb --jq .content | base64 -d | grep -E 'url "|sha256 "'
```

Users running `brew update` (next time their auto-update fires) will see the new version.

### Install path for users

```sh
brew tap oratis/tap
brew install lisa
lisa --help

# Updates:
brew update && brew upgrade lisa
```

The formula installs Node as a dep and links the `lisa` bin into Homebrew's prefix. Shell completions also auto-install if the user's shell is set up.

---

## 3. Website and hosted services

Production `meetlisa.ai` is served by Cloud Run service `lisa-web` in project `oratis-491316`, region `us-central1`. The Astro build fetches GitHub releases at build time, so publish the GitHub release before rebuilding the website:

```sh
PROJECT=oratis-491316 website/deploy/deploy.sh --canary
# Check the returned canary URL, including /, /zh-CN/ and /changelog/.
# Promote only the verified revision; preserve any unrelated traffic tags.
```

[`website/deploy/deploy.sh`](../website/deploy/deploy.sh) builds locally, then uploads the static site and its nginx configuration. A normal invocation promotes the new revision immediately; `--canary` leaves traffic on the current revision. Record the candidate and previous revision before promotion so rollback is concrete.

The optional [.github/workflows/website-deploy.yml](../.github/workflows/website-deploy.yml) builds/uploads artifacts and can deploy to Cloudflare Pages if `CF_API_TOKEN` and `CF_ACCOUNT_ID` are configured. These secrets were absent at the November 14 audit. A green build in that workflow does not mean the production website changed.

The account/AI backend is Cloud Run service `lisa-cloud` in the same project/region. For an existing production service, build the reviewed commit with [deploy/Dockerfile](../deploy/Dockerfile), deploy the image as a no-traffic revision **without replacing existing environment variables, secrets, volumes, account storage or scaling**, smoke-test it, then promote that specific revision. The older `deploy/deploy.sh` is a provisioning script with demo defaults; do not blindly rerun it over production.

The Mac relay is the separate `lisa-relay` Cloudflare Worker at `cloud.meetlisa.ai/api/relay/*`, not the website and not Cloud Run's fallback relay. Run its checks/tests before deploying and verify account authorization plus an encrypted client round trip afterward. See [REMOTE_CONNECTIONS.md](REMOTE_CONNECTIONS.md#deployment) for deployment and the production URLSession fixture.


## 4. Coordination

Use the reviewed-merge/tag sequence at the top of this document. Track each channel independently:

1. GitHub artifacts, npm and the notarized Mac DMG from the version tag.
2. Homebrew after the npm tarball is available.
3. Backend and relay revisions after their smoke tests; retain rollback targets.
4. Website rebuild/deploy after the GitHub release exists.
5. Pocket TestFlight and, when its acceptance gates pass, App Store submission through the [native runbook](../packaging/ios-companion/RELEASE.md).

A merged PR, successful upload or TestFlight build is not proof that every channel is public. Record pending physical-device checks and Apple review explicitly.
