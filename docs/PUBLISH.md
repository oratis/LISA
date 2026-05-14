# Publishing Lisa

How to push a new release. The **GitHub Release** flow is automated —
you just push a tag and the workflow builds three artifacts and posts
them. The **npm + Homebrew** flow is still manual (intentionally — they
need account credentials I shouldn't ever see).

## Quick reference

```sh
# 1. Bump version in package.json + create the tag.
npm version patch    # or: minor / major / 0.3.0

# 2. (Optional) Write release notes:
#    docs/RELEASE_v0.X.Y.md  (otherwise auto-generated from commits)

# 3. Push the tag → triggers the GitHub Release workflow.
git push --follow-tags
# → the release.yml workflow builds + uploads:
#     lisa-source-v0.X.Y.tar.gz
#     lisa-mac-bundle-v0.X.Y.zip
#     lisa-linux-bundle-v0.X.Y.tar.gz
#     SHA256SUMS.txt

# 4. Then publish to npm:
npm publish --access public

# 5. Then update the Homebrew tap formula (separate repo).
```

Total: ~10 minutes per release.

## 0. GitHub Release artifacts (automated)

Triggered by `git push --follow-tags` after `npm version`. The
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

User caveat for the Mac/Linux bundles: they still need **Node.js 20+**
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

### Per-release

```sh
# 1. Bump the version in package.json (semver: bug fix → patch, new feature → minor, breaking → major).
npm version patch              # or minor / major / 0.3.0
git push --follow-tags

# 2. Verify the tarball before publishing.
npm pack --dry-run | tail -10  # confirm size + file count look sane

# 3. Publish (this fires `prepublishOnly` first, which:
#    - runs `npm run build`
#    - replaces dist/web/assets symlink with a real copy of src/web/assets
#    so the tarball has the 114 mood portraits inlined).
npm publish --access public

# 4. After publish, npm fires `postpublish` which restores the dev symlink.
#    If for some reason it didn't, just run:
npm run copy-assets
```

### What the tarball contains

`files` field in `package.json` whitelists:

- `dist/` (compiled JS + d.ts + sourcemaps + bundled web assets)
- `channels.example.json`
- `completions/` (bash/zsh/fish)
- `LICENSE`, `README.md`, `README.zh-CN.md`

Excluded by default (and double-excluded via `.npmignore`):

- `src/`, `scripts/`, `docs/`, `website/`, `reference/`
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

Create a separate GitHub repo: `https://github.com/oratis/homebrew-tap`. The repo only needs a single file: `Formula/lisa.rb` (a copy of [`packaging/homebrew/lisa.rb`](../packaging/homebrew/lisa.rb) from this repo).

### Per-release

The formula points at the **npm tarball** (not the GitHub source archive), because
the npm tarball ships pre-built `dist/` — that avoids needing TypeScript at brew
install time. So step 1 of the release ritual is `npm publish` (§1 above), and
step 2 pins the formula to the freshly-published npm tarball.

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

## 3. Cloudflare Pages — `meetlisa.ai`

Status: `meetlisa.ai` purchased. Cloudflare Pages setup pending —
secrets not yet wired, so the deploy step in [.github/workflows/website-deploy.yml](../.github/workflows/website-deploy.yml)
is still skipped on push. The workflow builds the Astro site on every
push to `main` (under `website/` paths) regardless, so the build is
known-good before flipping the deploy switch.

### One-time setup (now that the domain is registered)

1. **Domain.** ✅ Already purchased: `meetlisa.ai` (Cloudflare Registrar / Namecheap / Porkbun all work).

2. **Create the Cloudflare Pages project.**
   - Sign in to Cloudflare → Workers & Pages → Create → Pages → Connect to Git.
   - Connect this repo (`oratis/LISA`).
   - **Project name**: `lisa-website` (must match the workflow).
   - **Production branch**: `main`.
   - Build settings: leave empty — the GH Actions workflow handles building. (Cloudflare's own builder will be skipped because the workflow uses `pages deploy` directly.)

3. **Generate API credentials.**
   - Cloudflare → My Profile → API Tokens → Create Token → "Custom token":
     - Permissions: `Account → Cloudflare Pages → Edit`
     - Account Resources: `<your account>`
     - TTL: leave default
   - Copy the token.
   - Find your Account ID on the Cloudflare dashboard right sidebar.

4. **Add repo secrets.** GitHub → repo Settings → Secrets and variables → Actions → New repository secret:
   - `CF_API_TOKEN` = the token from step 3
   - `CF_ACCOUNT_ID` = the account ID from step 3

5. **Push to trigger the deploy.**

   ```sh
   git commit --allow-empty -m "trigger website deploy"
   git push origin main
   ```

   Watch GitHub Actions → "Website — build + deploy" → both jobs should complete green. The deploy job posts the live URL.

6. **Custom domain.** Cloudflare Pages project → Custom domains → Set up a custom domain → enter `meetlisa.ai`. Cloudflare auto-creates the CNAME / TLS cert.

### Updates

After step 5, every push to `main` that touches `website/`, `src/web/assets/`, `scripts/lisa-moods.ts`, or the workflow itself triggers a re-deploy.

### Local-only mode (current default)

While the secrets are unset, the deploy job is skipped — the workflow only builds + uploads an artifact (handy for visually verifying changes before going public). To test the site without going public:

```sh
cd website
npm install
npm run dev    # http://localhost:4321
```

---

## 4. Coordination

When you publish a new version, do them roughly together:

1. `git tag v0.X.Y && git push --tags`
2. GitHub Release (auto-generated changelog from commits is fine)
3. `npm publish --access public`
4. Update Homebrew formula in tap repo (~5min after npm publish so users can use either)
5. Bump website's "current version" badge (if you add one) and re-deploy

Total time per release: ~10 minutes once the credentials are wired.
